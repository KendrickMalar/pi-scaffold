#!/usr/bin/env python3
"""Native end-to-end acceptance for the whole Scaffold workflow (Epic #1): one Epic goes through all 14 tools.

Runs ONLY in an isolated, named Herdr session (`pst`) under a synthetic HOME in /tmp: its own Herdr config/socket,
Pi agent dir/Profile, a stateful fake `gh` (fictional example/demo data), a loopback model and a local git repository.
The three approvals are given in a real Pi TUI dialog; the four handoffs open real new tabs. Only `git ls-remote` is
answered locally (as origin would) so nothing touches the network. Never touches the user's Herdr, Pi settings or GitHub.

  python3 scripts/test-native-workflow.py --pi-gh /path/to/pi-gh-0.5.0 --pi-profile /path/to/pi-profile
"""
import argparse, fcntl, hashlib, http.server, json, os, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, threading, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPTIONS = None
SESSION = 'pst'
MODEL = 'owned-fixture/fixture'
U = lambda n: f'{n:08x}-0000-4000-8000-{n:012x}'


class Workflow(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix='psh-', dir='/tmp')).resolve()
        self.agent = self.home / '.pi/agent'; self.agent.mkdir(parents=True)
        self.repo = self.home / 'repo'; self.repo.mkdir()
        self.state = self.home / 'gh'; self.state.mkdir()
        self.bin = self.home / 'bin'; self.bin.mkdir()
        self.requests, self.server_proc, self.call = [], None, None
        self.genv = dict(os.environ, GIT_AUTHOR_NAME='f', GIT_AUTHOR_EMAIL='f@example.com', GIT_COMMITTER_NAME='f', GIT_COMMITTER_EMAIL='f@example.com')
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), 'remote', 'add', 'origin', 'https://github.com/example/demo.git'], check=True)
        self.commit('README.md', '# demo（架空）\n', 'init')
        defs = json.loads(self.node("import {labelDefinitions} from './dist/src/core/label-definitions.js';process.stdout.write(JSON.stringify(labelDefinitions()))"))
        (self.state / 'labels.json').write_text(json.dumps([{'id': i + 1, 'node_id': f'LA_{i + 1}', **d} for i, d in enumerate(defs)]))
        shutil.copyfile(ROOT / 'test/native/fake-gh.mjs', self.bin / 'gh'); (self.bin / 'gh').chmod(0o755)
        for name in ['node', 'herdr']: (self.bin / name).symlink_to(shutil.which(name))
        # git: real, except `ls-remote` which answers like origin would (default branch main at self.remote_head).
        self.remote_head = ''
        (self.bin / 'git').write_text(f'#!/bin/sh\nif [ "$1" = ls-remote ]; then printf "ref: refs/heads/main\\tHEAD\\n%s\\tHEAD\\n" "$(cat {self.home}/remote-head)"; exit 0; fi\nexec "{shutil.which("git")}" "$@"\n'); (self.bin / 'git').chmod(0o755)
        (self.bin / 'pi-profile').write_text(f'#!/bin/sh\nexec node {OPTIONS.pi_profile}/dist/src/cli.js "$@"\n'); (self.bin / 'pi-profile').chmod(0o755)
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length']))); owner.requests.append(body)
                msgs = body.get('messages', [])
                users = [m for m in msgs if m.get('role') == 'user']
                last = json.dumps(users[-1].get('content'), ensure_ascii=False) if users else ''
                done = any(m.get('role') == 'tool' for m in msgs[msgs.index(users[-1]) + 1:]) if users else False
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                if 'OWNED_TOOL_REQUEST' in last and not done and owner.call:
                    name, args = owner.call
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
        pol = self.agent / 'pi-scaffold/policy.json'
        pol.write_text(json.dumps({'version': 1, 'repos': {'example/demo': {'authMode': 'file-backed', 'models': [{'model': MODEL, 'thinking': 'medium', 'tier': 'basic', 'roles': ['coding-manager', 'coder', 'tester']}]}}})); pol.chmod(0o600)
        grant = self.agent / 'pi-gh-permissions.json'
        grant.write_text(json.dumps({'version': 1, 'grants': [{'repo': 'example/demo', 'allowHeadless': True, 'allowChild': False, 'operations': [
            'gh_label_create', 'gh_issue_submit', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current', 'gh_subissue_add', 'gh_dependency_add']}]})); grant.chmod(0o600)
        for cmd in (['pi-profile', 'packages', 'install', '--profile', 'developer'], ['herdr', 'integration', 'install', 'pi']):
            r = subprocess.run(cmd, env=self.env, cwd=self.repo, text=True, capture_output=True, timeout=120)
            self.assertEqual(r.returncode, 0, f'{cmd}: {r.stdout}\n{r.stderr}')

    # ---- helpers ------------------------------------------------------------------------------------

    def node(self, script, *args):
        return subprocess.check_output(['node', '--input-type=module', '-e', script, *args], cwd=ROOT, text=True)

    def commit(self, path, text, message):
        p = self.repo / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True, env=self.genv)
        subprocess.run(['git', '-C', str(self.repo), 'commit', '-qm', message], check=True, env=self.genv)
        return subprocess.check_output(['git', '-C', str(self.repo), 'rev-parse', 'HEAD'], text=True).strip()

    def issue(self, n): return json.loads((self.state / f'issue-{n}.json').read_text())
    def labels(self, n): return sorted(l['name'] for l in self.issue(n)['labels'])
    def doc(self, n):
        body = self.issue(n)['body']
        return json.loads(re.search(r'```json\n(.*?)\n```', body, re.S).group(1).replace('\\u003c', '<').replace('\\u003e', '>').replace('\\u0026', '&'))
    def mutation(self, op, n=1):
        return {'repo': 'example/demo', 'epicIssue': n, 'operationId': op, 'expectedRevision': self.doc(n)['revision'], 'expectedBodySha256': hashlib.sha256(self.issue(n)['body'].encode()).hexdigest()}

    def result(self):
        tools = [m.get('content') for r in self.requests for m in r.get('messages', []) if m.get('role') == 'tool']
        self.assertTrue(tools, 'no tool result reached the model')
        t = tools[-1]; return json.loads(t[t.find('{'):t.rfind('}') + 1])

    def headless(self, name, args, expect=('applied',)):
        """A sender session outside Herdr (pi-profile launch, Development Profile)."""
        self.call, self.requests[:] = (name, args), []
        r = subprocess.run(['pi-profile', 'launch', '--profile', 'developer', '--', '--print', '--approve', '--model', MODEL, '--thinking', 'medium', 'OWNED_TOOL_REQUEST'],
                           env=self.env, cwd=self.repo, text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=240)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        res = self.result()
        self.assertIn(res['status'], expect, f'{name}: ' + json.dumps(res, ensure_ascii=False)[:3000])
        return res

    def in_herdr(self, name, args):
        """A sender session inside the isolated Herdr session (needed for handoffs)."""
        self.call, self.requests[:] = (name, args), []
        pane = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        out, done = self.home / f'{name}.out', self.home / f'{name}.done'
        self.herdr('pane', 'run', pane, f"cd {self.repo} && pi-profile launch --profile developer -- --print --approve --model {MODEL} --thinking medium OWNED_TOOL_REQUEST > {out} 2>&1; echo $? > {done}")
        end = time.monotonic() + 240
        while not done.exists() and time.monotonic() < end: time.sleep(1)
        self.assertTrue(done.exists(), f'{name} sender did not finish:\n' + (out.read_text()[-2000:] if out.exists() else ''))
        res = self.result()
        self.assertEqual(res['status'], 'applied', f'{name}: ' + json.dumps(res, ensure_ascii=False)[:3000] + '\n' + out.read_text()[-2000:])
        return res

    def tui(self, name, args, dialog, fake_herdr=True, until=None):
        """A real Pi TUI: the tool shows the parent approval dialog, Yes is chosen."""
        self.call, self.requests[:] = (name, args), []
        env = dict(self.env, **({'HERDR_ENV': '1', 'HERDR_WORKSPACE_ID': 'w0', 'HERDR_PANE_ID': 'w0:p0', 'HERDR_SOCKET_PATH': str(self.home / 'no-such.sock')} if fake_herdr else {}))
        master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
        proc = subprocess.Popen(['pi-profile', 'launch', '--profile', 'developer', '--', '--approve', '--model', MODEL, '--thinking', 'medium'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=self.repo, start_new_session=True)
        os.close(slave); os.set_blocking(master, False)
        data = b''
        def pump(pred, timeout):
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
        try:
            self.assertTrue(pump(lambda: b'fixture' in data, 30), 'TUI did not start')
            time.sleep(1); os.write(master, b'OWNED_TOOL_REQUEST\r')
            self.assertTrue(pump(lambda: dialog in data.decode('utf8', 'replace'), 90), f'no "{dialog}" dialog:\n' + data.decode('utf8', 'replace')[-3000:])
            time.sleep(.5); os.write(master, b'\r')
            self.assertTrue(pump(lambda: any(m.get('role') == 'tool' for r in self.requests for m in r.get('messages', [])), 120), 'tool did not finish after approval')
        finally:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL)
            os.close(master)
        return self.result()

    def herdr(self, *args):
        env = dict(self.env, HERDR_SOCKET_PATH=str(self.home / f'.config/herdr/sessions/{SESSION}/herdr.sock'))
        r = subprocess.run(['herdr', *args], env=env, text=True, capture_output=True, timeout=20)
        self.assertEqual(r.returncode, 0, f'herdr {args}: {r.stdout}{r.stderr}')
        return json.loads(r.stdout) if r.stdout.strip().startswith('{') else r.stdout

    def start_session(self):
        master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
        self.server_proc = subprocess.Popen(['herdr', '--session', SESSION], stdin=slave, stdout=slave, stderr=slave, env=self.env, cwd=self.repo, start_new_session=True)
        os.close(slave); os.set_blocking(master, False); self.master = master
        def drain():
            while self.server_proc and self.server_proc.poll() is None:
                if select.select([master], [], [], .2)[0]:
                    try:
                        b = os.read(master, 65536)
                        if b'\x1b[6n' in b: os.write(master, b'\x1b[1;1R')
                    except OSError: return
        threading.Thread(target=drain, daemon=True).start()
        sock = self.home / f'.config/herdr/sessions/{SESSION}/herdr.sock'
        end = time.monotonic() + 15
        while not sock.exists() and time.monotonic() < end: time.sleep(.2)
        self.assertTrue(sock.exists(), 'isolated herdr session did not start')

    def tearDown(self):
        try: subprocess.run(['herdr', 'session', 'stop', SESSION], env=self.env, capture_output=True, timeout=15)
        except Exception: pass
        if self.server_proc and self.server_proc.poll() is None:
            os.killpg(self.server_proc.pid, signal.SIGTERM)
            try: self.server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(self.server_proc.pid, signal.SIGKILL)
        self.server.shutdown()
        if not os.environ.get('KEEP_HOME'): shutil.rmtree(self.home, ignore_errors=True)
        else: print('HOME', self.home)

    # ---- the workflow -------------------------------------------------------------------------------

    def test_one_epic_through_all_fourteen_tools(self):
        self.start_session()
        b = {'model': MODEL, 'thinking': 'medium', 'reason': '架空の割り当て'}

        # setup
        self.assertIn(self.headless('scaffold_labels_ensure', {'repo': 'example/demo', 'operationId': U(1)}, ('applied', 'noop'))['status'], ('applied', 'noop'))
        draft = self.headless('scaffold_epic_draft_create', {'repo': 'example/demo', 'operationId': U(2), 'title': '一覧をCSVで保存（架空）', 'purpose': '一覧をCSVで保存できるようにする。',
            'originalRequest': {'text': 'CSVで落としたい。', 'sourceRefs': []},
            'initialFacts': [{'questionId': 'Q001', 'kind': 'question', 'question': '対象の一覧は？', 'answer': None, 'required': True, 'sourceRef': None}],
            'research': [{'researchId': 'R001', 'question': '10万行で何秒か', 'requiredEvidence': '計測', 'doneCondition': 'p95が分かる'}]})
        epic = draft['data']['issue']['number']; self.assertEqual(epic, 1)
        self.in_herdr('scaffold_handoff_specification', {**self.mutation(U(3)), 'expectedStage': 'setup', 'nextStage': 'specification'})
        self.assertIn('Stage: Specification', self.labels(1))

        # specification
        self.headless('scaffold_specification_update', {**self.mutation(U(4)), 'background': '月次集計で使う（架空）',
            'facts': [{'questionId': 'Q001', 'kind': 'question', 'question': '対象の一覧は？', 'answer': '顧客と注文', 'required': True, 'sourceRef': 'hearing-1'}],
            'requirements': [{'id': 'REQ001', 'description': '顧客一覧をCSVで保存できる'}, {'id': 'REQ002', 'description': '注文一覧をCSVで保存できる'}],
            'criteria': [{'id': 'AC001', 'requirementIds': ['REQ001'], 'verification': 'E2E', 'expectedResult': '保存される'}, {'id': 'AC002', 'requirementIds': ['REQ002'], 'verification': 'E2E', 'expectedResult': '保存される'}],
            'constraints': [], 'outOfScope': [], 'decisions': [{'id': 'D001', 'topic': '文字コード', 'decision': 'UTF-8', 'reason': '架空', 'sourceRefs': []}]})
        self.headless('scaffold_research_begin', {**self.mutation(U(5)), 'researchIds': ['R001']})
        self.headless('scaffold_research_resolve', {**self.mutation(U(6)), 'resolutions': [{'researchId': 'R001', 'claimOperationId': U(5), 'conclusion': 'p95で4.2秒（架空）',
            'evidenceRefs': ['https://example.com/bench/1'], 'limitations': ['開発機のみ'], 'disposition': 'resolved'}]})
        handoff_bd = self.mutation(U(7))
        tui = self.tui('scaffold_handoff_basic_design', handoff_bd, '仕様の内容承認')
        self.assertEqual(tui['status'], 'blocked'); self.assertIn('HERDR_UNAVAILABLE', json.dumps(tui))
        self.in_herdr('scaffold_handoff_basic_design', handoff_bd)
        self.assertIn('Stage: BasicDesign', self.labels(1))

        # basic design
        design_text = '# 基本設計（架空）\nAPIとUIに分ける\n'
        design_commit = self.commit('docs/design.md', design_text, 'design')
        design = {'path': 'docs/design.md', 'sha256': hashlib.sha256(design_text.encode()).hexdigest(), 'gitRef': design_commit}
        features = {}
        for i, (key, scope, ac, req) in enumerate([('F001', 'src/api/', 'AC101', 'REQ001'), ('F002', 'src/ui/', 'AC102', 'REQ002')]):
            res = self.headless('scaffold_feature_create', {**self.mutation(U(8 + i)), 'featureKey': key, 'title': f'{key}（架空）', 'purpose': f'{key}の実装', 'editScope': [scope], 'outOfScope': [],
                'designRef': design, 'criteria': [{'id': ac, 'requirementIds': [req], 'verification': '単体テスト', 'expectedResult': '期待どおり'}], 'bindings': {'coding-manager': b, 'coder': b, 'tester': b}})
            features[key] = res['data']['number']
        f1, f2 = features['F001'], features['F002']
        plan = {'version': 1, 'nodes': [{'featureKey': 'F001', 'issue': f1, 'contracts': ['CSV API'], 'startConditions': [], 'editScope': ['src/api/']},
                                        {'featureKey': 'F002', 'issue': f2, 'contracts': [], 'startConditions': ['APIが固まっている'], 'editScope': ['src/ui/']}],
                'edges': [{'from': f1, 'to': f2, 'reason': 'UIはAPIを使う'}]}
        self.headless('scaffold_dependencies_apply', {**self.mutation(U(10)), 'plan': plan, 'design': design})
        self.assertEqual(self.doc(1)['design'], design)
        digests = json.loads(self.node("import {taggedDigest} from './dist/src/core/digests.js';const [p,a,b]=process.argv.slice(1);"
            "process.stdout.write(JSON.stringify({dependencyDigest:taggedDigest('dependency-plan',JSON.parse(p)),featureSetDigest:taggedDigest('feature-set',[{issue:+a,featureKey:'F001'},{issue:+b,featureKey:'F002'}].sort((x,y)=>x.issue-y.issue))}))",
            json.dumps(plan), str(f1), str(f2)))
        waves = {'version': 1, 'assignments': [{'issue': f1, 'wave': 1}, {'issue': f2, 'wave': 2}], **digests}
        self.headless('scaffold_waves_apply', {**self.mutation(U(11)), 'plan': waves})
        verified = self.headless('scaffold_waves_verify', {'repo': 'example/demo', 'epicIssue': 1}, ('validated',))
        self.assertTrue(verified['data']['passed'])
        handoff_impl = self.mutation(U(12))
        tui = self.tui('scaffold_handoff_implementation', handoff_impl, '実装開始の指示')
        self.assertEqual(tui['status'], 'blocked'); self.assertIn('HERDR_UNAVAILABLE', json.dumps(tui))
        self.in_herdr('scaffold_handoff_implementation', handoff_impl)
        self.assertIn('Stage: Implementation', self.labels(1))

        # implementation → verification (the implementation itself is outside the tools; evidence files are its output)
        integration = self.commit('src/api/csv.ts', 'export const csv = () => "";\n', 'integration')
        wf = self.doc(1)['workflowId']
        repo_hash = self.node("import {repoHash} from './dist/src/core/repo-context.js';process.stdout.write(repoHash('example/demo'))")
        evidence_root = self.agent / 'pi-scaffold' / 'state' / repo_hash / wf / 'evidence'
        for d in (evidence_root, evidence_root / 'logs', evidence_root / 'reports'): d.mkdir(mode=0o700, parents=True, exist_ok=True); d.chmod(0o700)
        def evidence(prefix):
            refs = []
            for key, n, ac in (('F001', f1, 'AC101'), ('F002', f2, 'AC102')):
                log = f'{prefix} {key} ok\n'; lp = evidence_root / 'logs' / f'{prefix}-{n}.log'; lp.write_text(log); lp.chmod(0o600)
                report = json.dumps({'version': 1, 'workflowId': wf, 'featureIssue': n, 'productRef': integration, 'suiteRef': integration,
                    'criteria': [{'id': ac, 'status': 'pass', 'command': 'npm test', 'exitCode': 0, 'logPath': f'logs/{prefix}-{n}.log', 'logSha256': hashlib.sha256(log.encode()).hexdigest()}]})
                rp = evidence_root / 'reports' / f'{prefix}-{n}.json'; rp.write_text(report); rp.chmod(0o600)
                refs.append({'relativePath': f'reports/{prefix}-{n}.json', 'sha256': hashlib.sha256(report.encode()).hexdigest()})
            return refs
        res = self.in_herdr('scaffold_handoff_verification', {**self.mutation(U(13)), 'integrationRef': integration, 'evidenceRefs': evidence('impl')})
        self.assertTrue(res['data']['testedOnIntegration'])
        self.assertEqual(self.issue(1)['state'], 'open'); self.assertIn('Stage: Verification', self.labels(1))

        # verification → completed. Negative checks first (nothing may be closed by them):
        final = evidence('final')
        # origin's default branch does not contain the verified commit yet.
        (self.home / 'remote-head').write_text(design_commit)
        stop = self.headless('scaffold_epic_complete', {**self.mutation(U(15)), 'verifiedRef': integration, 'finalEvidenceRefs': final}, ('blocked',))
        self.assertIn('NOT_IN_DEFAULT_BRANCH', json.dumps(stop))
        # Everything is in place, but a headless session cannot give the final acceptance.
        (self.home / 'remote-head').write_text(integration)
        stop = self.headless('scaffold_epic_complete', {**self.mutation(U(16)), 'verifiedRef': integration, 'finalEvidenceRefs': final}, ('blocked',))
        self.assertIn('APPROVAL_UI_REQUIRED', json.dumps(stop))
        self.assertEqual(self.issue(1)['state'], 'open'); self.assertIn('Stage: Verification', self.labels(1))
        # The parent accepts in the TUI.
        done = self.tui('scaffold_epic_complete', {**self.mutation(U(14)), 'verifiedRef': integration, 'finalEvidenceRefs': final}, 'Epicの最終受け入れ', fake_herdr=False)
        self.assertEqual(done['status'], 'applied', json.dumps(done, ensure_ascii=False)[:2000])
        self.assertEqual(self.issue(1)['state'], 'closed')
        self.assertEqual(self.labels(1), ['Scope: Epic', 'Stage: Completed', 'Type: Scaffold'])
        self.assertEqual(self.doc(1)['stage'], 'completed')
        for n in (f1, f2): self.assertEqual(self.issue(n)['state'], 'open', 'Features are not closed by the workflow')
        self.assertEqual(sorted(self.issue(1).get('sub_issues', [])), sorted([f1, f2]))
        self.assertEqual(self.issue(f2).get('blocked_by'), [f1])
        tabs = [t for t in self.herdr('tab', 'list')['result']['tabs'] if t['label'].startswith('scaffold-')]
        self.assertEqual(len(tabs), 4, 'one new tab per handoff (specification, basic-design, implementation, verification)')
        approvals = sorted(p.parent.name for p in (self.agent / 'pi-scaffold/state').rglob('approvals/*/*.json'))
        self.assertEqual(approvals, ['epic-completion', 'implementation-start', 'specification'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pi', default=str(ROOT / 'node_modules/.bin/pi'))
    parser.add_argument('--pi-gh', required=True)
    parser.add_argument('--pi-profile', required=True)
    OPTIONS = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([Workflow('test_one_epic_through_all_fourteen_tools')]))
    raise SystemExit(0 if result.wasSuccessful() else 1)
