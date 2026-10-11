#!/usr/bin/env python3
"""Real Herdr acceptance for the stage watch (Issue #36): a parent Pi TUI hands off, the child stops on a transient
API error, and the parent's watch reacts.

Reuses the isolated setup of test-native-handoff.py (named Herdr session `pst`, synthetic HOME, fake `gh`, loopback
model). It never touches the user's Herdr sessions, Pi settings or GitHub. Each case takes a few minutes because the
watch checks every 60 seconds.

  python3 scripts/test-native-watch.py --pi-gh /path/to/pi-gh --pi-profile /path/to/pi-profile [--case NAME]
"""
import argparse, importlib.util, json, sys, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_handoff', ROOT / 'scripts/test-native-handoff.py')
native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)

CONTINUE_MARK = '一時的なエラーで止まったため再開します'
OVERLOADED = (503, json.dumps({'error': {'message': 'Service overloaded', 'type': 'overloaded_error'}}).encode())


class WatchAcceptance(native.Acceptance):
    def setUp(self):
        super().setUp()
        self.child_errors = 1
        # Pi's own retry would hide the error from the watch for minutes; the watch is what is under test.
        settings = json.loads((self.agent / 'settings.json').read_text()); settings['retry'] = {'enabled': False}
        (self.agent / 'settings.json').write_text(json.dumps(settings))
        # Log every herdr CLI call so the number of watch timers can be counted from the checks they make. Herdr hands
        # its panes HERDR_BIN_PATH, which Pi prefers, so the parent is launched with it pointing here.
        self.herdr_log = self.home / 'herdr-calls.log'
        real = (self.bin / 'herdr').resolve(); (self.bin / 'herdr').unlink()
        (self.bin / 'herdr').write_text(f'#!/bin/sh\necho "$(date +%s) $*" >> {self.herdr_log}\nexec {real} "$@"\n'); (self.bin / 'herdr').chmod(0o755)

    def model_failure(self, last):
        """The child's stage prompt fails with a transient error `child_errors` times; everything else is answered."""
        if 'pi-scaffold:' in last and CONTINUE_MARK not in last and self.child_errors > 0:
            self.child_errors -= 1
            return OVERLOADED
        return None

    # --- helpers -------------------------------------------------------------------------------------------------
    def wait(self, pred, timeout, what):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = pred()
            if v: return v
            time.sleep(1)
        self.fail(f'timed out waiting for {what}\n--- parent screen ---\n{self.screen(self.parent)[-3000:]}')

    def screen(self, pane):
        r = self.herdr('pane', 'read', pane, '--source', 'recent', '--lines', '200', check=False)
        return r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)

    def watches(self):
        p = self.agent / 'pi-scaffold/state/watches.json'
        return json.loads(p.read_text())['watches'] if p.exists() else []

    def continues(self):
        return [r for r in self.requests if CONTINUE_MARK in json.dumps([m for m in r.get('messages', []) if m.get('role') == 'user'][-1:], ensure_ascii=False)]

    def pane_gets(self, pane, since):
        if not self.herdr_log.exists(): return 0
        return sum(1 for line in self.herdr_log.read_text().splitlines() if int(line.split(' ', 1)[0]) >= since and f'pane get {pane}' in line)

    def start_parent_and_hand_off(self):
        self.start_session()
        self.parent = self.herdr('pane', 'list')['result']['panes'][0]['pane_id']
        self.herdr('pane', 'run', self.parent, f'cd {self.repo} && HERDR_BIN_PATH={self.bin}/herdr pi-profile launch --profile developer -- --approve --model owned-fixture/fixture --thinking medium')
        self.wait(lambda: self.herdr('pane', 'get', self.parent)['result']['pane'].get('agent') == 'pi', 60, 'the parent Pi TUI')
        time.sleep(2)
        self.herdr('agent', 'prompt', self.parent, 'OWNED_TOOL_REQUEST')
        watch = self.wait(lambda: self.watches(), 180, 'the handed-off pane to be registered for watching')
        self.assertEqual(len(watch), 1, watch)
        self.child = watch[0]['entry']['paneId']
        self.assertNotEqual(self.child, self.parent)

    # --- cases ---------------------------------------------------------------------------------------------------
    def test_transient_error_gets_one_continue_and_reload_keeps_one_timer(self):
        self.start_parent_and_hand_off()
        # Reload the parent before the watch acts: the old timer must stop and exactly one must resume.
        self.herdr('pane', 'run', self.parent, '/reload')
        self.wait(lambda: self.continues(), 300, 'the automatic continue')
        self.assertEqual(self.child_errors, 0, 'the child really stopped on the transient error first')
        self.wait(lambda: '自動で再開を送りました（1/3回目）' in self.screen(self.parent), 60, 'the parent notice of the continue')
        self.assertIn('一時的なエラーで止まっています', self.screen(self.parent))
        # Count the watch's checks of the child pane for three minutes: one timer makes ~3, two would make ~6.
        since = int(time.time()); time.sleep(185)
        checks = self.pane_gets(self.child, since)
        self.assertGreaterEqual(checks, 2, 'the watch kept checking')
        self.assertLessEqual(checks, 4, f'{checks} checks in 185 s: more than one watch timer is running')
        self.assertEqual(len(self.continues()), 1, 'exactly one continue was sent')

    def test_new_session_in_child_ends_the_watch_without_sending(self):
        self.start_parent_and_hand_off()
        self.wait(lambda: any(w['progress'].get('pendingRetryAt') for w in self.watches()), 180, 'the continue to be scheduled')
        self.herdr('pane', 'run', self.child, '/new')
        self.wait(lambda: not self.watches(), 180, 'the watch to end after /new')
        self.assertIn('別のセッションが動いています', self.screen(self.parent))
        time.sleep(70)  # past the scheduled time: nothing may be sent
        self.assertEqual(self.continues(), [], 'no continue reached the child')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pi', default=str(ROOT / 'node_modules/.bin/pi'))
    parser.add_argument('--pi-gh', required=True)
    parser.add_argument('--pi-profile', required=True)
    parser.add_argument('--case')
    native.OPTIONS = parser.parse_args()
    names = ['test_' + native.OPTIONS.case] if native.OPTIONS.case else ['test_transient_error_gets_one_continue_and_reload_keeps_one_timer', 'test_new_session_in_child_ends_the_watch_without_sending']
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(WatchAcceptance(n) for n in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
