#!/usr/bin/env node
// Stateful fake `gh api` for native tests. Fictional example/demo data only; never contacts GitHub.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const state = process.env.FAKE_GH_STATE;
let input = '';
if (process.argv.includes('--input')) for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const endpoint = args.filter(a => !a.startsWith('-')).at(-1);
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify({method, endpoint, input}) + '\n');
const m = /^repos\/example\/demo\/issues\/(\d+)(?:\/(sub_issues))?(?:\?.*)?$/.exec(endpoint ?? '');
if (args[0] !== 'api' || !m) { process.stderr.write('unsupported fake endpoint\n'); process.exit(1); }
const file = join(state, `issue-${m[1]}.json`);
if (!existsSync(file)) { process.stderr.write('not found\n'); process.exit(1); }
const issue = JSON.parse(readFileSync(file, 'utf8'));
if (m[2] === 'sub_issues') { process.stdout.write('[]'); process.exit(0); }
if (method === 'PATCH') {
  const delay = Number(process.env.FAKE_GH_DELAY_MS ?? 0);
  if (delay) await new Promise(r => setTimeout(r, delay));
  const patch = JSON.parse(input);
  if (typeof patch.body === 'string') issue.body = patch.body;
  if (typeof patch.title === 'string') issue.title = patch.title;
  writeFileSync(file, JSON.stringify(issue));
  appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, patch}) + '\n');
}
process.stdout.write(JSON.stringify(issue));
