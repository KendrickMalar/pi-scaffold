#!/usr/bin/env python3
"""Native Pi acceptance for the pi-scaffold foundation (#2).

Synthetic HOME, loopback model, stateful fake `gh`, real Pi and a real pi-gh 0.2.0 checkout.
Never touches the user's agent directory, credentials or GitHub.

  python3 scripts/test-native-pi.py --pi-gh /path/to/pi-gh [--pi node_modules/.bin/pi] [--case NAME]
"""
import argparse, fcntl, hashlib, http.server, json, os, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, threading, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPTIONS = None
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Z0-9])")
OPERATION_ID = '33333333-3333-4333-8333-333333333333'


class Child:
    def __init__(self, args, env, cwd):
        self.master, slave = pty.openpty()
        os.set_blocking(self.master, False)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
        self.p = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd, start_new_session=True)
        os.close(slave)
        self.data = b''
        self.closed = False

    def pump(self, seconds=.05):
        if select.select([self.master], [], [], seconds)[0]:
            try:
                b = os.read(self.master, 65536)
                self.data += b
                if b'\x1b[6n' in b: self.send(b'\x1b[1;1R')
                if b'\x1b[c' in b: self.send(b'\x1b[?1;2c')
            except OSError:
                pass

    def text(self, mark=0):
        return ANSI.sub('', self.data[mark:].decode('utf8', 'replace'))

    def wait(self, predicate, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump()
            if predicate(): return
            if self.p.poll() is not None:
                if predicate(): return
                break
        raise AssertionError('timeout/exit waiting for Pi; tail:\n' + self.text()[-4000:])

    def send(self, data):
        payload = data.encode() if isinstance(data, str) else data
        offset, deadline = 0, time.monotonic() + 12
        while offset < len(payload):
            if time.monotonic() > deadline: raise AssertionError('PTY input blocked')
            self.pump(0)
            if select.select([], [self.master], [], .05)[1]:
                try: offset += os.write(self.master, payload[offset:offset + 512])
                except BlockingIOError: pass

    def close(self):
        if self.closed: return
        self.closed = True
        if self.p.poll() is None:
            os.killpg(self.p.pid, signal.SIGTERM)
            try: self.p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.p.pid, signal.SIGKILL); self.p.wait(timeout=3)
        self.pump(0)
        os.close(self.master)


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix='pi-scaffold-native-')).resolve()
        self.agent = self.home / 'agent'; self.agent.mkdir()
        self.cwd = self.home / 'repo'; self.cwd.mkdir()
        self.state = self.home / 'gh-state'; self.state.mkdir()
        self.requests, self.children, self.calls = [], [], 0
        self.pi_gh = Path(OPTIONS.pi_gh).resolve()
        self.assertEqual(json.loads((self.pi_gh / 'package.json').read_text())['version'], '0.2.0', 'pi-gh 0.2.0 checkout is required')
        subprocess.run(['git', 'init', '-q', str(self.cwd)], check=True)
        subprocess.run(['git', '-C', str(self.cwd), 'remote', 'add', 'origin', 'https://github.com/example/demo.git'], check=True)
        body = subprocess.check_output(['node', '--input-type=module', '-e',
            "import {renderEpicBlock} from './dist/src/core/epic-render.js';import {readFileSync} from 'node:fs';"
            "process.stdout.write(renderEpicBlock(JSON.parse(readFileSync('test/fixtures/epic-v1.initial.json','utf8'))))"], cwd=ROOT, text=True)
        self.body = body
        issue = {'id': 1010, 'node_id': 'I_example10', 'number': 10, 'title': '一覧をCSVで保存できるようにする', 'body': body, 'state': 'open',
                 'labels': [{'id': 9001, 'node_id': 'LA_9001', 'name': 'Type: Scaffold', 'color': '7057ff', 'description': 'Scaffold'}, {'id': 9002, 'node_id': 'LA_9002', 'name': 'Scope: Epic', 'color': '5319e7', 'description': 'Epic'}], 'html_url': 'https://github.com/example/demo/issues/10'}
        (self.state / 'issue-10.json').write_text(json.dumps(issue))
        self.bin = self.home / 'bin'; self.bin.mkdir()
        shutil.copyfile(ROOT / 'test/native/fake-gh.mjs', self.bin / 'gh'); (self.bin / 'gh').chmod(0o755)
        for name in ['node', 'git', 'rg', 'fd']:
            found = shutil.which(name)
            if found: (self.bin / name).symlink_to(found)
        self.tool, self.tool_args = 'scaffold_test_probe', self.probe_args()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length']))); owner.requests.append(body)
                messages = body.get('messages', [])
                last = max([i for i, m in enumerate(messages) if m.get('role') == 'user'], default=-1)
                call = not any(m.get('role') == 'tool' for m in messages[last + 1:])
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                if call:
                    owner.calls += 1
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'owned-call-{owner.calls}', 'type': 'function', 'function': {'name': owner.tool, 'arguments': json.dumps(owner.tool_args)}}]}; end = 'tool_calls'
                else:
                    delta = {'role': 'assistant', 'content': 'SCAFFOLD_FIXTURE_DONE'}; end = 'stop'
                for d, finish in [(delta, None), ({}, end)]:
                    event = {'id': 'owned', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture', 'choices': [{'index': 0, 'delta': d, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        models = {'providers': {'owned-fixture': {'baseUrl': f'http://127.0.0.1:{self.server.server_port}/v1', 'api': 'openai-completions', 'apiKey': 'FAKE_LOCAL_KEY', 'models': [{'id': 'fixture', 'contextWindow': 32768, 'maxTokens': 512}]}}}
        (self.agent / 'models.json').write_text(json.dumps(models)); (self.agent / 'auth.json').write_text('{}')
        settings = {'packages': [], 'extensions': [], 'quietStartup': True, 'telemetry': False, 'theme': 'dark', 'compaction': {'enabled': False}}
        (self.agent / 'settings.json').write_text(json.dumps(settings))
        self.env = {'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
                    'PI_CODING_AGENT_DIR': str(self.agent), 'PI_CODING_AGENT_SESSION_DIR': str(self.agent / 'sessions'), 'PI_OFFLINE': '1', 'FAKE_GH_STATE': str(self.state)}
        settings['lastChangelogVersion'] = subprocess.check_output([OPTIONS.pi, '--no-extensions', '--version'], env=self.env, cwd=self.cwd, text=True).strip()
        (self.agent / 'settings.json').write_text(json.dumps(settings))
        self.unchanged = {name: (self.agent / name).read_bytes() for name in ['auth.json', 'models.json', 'settings.json']}

    def probe_args(self, **over):
        args = {'repo': 'example/demo', 'epicIssue': 10, 'operationId': OPERATION_ID, 'expectedRevision': 1, 'expectedBodySha256': None}
        args.update(over); return args

    def args(self, *more, probe=True, trust=True):
        ext = ['-e', str(self.pi_gh), '-e', str(ROOT)] + (['-e', str(ROOT / 'test/fixtures/probe-extension.ts')] if probe else [])
        return [OPTIONS.pi, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--approve' if trust else '--no-approve', *ext, '--model', 'owned-fixture/fixture', *more]

    def run_print(self, **kw):
        if self.tool_args.get('expectedBodySha256') is None: self.tool_args['expectedBodySha256'] = hashlib.sha256(self.body.encode()).hexdigest()
        try:
            r = subprocess.run(self.args('--print', 'OWNED_TOOL_REQUEST', **kw), env=self.env, cwd=self.cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=40)
        except subprocess.TimeoutExpired as e:
            tail = lambda b: (b.decode('utf8', 'replace') if isinstance(b, bytes) else (b or ''))[-3000:]
            raise AssertionError(f'Pi --print timed out; requests={len(self.requests)}\nstdout:\n{tail(e.stdout)}\nstderr:\n{tail(e.stderr)}') from None
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def tool_messages(self):
        seen = {}
        for req in self.requests:
            for m in req.get('messages', []):
                if m.get('role') == 'tool':
                    content = m.get('content')
                    seen[m.get('tool_call_id')] = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        return seen

    def tool_results(self):
        return [v for _, v in sorted(self.tool_messages().items(), key=lambda kv: int(str(kv[0]).rsplit('-', 1)[-1]))]

    def wait_result(self, c, n, timeout=40):
        c.wait(lambda: f'owned-call-{n}' in self.tool_messages(), timeout)

    def last_result(self):
        results = self.tool_results(); self.assertTrue(results, 'no tool result reached the model')
        text = results[-1]
        start = text.find('{'); return json.loads(text[start:text.rfind('}') + 1])

    def writes(self):
        f = self.state / 'writes.jsonl'
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

    def grant(self):
        d = self.home / '.pi/agent'; d.mkdir(parents=True, exist_ok=True)
        p = d / 'pi-gh-permissions.json'
        p.write_text(json.dumps({'version': 1, 'grants': [{'repo': 'example/demo', 'operations': ['gh_issue_edit'], 'allowHeadless': True, 'allowChild': True}]})); p.chmod(0o600)

    def tearDown(self):
        for c in self.children: c.close()
        self.server.shutdown(); self.thread.join(); self.server.server_close()
        for name, data in self.unchanged.items(): self.assertEqual((self.agent / name).read_bytes(), data, name + ' changed')
        evidence = ROOT / '.superpowers/native'; evidence.mkdir(parents=True, exist_ok=True)
        (evidence / (self._testMethodName + '.json')).write_text(json.dumps({'toolResults': self.tool_results(), 'writes': self.writes(), 'tui': [c.text() for c in self.children]}, ensure_ascii=False, indent=2))
        if not os.environ.get('KEEP_HOME'): shutil.rmtree(self.home, ignore_errors=True)
        else: print('HOME', self.home)

    # --- cases -------------------------------------------------------------------------------

    def test_registered_tool_set(self):
        self.tool, self.tool_args = 'gh_capabilities', {}
        self.run_print(probe=False)
        names = [t.get('function', {}).get('name') for t in self.requests[0].get('tools', [])]
        self.assertEqual(sorted(n for n in names if n and n.startswith('scaffold_')), ['scaffold_labels_ensure'], 'only accepted scaffold tools are registered')
        self.assertEqual(len([n for n in names if n and n.startswith('gh_')]), 21, 'pi-gh with gh_labels_list (KendrickMalar/pi-gh#5) is required')

    def test_nested_write_without_grant_is_blocked(self):
        self.run_print()
        r = self.last_result()
        self.assertEqual(r['status'], 'blocked', r)
        self.assertIn('APPROVAL_UI_REQUIRED', json.dumps(r))
        self.assertEqual(self.writes(), [])

    def test_nested_write_with_grant_applies_once(self):
        self.grant(); self.run_print()
        r = self.last_result()
        self.assertEqual(r['status'], 'applied', r)
        writes = self.writes(); self.assertEqual(len(writes), 1); self.assertTrue(writes[0]['patch']['body'].endswith('(probe)'))
        journal = list((self.agent / 'pi-scaffold/state').rglob(OPERATION_ID + '.json'))
        self.assertTrue(journal and all((p.stat().st_mode & 0o777) == 0o600 for p in journal), journal)
        self.requests.clear(); self.run_print()
        self.assertEqual(self.last_result()['status'], 'noop'); self.assertEqual(len(self.writes()), 1)

    def test_hook_blocked_nested_write_is_not_success(self):
        self.grant(); self.env['OWNED_BLOCK_NESTED'] = '1'; self.run_print()
        r = self.last_result()
        self.assertIn(r['status'], ['unknown', 'blocked'], r)
        self.assertEqual(self.writes(), [])

    def test_untrusted_project_is_blocked(self):
        self.grant(); self.run_print(trust=False)
        r = self.last_result()
        self.assertEqual(r['status'], 'blocked', r); self.assertIn('UNTRUSTED_PROJECT', json.dumps(r)); self.assertEqual(self.writes(), [])

    def test_unknown_key_is_rejected_by_pi_validation(self):
        self.grant(); self.tool_args = dict(self.probe_args(), approved=True)
        self.run_print()
        self.assertEqual(self.writes(), [])
        self.assertNotIn('"status":"applied"', ''.join(self.tool_results()))

    def test_rpc_cannot_approve_nested_write(self):
        self.tool_args['expectedBodySha256'] = hashlib.sha256(self.body.encode()).hexdigest()
        p = subprocess.Popen(self.args('--mode', 'rpc'), env=self.env, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            p.stdin.write(b'{"type":"prompt","message":"OWNED_TOOL_REQUEST"}\n'); p.stdin.flush()
            events, pending, deadline = [], b'', time.monotonic() + 30
            while time.monotonic() < deadline and not any(e.get('type') == 'agent_end' for e in events):
                if select.select([p.stdout], [], [], .1)[0]:
                    pending += os.read(p.stdout.fileno(), 65536)
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        if line: events.append(json.loads(line))
            self.assertTrue(any(e.get('type') == 'agent_end' for e in events))
            self.assertEqual(self.last_result()['status'], 'blocked'); self.assertEqual(self.writes(), [])
        finally:
            p.stdin.close(); p.stdin = None
            try: p.communicate(timeout=3)
            except subprocess.TimeoutExpired: p.terminate(); p.communicate(timeout=3)

    def label_defs(self):
        return json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
            "import {labelDefinitions} from './dist/src/core/label-definitions.js';process.stdout.write(JSON.stringify(labelDefinitions()))"], cwd=ROOT, text=True))

    def test_labels_ensure_creates_only_missing(self):
        defs = self.label_defs()
        seeded = [d for d in defs if d['name'] not in ('Blocked', 'Wave: 200')]
        (self.state / 'labels.json').write_text(json.dumps([{'id': i + 1, 'node_id': f'LA_{i + 1}', **d} for i, d in enumerate(seeded)]))
        d = self.home / '.pi/agent'; d.mkdir(parents=True, exist_ok=True)
        p = d / 'pi-gh-permissions.json'
        p.write_text(json.dumps({'version': 1, 'grants': [{'repo': 'example/demo', 'operations': ['gh_label_create'], 'allowHeadless': True, 'allowChild': True}]})); p.chmod(0o600)
        self.tool, self.tool_args = 'scaffold_labels_ensure', {'repo': 'example/demo', 'operationId': OPERATION_ID}
        statuses = []
        for _ in range(12):
            self.requests.clear()
            r = subprocess.run(self.args('--print', 'OWNED_TOOL_REQUEST', probe=False), env=self.env, cwd=self.cwd, text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=150)
            self.assertEqual(r.returncode, 0, r.stderr)
            statuses.append(self.last_result()['status'])
            if statuses[-1] != 'partial': break
        self.assertEqual(statuses[-1], 'applied', statuses)
        self.assertTrue(all(s == 'partial' for s in statuses[:-1]), statuses)
        writes = self.writes()
        self.assertEqual(sorted(w['label']['name'] for w in writes), ['Blocked', 'Wave: 200'])
        final = {l['name']: (l['color'], l['description']) for l in json.loads((self.state / 'labels.json').read_text())}
        self.assertEqual(final, {d['name']: (d['color'], d['description']) for d in defs})
        self.assertFalse(any('/issues/' in w.get('endpoint', '') for w in writes), 'no Issue label changes')
        print(f'\n  labels_ensure calls: {statuses}', end=' ')

    def tui(self):
        self.tool_args['expectedBodySha256'] = hashlib.sha256(self.body.encode()).hexdigest()
        c = Child(self.args(), self.env, self.cwd); self.children.append(c)
        c.wait(lambda: 'OWNED_SESSION_READY' in c.text()); c.send('/owned-ready\r'); c.wait(lambda: 'OWNED_READY' in c.text())
        return c

    def test_tui_direct_pi_gh_approval_baseline(self):
        change = self.cwd / 'change.json'
        change.write_text(json.dumps({'version': 1, 'repo': 'example/demo', 'operation': 'issue-edit', 'issue': 10, 'body': self.body + '\n(direct)'}))
        self.tool, self.tool_args = 'gh_issue_edit', {'changePath': str(change)}
        c = Child(self.args(), self.env, self.cwd); self.children.append(c)
        c.wait(lambda: 'OWNED_SESSION_READY' in c.text()); c.send('/owned-ready\r'); c.wait(lambda: 'OWNED_READY' in c.text())
        c.send('OWNED_TOOL_REQUEST\r'); c.wait(lambda: 'pi-gh review:' in c.text(), 30)
        c.send('\x1b[C'); c.wait(lambda: '[Approve]' in c.text(), 30)
        c.send('\r'); self.wait_result(c, 1)
        self.assertEqual(len(self.writes()), 1, self.tool_results()[-1][:300])

    def test_tui_nested_approval_cancel_then_approve(self):
        c = self.tui()
        c.send('OWNED_TOOL_REQUEST\r'); c.wait(lambda: 'pi-gh review:' in c.text(), 30)
        c.send('\x1b'); self.wait_result(c, 1)
        self.assertEqual(self.last_result()['status'], 'blocked'); self.assertEqual(self.writes(), [])
        self.tool_args['operationId'] = '44444444-4444-4444-8444-444444444444'
        mark = len(c.data); c.send('OWNED_TOOL_REQUEST\r'); c.wait(lambda: 'pi-gh review:' in c.text(mark), 30)
        c.send('\x1b[C'); c.wait(lambda: '[Approve]' in c.text(mark), 30)
        c.send('\r'); self.wait_result(c, 2)
        self.assertEqual(self.last_result()['status'], 'applied', self.last_result()); self.assertEqual(len(self.writes()), 1)

    def test_tui_nested_approval_cancel_then_approve_after_reload(self):
        c = self.tui()
        c.send('OWNED_TOOL_REQUEST\r'); c.wait(lambda: 'pi-gh review:' in c.text(), 30)
        c.send('\x1b'); self.wait_result(c, 1)
        self.assertEqual(self.last_result()['status'], 'blocked'); self.assertEqual(self.writes(), [])
        mark = len(c.data); c.send('/reload\r'); c.wait(lambda: 'eloaded' in c.text(mark), 30)
        self.tool_args['operationId'] = '44444444-4444-4444-8444-444444444444'
        mark = len(c.data); c.send('OWNED_TOOL_REQUEST\r'); c.wait(lambda: 'pi-gh review:' in c.text(mark), 30)
        c.send('\x1b[C'); c.wait(lambda: '[Approve]' in c.text(mark), 30)
        c.send('\r'); self.wait_result(c, 2)
        self.assertEqual(self.last_result()['status'], 'applied'); self.assertEqual(len(self.writes()), 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pi', default=str(ROOT / 'node_modules/.bin/pi'))
    parser.add_argument('--pi-gh', default=os.environ.get('PI_SCAFFOLD_PI_GH'), required=os.environ.get('PI_SCAFFOLD_PI_GH') is None)
    parser.add_argument('--case')
    OPTIONS = parser.parse_args()
    names = ['test_' + OPTIONS.case] if OPTIONS.case else [n for n in Acceptance.__dict__ if n.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(Acceptance(n) for n in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
