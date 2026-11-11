import test from 'node:test';
import assert from 'node:assert/strict';
import {createStrictReader} from '../src/orchestrator-wait/herdr.js';

const PANES = '{"result":{"panes":[{"pane_id":"w2:p1","revision":1,"agent":"claude","agent_status":"working","tab_id":"w2:t1"}]}}';
const TABS = '{"result":{"tabs":[{"tab_id":"w2:t1","label":"design-e12"}]}}';

test('createStrictReader labels panes from tab list', async () => {
  const r = createStrictReader({run: async args => (args[0] === 'pane' ? PANES : TABS)});
  assert.deepEqual((await r.panes('/s/a.sock')).map(p => p.tabLabel), ['design-e12']);
});

test('createStrictReader fails the socket when tab list fails', async () => {
  const r = createStrictReader({run: async args => { if (args[0] === 'tab') throw new Error('timeout'); return PANES; }});
  await assert.rejects(r.panes('/s/a.sock'));
});

test('createStrictReader fails the socket when tab list is unreadable', async () => {
  const r = createStrictReader({run: async args => (args[0] === 'pane' ? PANES : 'nope')});
  await assert.rejects(r.panes('/s/a.sock'));
});

test('createStrictReader passes the socket to herdr', async () => {
  const seen: (string | undefined)[] = [];
  const r = createStrictReader({run: async (args, socket) => { seen.push(socket); return args[0] === 'session' ? '{"sessions":[{"running":true,"socket_path":"/s/a.sock"}]}' : args[0] === 'pane' ? PANES : TABS; }});
  assert.deepEqual(await r.sockets(), ['/s/a.sock']);
  await r.panes('/s/b.sock');
  assert.deepEqual(seen, [undefined, '/s/b.sock', '/s/b.sock']);
});
