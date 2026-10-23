import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOfAgentDir, resolveBrowserAccount} from '../src/core/browser-account.js';

test('browser account: the session value wins when it is a known account', () => {
  assert.equal(resolveBrowserAccount({PI_BROWSER_ACCOUNT: 'rbx'}, '/h/.pi/agent'), 'rbx');
  assert.equal(resolveBrowserAccount({PI_BROWSER_ACCOUNT: 'evil; rm'}, '/h/.pi/agent-muu'), 'muu');
});

test('browser account: the agent directory decides when the session has none, and kuno is the fallback', () => {
  assert.equal(resolveBrowserAccount({}, '/h/.pi/agent'), 'kuno');
  assert.equal(resolveBrowserAccount({}, '/h/.pi/agent-muu'), 'muu');
  assert.equal(resolveBrowserAccount({}, '/h/.pi/agent-rbx'), 'rbx');
  assert.equal(resolveBrowserAccount({}, '/h/.pi/agent-other'), 'kuno');
  assert.equal(resolveBrowserAccount({}, '/tmp/agent-rbx'), 'kuno');
  assert.equal(resolveBrowserAccount({}), 'kuno');
  assert.equal(accountOfAgentDir('/tmp/agent-rbx'), undefined);
});
