#!/usr/bin/env python3
"""Real Herdr acceptance for the setup → specification (#5), specification → basic-design (#9), basic-design → implementation (#14) and implementation → verification (#15) handoffs.

Runs ONLY in an isolated, named Herdr session (`pst`) under a synthetic HOME: its own Herdr config/socket,
its own Pi agent dir/profiles, a stateful fake `gh`, and a loopback model. It never touches the user's
Herdr sessions, tabs, Pi settings or GitHub. The synthetic HOME lives under /tmp because macOS limits
UNIX socket paths to ~104 bytes; the session is stopped and the directory removed afterwards.

  python3 scripts/test-native-handoff.py --pi-gh /path/to/pi-gh-0.5.0 --pi-profile /path/to/pi-profile
"""
import argparse, fcntl, hashlib, http.server, json, os, pty, select, shutil, signal, struct, subprocess, tempfile, termios, threading, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPTIONS = None
SESSION = 'pst'
OPERATION_ID = '33333333-3333-4333-8333-333333333333'


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix='psh-', dir='/tmp')).resolve()
        self.agent = self.home / '.pi/agent'; self.agent.mkdir(parents=True)
        self.repo = self.home / 'repo'; self.repo.mkdir()
        self.state = self.home / 'gh'; self.state.mkdir()
        self.bin = self.home / 'bin'; self.bin.mkdir()
        self.requests, self.server_proc = [], None
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), 'remote', 'add', 'origin', 'https://github.com/example/demo.git'], check=True)
        # Fake GitHub: labels + one setup Epic (#10) rendered by the real renderer.
        defs = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {labelDefinitions} from './dist/src/core/label-definitions.js';process.stdout.write(JSON.stringify(labelDefinitions()))"], cwd=ROOT, text=True))
        labels = [{'id': i + 1, 'node_id': f'LA_{i + 1}', **d} for i, d in enumerate(defs)]
        (self.state / 'labels.json').write_text(json.dumps(labels))
        self.basic = self._testMethodName == 'test_basic_design_handoff_after_parent_tui_approval'
        self.impl = self._testMethodName == 'test_implementation_handoff_after_parent_tui_approval'
        self.verify = self._testMethodName == 'test_verification_handoff_with_pinned_evidence'
        self.features = {}
        if self.verify:
            # An implementation-stage Epic; the integration commit and per-Feature evidence are real files.
            genv = dict(os.environ, GIT_AUTHOR_NAME='f', GIT_AUTHOR_EMAIL='f@example.com', GIT_COMMITTER_NAME='f', GIT_COMMITTER_EMAIL='f@example.com')
            (self.repo / 'src').mkdir(); (self.repo / 'src/app.ts').write_text('export const x = 1;\n')
            subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True, env=genv); subprocess.run(['git', '-C', str(self.repo), 'commit', '-qm', 'integration'], check=True, env=genv)
            self.integration = subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD'], text=True).strip()
            make = ("import {renderFeatureBlock} from './dist/src/core/epic-render.js';import {repoHash} from './dist/src/core/repo-context.js';"
                    "const d=JSON.parse(readFileSync('test/fixtures/epic-v1.populated.json','utf8'));d.stage='implementation';d.handoff=null;"
                    "const key=n=>'F00'+(n-10);const b={model:'owned-fixture/fixture',thinking:'medium',reason:'架空'};"
                    "const f=n=>renderFeatureBlock({version:1,kind:'feature',workflowId:d.workflowId,revision:1,createOperationId:'eeeeeeee-eeee-4eee-8eee-'+String(n).padStart(12,'0'),featureKey:key(n),parentEpic:10,stage:'implementation',purpose:'架空',editScope:['src/f'+n+'/'],outOfScope:[],designRef:{path:'docs/d.md',sha256:'a'.repeat(64),gitRef:'c'.repeat(40)},criteria:[{id:'AC10'+(n-10),requirementIds:['REQ001'],verification:'v',expectedResult:'e'}],bindings:{'coding-manager':b,coder:b,tester:b},evidenceRefs:[]});"
                    "process.stderr.write(JSON.stringify({11:f(11),12:f(12),wf:d.workflowId,hash:repoHash('example/demo')}));")
            self.revision = json.loads((ROOT / 'test/fixtures/epic-v1.populated.json').read_text())['revision']
        elif self.impl:
            # A finished basic design: design document committed in the repo, two Features, dependencies and a verified Wave plan.
            genv = dict(os.environ, GIT_AUTHOR_NAME='f', GIT_AUTHOR_EMAIL='f@example.com', GIT_COMMITTER_NAME='f', GIT_COMMITTER_EMAIL='f@example.com')
            design = '# 基本設計（架空）\n構成\n'
            (self.repo / 'docs').mkdir(); (self.repo / 'docs/design.md').write_text(design)
            subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True, env=genv); subprocess.run(['git', '-C', str(self.repo), 'commit', '-qm', 'design'], check=True, env=genv)
            commit = subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD'], text=True).strip()
            dsha = hashlib.sha256(design.encode()).hexdigest()
            make = ("import {renderFeatureBlock} from './dist/src/core/epic-render.js';import {taggedDigest} from './dist/src/core/digests.js';"
                    "const d=JSON.parse(readFileSync('test/fixtures/epic-v1.populated.json','utf8'));d.stage='basic-design';d.handoff=null;"
                    "d.questions=d.questions.map(q=>({...q,answer:q.answer??'回答（架空）',sourceRef:q.sourceRef??'hearing-1'}));"
                    "d.research=d.research.map(r=>({...r,state:'resolved',claim:null,conclusion:r.conclusion??'結論（架空）',evidenceRefs:r.evidenceRefs.length?r.evidenceRefs:['https://example.com/e']}));"
                    f"const ref={{path:'docs/design.md',sha256:'{dsha}',gitRef:'{commit}'}};d.design=ref;"
                    "const key=n=>'F00'+(n-10);"
                    "d.dependencyPlan={version:1,nodes:[11,12].map(n=>({featureKey:key(n),issue:n,contracts:[],startConditions:[],editScope:['src/f'+n+'/']})),edges:[{from:11,to:12,reason:'架空'}]};"
                    "d.wavePlan={version:1,assignments:[{issue:11,wave:1},{issue:12,wave:2}],dependencyDigest:taggedDigest('dependency-plan',d.dependencyPlan),featureSetDigest:taggedDigest('feature-set',[11,12].map(n=>({issue:n,featureKey:key(n)})))};"
                    "const b={model:'owned-fixture/fixture',thinking:'medium',reason:'架空'};"
                    "const f=n=>renderFeatureBlock({version:1,kind:'feature',workflowId:d.workflowId,revision:1,createOperationId:'eeeeeeee-eeee-4eee-8eee-'+String(n).padStart(12,'0'),featureKey:key(n),parentEpic:10,stage:'basic-design',purpose:'架空',editScope:['src/f'+n+'/'],outOfScope:[],designRef:ref,criteria:[{id:'AC10'+(n-10),requirementIds:[n===11?'REQ001':'REQ002'],verification:'v',expectedResult:'e'}],bindings:{'coding-manager':b,coder:b,tester:b},evidenceRefs:[]});"
                    "process.stderr.write(JSON.stringify({11:f(11),12:f(12)}));")
            self.revision = json.loads((ROOT / 'test/fixtures/epic-v1.populated.json').read_text())['revision']
        elif self.basic:
            # A complete specification (every REQ covered, questions answered, research resolved, [] = confirmed none).
            make = ("const d=JSON.parse(readFileSync('test/fixtures/epic-v1.populated.json','utf8'));d.stage='specification';d.design=null;d.dependencyPlan=null;d.wavePlan=null;d.handoff=null;"
                    "d.questions=d.questions.map(q=>({...q,answer:q.answer??'回答（架空）',sourceRef:q.sourceRef??'hearing-1'}));"
                    "d.research=d.research.map(r=>({...r,state:'resolved',claim:null,conclusion:r.conclusion??'結論（架空）',evidenceRefs:r.evidenceRefs.length?r.evidenceRefs:['https://example.com/e']}));"
                    "d.constraints=d.constraints??[];d.outOfScope=[];")
            self.revision = json.loads((ROOT / 'test/fixtures/epic-v1.populated.json').read_text())['revision']
        else:
            make = "const d=JSON.parse(readFileSync('test/fixtures/epic-v1.initial.json','utf8'));"
            self.revision = 1
        rendered = subprocess.run(['node', '--input-type=module', '-e', "import {renderEpicBlock} from './dist/src/core/epic-render.js';import {readFileSync} from 'node:fs';" + make + "process.stdout.write(renderEpicBlock(d))"], cwd=ROOT, text=True, capture_output=True, check=True)
        self.body = rendered.stdout
        if self.impl or self.verify: self.features = json.loads(rendered.stderr)
        epic_labels = [l for l in labels if l['name'] in ('Type: Scaffold', 'Scope: Epic') + (('Stage: Specification',) if self.basic else ('Stage: BasicDesign',) if self.impl else ('Stage: Implementation',) if self.verify else ())]
        (self.state / 'issue-10.json').write_text(json.dumps({'id': 1010, 'node_id': 'I_example10', 'number': 10, 'title': '一覧をCSVで保存できるようにする', 'body': self.body, 'state': 'open', 'labels': epic_labels, 'html_url': 'https://github.com/example/demo/issues/10'}))
        shutil.copyfile(ROOT / 'test/native/fake-gh.mjs', self.bin / 'gh'); (self.bin / 'gh').chmod(0o755)
        for name in ['node', 'git', 'herdr']:
            (self.bin / name).symlink_to(shutil.which(name))
        (self.bin / 'pi-profile').write_text(f'#!/bin/sh\nexec node {OPTIONS.pi_profile}/dist/src/cli.js "$@"\n'); (self.bin / 'pi-profile').chmod(0o755)
        # Loopback model: the sender calls the handoff tool; the receiver just acknowledges its stage prompt.
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length']))); owner.requests.append(body)
                msgs = body.get('messages', [])
                users = [m for m in msgs if m.get('role') == 'user']
                last = json.dumps(users[-1].get('content'), ensure_ascii=False) if users else ''
                tool_done = any(m.get('role') == 'tool' for m in msgs[msgs.index(users[-1]) + 1:]) if users else False
                # A subclass may answer some requests with an HTTP error instead (stage-watch acceptance).
                failure = owner.model_failure(last) if hasattr(owner, 'model_failure') else None
                if failure:
                    self.send_response(failure[0]); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(failure[1]); return
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                if 'OWNED_TOOL_REQUEST' in last and not tool_done:
                    args = {'repo': 'example/demo', 'epicIssue': 10, 'operationId': OPERATION_ID, 'expectedRevision': owner.revision, 'expectedBodySha256': hashlib.sha256(owner.body.encode()).hexdigest()}
                    if not owner.basic and not owner.impl and not owner.verify: args.update(expectedStage='setup', nextStage='specification')
                    if owner.verify: args.update(integrationRef=owner.integration, evidenceRefs=owner.evidence_refs)
                    name = 'scaffold_handoff_verification' if owner.verify else 'scaffold_handoff_implementation' if owner.impl else 'scaffold_handoff_basic_design' if owner.basic else 'scaffold_handoff_specification'
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call-{len(owner.requests)}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}; end = 'tool_calls'
                else:
                    delta = {'role': 'assistant', 'content': 'RECEIVER_ACK' if 'pi-scaffold:' in last else 'SENDER_DONE'}; end = 'stop'
                for d, finish in [(delta, None), ({}, end)]:
                    ev = {'id': 'x', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture', 'choices': [{'index': 0, 'delta': d, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(ev) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        (self.agent / 'models.json').write_text(json.dumps({'providers': {'owned-fixture': {'baseUrl': f'http://127.0.0.1:{self.server.server_port}/v1', 'api': 'openai-completions', 'apiKey': 'FAKE_LOCAL_KEY', 'models': [{'id': 'fixture', 'contextWindow': 32768, 'maxTokens': 512}]}}}))
        (self.agent / 'auth.json').write_text('{}')
        self.env = {'HOME': str(self.home), 'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
                    'PI_OFFLINE': '1', 'FAKE_GH_STATE': str(self.state), 'PI_PROFILE_PI_BIN': str(Path(OPTIONS.pi).resolve())}
        version = subprocess.check_output([OPTIONS.pi, '--no-extensions', '--version'], env=self.env, text=True).strip()
        (self.agent / 'settings.json').write_text(json.dumps({'packages': [OPTIONS.pi_profile], 'extensions': [], 'quietStartup': True, 'telemetry': False, 'theme': 'dark', 'compaction': {'enabled': False}, 'lastChangelogVersion': version}))
        dev = self.agent / 'profiles/development'; dev.mkdir(parents=True)
        (dev / 'profile.json').write_text(json.dumps({'id': 'developer', 'label': 'Development', 'description': '開発（試験用）', 'order': 30, 'enabled': True}))
        (dev / 'instructions.md').write_text('試験用の開発Profile（架空）\n')
        (dev / 'packages.json').write_text(json.dumps({'version': 1, 'packages': [str(Path(OPTIONS.pi_gh).resolve()), str(ROOT)]}))
        (self.agent / 'pi-scaffold').mkdir(mode=0o700)
        models = [{'model': 'owned-fixture/fixture', 'thinking': 'medium', 'tier': 'basic', 'roles': ['coding-manager', 'coder', 'tester']}] if self.impl else []
        pol = self.agent / 'pi-scaffold/policy.json'; pol.write_text(json.dumps({'version': 1, 'repos': {'example/demo': {'authMode': 'file-backed', 'models': models}}})); pol.chmod(0o600)
        if self.verify:
            epic = json.loads((self.state / 'issue-10.json').read_text()); epic['sub_issues'] = [11, 12]; (self.state / 'issue-10.json').write_text(json.dumps(epic))
            root = self.agent / 'pi-scaffold' / 'state' / self.features['hash'] / self.features['wf'] / 'evidence'
            self.evidence_refs = []
            for n in (11, 12):
                (self.state / f'issue-{n}.json').write_text(json.dumps({'id': 1000 + n, 'node_id': f'I_example{n}', 'number': n, 'title': f'Feature {n}', 'body': self.features[str(n)], 'state': 'open',
                    'labels': [l for l in labels if l['name'] in ('Type: Scaffold', 'Scope: Feature', 'Stage: Implementation', 'Wave: 1')], 'html_url': f'https://github.com/example/demo/issues/{n}'}))
                log = f'ok {n}\n'; logp = root / 'logs' / f'{n}.log'
                for d in (root.parents[2], root.parents[1], root.parents[0], root, root / 'logs', root / 'reports'): d.mkdir(mode=0o700, exist_ok=True); d.chmod(0o700)
                logp.write_text(log); logp.chmod(0o600)
                report = json.dumps({'version': 1, 'workflowId': self.features['wf'], 'featureIssue': n, 'productRef': self.integration, 'suiteRef': self.integration,
                                     'criteria': [{'id': f'AC10{n - 10}', 'status': 'pass', 'command': 'npm test', 'exitCode': 0, 'logPath': f'logs/{n}.log', 'logSha256': hashlib.sha256(log.encode()).hexdigest()}]})
                rp = root / 'reports' / f'{n}.json'; rp.write_text(report); rp.chmod(0o600)
                self.evidence_refs.append({'relativePath': f'reports/{n}.json', 'sha256': hashlib.sha256(report.encode()).hexdigest()})
        if self.impl:
            epic = json.loads((self.state / 'issue-10.json').read_text()); epic['sub_issues'] = [11, 12]; (self.state / 'issue-10.json').write_text(json.dumps(epic))
            for n, w in ((11, 1), (12, 2)):
                (self.state / f'issue-{n}.json').write_text(json.dumps({'id': 1000 + n, 'node_id': f'I_example{n}', 'number': n, 'title': f'Feature {n}', 'body': self.features[str(n)], 'state': 'open',
                    'labels': [l for l in labels if l['name'] in ('Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign', f'Wave: {w}')], 'html_url': f'https://github.com/example/demo/issues/{n}', **({'blocked_by': [11]} if n == 12 else {})}))
        grant = self.agent / 'pi-gh-permissions.json'
        grant.write_text(json.dumps({'version': 1, 'grants': [{'repo': 'example/demo', 'operations': ['gh_issue_edit_if_current', 'gh_issue_labels_if_current'], 'allowHeadless': True, 'allowChild': False}]})); grant.chmod(0o600)
        for cmd in (['pi-profile', 'packages', 'install', '--profile', 'developer'], ['herdr', 'integration', 'install', 'pi']):
            r = subprocess.run(cmd, env=self.env, cwd=self.repo, text=True, capture_output=True, timeout=120)
            self.assertEqual(r.returncode, 0, f'{cmd}: {r.stdout}\n{r.stderr}')

    def herdr(self, *args, check=True):
        env = dict(self.env, HERDR_SOCKET_PATH=str(self.home / f'.config/herdr/sessions/{SESSION}/herdr.sock'))
        r = subprocess.run(['herdr', *args], env=env, text=True, capture_output=True, timeout=20)
        if check: self.assertEqual(r.returncode, 0, f'herdr {args}: {r.stdout}{r.stderr}')
        return json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout

    def start_session(self):
        master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
        self.server_proc = subprocess.Popen(['herdr', '--session', SESSION], stdin=slave, stdout=slave, stderr=slave, env=self.env, cwd=self.repo, start_new_session=True)
        os.close(slave); os.set_blocking(master, False); self.master = master
        threading.Thread(target=self.drain, daemon=True).start()
        sock = self.home / f'.config/herdr/sessions/{SESSION}/herdr.sock'
        end = time.monotonic() + 15
        while not sock.exists() and time.monotonic() < end: time.sleep(.2)
        self.assertTrue(sock.exists(), 'isolated herdr session did not start')

    def drain(self):
        while self.server_proc and self.server_proc.poll() is None:
            if select.select([self.master], [], [], .2)[0]:
                try:
                    b = os.read(self.master, 65536)
                    if b'\x1b[6n' in b: os.write(self.master, b'\x1b[1;1R')
                except OSError: return

    def tearDown(self):
        try: subprocess.run(['herdr', 'session', 'stop', SESSION], env=self.env, capture_output=True, timeout=15)
        except Exception: pass
        if self.server_proc and self.server_proc.poll() is None:
            os.killpg(self.server_proc.pid, signal.SIGTERM)
            try: self.server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(self.server_proc.pid, signal.SIGKILL)
        self.server.shutdown()
        evidence = ROOT / '.superpowers/native'; evidence.mkdir(parents=True, exist_ok=True)
        out = self.home / 'sender.out'
        (evidence / (self._testMethodName + '.json')).write_text(json.dumps({'sender': out.read_text() if out.exists() else '', 'requests': len(self.requests)}, ensure_ascii=False, indent=2))
        if not os.environ.get('KEEP_HOME'): shutil.rmtree(self.home, ignore_errors=True)
        else: print('HOME', self.home)

    def test_handoff_starts_a_new_specification_session(self):
        self.start_session()
        pane = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        out, done = self.home / 'sender.out', self.home / 'sender.done'
        cmd = (f"cd {self.repo} && pi-profile launch --profile developer -- --print --approve --model owned-fixture/fixture --thinking medium "
               f"OWNED_TOOL_REQUEST > {out} 2>&1; echo $? > {done}")
        self.herdr('pane', 'run', pane, cmd)
        end = time.monotonic() + 180
        while not done.exists() and time.monotonic() < end: time.sleep(1)
        self.assertTrue(done.exists(), 'sender did not finish; output:\n' + (out.read_text() if out.exists() else ''))
        results = [m.get('content') for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool']
        last = json.loads(results[-1][results[-1].find('{'):results[-1].rfind('}') + 1]) if results else {}
        self.assertEqual(last.get('status'), 'applied', json.dumps(last, ensure_ascii=False)[:2000] + '\n' + out.read_text()[-2000:])
        tabs = self.herdr('tab', 'list')['result']['tabs']
        new = [t for t in tabs if t['label'].startswith('scaffold-')]
        self.assertEqual(len(new), 1, tabs)
        self.assertFalse(new[0]['focused'], 'the new tab is created without focus')
        self.assertTrue(any(t['tab_id'] != new[0]['tab_id'] for t in tabs), 'the original tab is kept')
        issue = json.loads((self.state / 'issue-10.json').read_text())
        self.assertIn('Stage: Specification', [l['name'] for l in issue['labels']])
        self.assertIn('"stage": "specification"', issue['body'])
        receipts = list((self.agent / 'pi-scaffold/state').rglob('started.json'))
        self.assertEqual(len(receipts), 1)
        ready = json.loads((receipts[0].parent / 'ready.json').read_text())
        self.assertEqual(json.loads(receipts[0].read_text())['sessionId'], ready['sessionId'])
        self.assertNotEqual(ready['sessionId'], last['data']['targetSessionId'] if False else '', 'receiver session id recorded')
        self.assertEqual(last['data']['targetSessionId'], ready['sessionId'])
        self.assertTrue(any('pi-scaffold:' in json.dumps(r.get('messages', []), ensure_ascii=False) for r in self.requests), 'the stage prompt reached the new session')


    def approve_in_parent_tui(self, dialog='仕様の内容承認'):
        """Real Pi TUI (not in a real Herdr pane, same synthetic HOME): the tool asks the parent approval, Yes is chosen, then it stops at HERDR_UNAVAILABLE."""
        master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
        # Herdr-looking variables with a socket that does not exist: the cheap checks pass, the dialog is shown, then the driver cannot reach Herdr.
        env = dict(self.env, HERDR_ENV='1', HERDR_WORKSPACE_ID='w0', HERDR_PANE_ID='w0:p0', HERDR_SOCKET_PATH=str(self.home / 'no-such-herdr.sock'))
        tui = subprocess.Popen(['pi-profile', 'launch', '--profile', 'developer', '--', '--approve', '--model', 'owned-fixture/fixture', '--thinking', 'medium'],
                               stdin=slave, stdout=slave, stderr=slave, env=env, cwd=self.repo, start_new_session=True)
        os.close(slave); os.set_blocking(master, False)
        data = b''
        def pump_until(pred, timeout):
            nonlocal data
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                if select.select([master], [], [], .1)[0]:
                    try:
                        b = os.read(master, 65536); data += b
                        if b'\x1b[6n' in b: os.write(master, b'\x1b[1;1R')
                    except OSError: pass
                if pred(): return True
            return False
        text = lambda: data.decode('utf8', 'replace')
        try:
            self.assertTrue(pump_until(lambda: 'fixture' in text(), 30), 'TUI did not start:\n' + text()[-2000:])
            time.sleep(1); os.write(master, b'OWNED_TOOL_REQUEST\r')
            self.assertTrue(pump_until(lambda: dialog in text(), 60), 'no approval dialog:\n' + text()[-3000:])
            time.sleep(.5); os.write(master, b'\r')
            done = lambda: any('HERDR_UNAVAILABLE' in json.dumps(m.get('content'), ensure_ascii=False) for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool')
            self.assertTrue(pump_until(done, 60), 'tool did not finish after approval:\n' + text()[-3000:])
        finally:
            os.killpg(tui.pid, signal.SIGTERM)
            try: tui.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(tui.pid, signal.SIGKILL)
            os.close(master)
        approvals = list((self.agent / 'pi-scaffold/state').rglob('approvals/' + ('implementation-start' if self.impl else 'specification') + '/*.json'))
        self.assertEqual(len(approvals), 1, approvals)
        self.requests.clear()

    def test_basic_design_handoff_after_parent_tui_approval(self):
        self.approve_in_parent_tui()
        self.start_session()
        pane = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        out, done = self.home / 'sender.out', self.home / 'sender.done'
        cmd = (f"cd {self.repo} && pi-profile launch --profile developer -- --print --approve --model owned-fixture/fixture --thinking medium "
               f"OWNED_TOOL_REQUEST > {out} 2>&1; echo $? > {done}")
        self.herdr('pane', 'run', pane, cmd)
        end = time.monotonic() + 180
        while not done.exists() and time.monotonic() < end: time.sleep(1)
        self.assertTrue(done.exists(), 'sender did not finish; output:\n' + (out.read_text() if out.exists() else ''))
        results = [m.get('content') for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool']
        last = json.loads(results[-1][results[-1].find('{'):results[-1].rfind('}') + 1]) if results else {}
        self.assertEqual(last.get('status'), 'applied', json.dumps(last, ensure_ascii=False)[:2000] + '\n' + out.read_text()[-2000:])
        issue = json.loads((self.state / 'issue-10.json').read_text())
        self.assertEqual(sorted(l['name'] for l in issue['labels']), ['Scope: Epic', 'Stage: BasicDesign', 'Type: Scaffold'])
        self.assertIn('"stage": "basic-design"', issue['body'])
        self.assertTrue(any('基本設計（BasicDesign）' in json.dumps(r.get('messages', []), ensure_ascii=False) for r in self.requests), 'the BasicDesign prompt reached the new session')

    def test_implementation_handoff_after_parent_tui_approval(self):
        self.approve_in_parent_tui('実装開始の指示')
        self.start_session()
        pane = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        out, done = self.home / 'sender.out', self.home / 'sender.done'
        cmd = (f"cd {self.repo} && pi-profile launch --profile developer -- --print --approve --model owned-fixture/fixture --thinking medium "
               f"OWNED_TOOL_REQUEST > {out} 2>&1; echo $? > {done}")
        self.herdr('pane', 'run', pane, cmd)
        end = time.monotonic() + 180
        while not done.exists() and time.monotonic() < end: time.sleep(1)
        self.assertTrue(done.exists(), 'sender did not finish; output:\n' + (out.read_text() if out.exists() else ''))
        results = [m.get('content') for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool']
        last = json.loads(results[-1][results[-1].find('{'):results[-1].rfind('}') + 1]) if results else {}
        self.assertEqual(last.get('status'), 'applied', json.dumps(last, ensure_ascii=False)[:2000] + '\n' + out.read_text()[-2000:])
        issue = json.loads((self.state / 'issue-10.json').read_text())
        self.assertEqual(sorted(l['name'] for l in issue['labels']), ['Scope: Epic', 'Stage: Implementation', 'Type: Scaffold'])
        self.assertIn('"stage": "implementation"', issue['body'])
        for n in (11, 12): self.assertIn('Stage: BasicDesign', [l['name'] for l in json.loads((self.state / f'issue-{n}.json').read_text())['labels']], 'Features keep their stage')
        self.assertTrue(any('詳細設計・実装' in json.dumps(r.get('messages', []), ensure_ascii=False) for r in self.requests), 'the Implementation prompt reached the new session')

    def test_verification_handoff_with_pinned_evidence(self):
        self.start_session()
        pane = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        out, done = self.home / 'sender.out', self.home / 'sender.done'
        cmd = (f"cd {self.repo} && pi-profile launch --profile developer -- --print --approve --model owned-fixture/fixture --thinking medium "
               f"OWNED_TOOL_REQUEST > {out} 2>&1; echo $? > {done}")
        self.herdr('pane', 'run', pane, cmd)
        end = time.monotonic() + 180
        while not done.exists() and time.monotonic() < end: time.sleep(1)
        self.assertTrue(done.exists(), 'sender did not finish; output:\n' + (out.read_text() if out.exists() else ''))
        results = [m.get('content') for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool']
        last = json.loads(results[-1][results[-1].find('{'):results[-1].rfind('}') + 1]) if results else {}
        self.assertEqual(last.get('status'), 'applied', json.dumps(last, ensure_ascii=False)[:2000] + '\n' + out.read_text()[-2000:])
        self.assertTrue(last['data']['testedOnIntegration']); self.assertEqual(last['data']['evidenceChecked'], 'refs-and-hashes-only')
        issue = json.loads((self.state / 'issue-10.json').read_text())
        self.assertEqual(issue['state'], 'open', 'the Epic stays open')
        self.assertEqual(sorted(l['name'] for l in issue['labels']), ['Scope: Epic', 'Stage: Verification', 'Type: Scaffold'])
        packets = list((self.agent / 'pi-scaffold/state').rglob('packet.json'))
        self.assertEqual(len(packets), 1)
        refs = json.loads(packets[0].read_text())['resourceRefs']
        self.assertIn(f'integration:{self.integration}', refs)
        self.assertEqual(len([r for r in refs if r.startswith('evidence:')]), 2)
        self.assertTrue(any('検証（Verification）' in json.dumps(r.get('messages', []), ensure_ascii=False) for r in self.requests))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pi', default=str(ROOT / 'node_modules/.bin/pi'))
    parser.add_argument('--pi-gh', required=True)
    parser.add_argument('--pi-profile', required=True)
    parser.add_argument('--case')
    OPTIONS = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(Acceptance(n) for n in (['test_' + OPTIONS.case] if OPTIONS.case else ['test_handoff_starts_a_new_specification_session', 'test_basic_design_handoff_after_parent_tui_approval', 'test_implementation_handoff_after_parent_tui_approval', 'test_verification_handoff_with_pinned_evidence'])))
    raise SystemExit(0 if result.wasSuccessful() else 1)
