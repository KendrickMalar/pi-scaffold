#!/usr/bin/env node
// Stateful fake `gh api` for native tests. Fictional example/demo data only; never contacts GitHub.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const state = process.env.FAKE_GH_STATE;
let input = '';
if (process.argv.includes('--input')) for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const endpoint = args.find(a => /^repos\//.test(a)) ?? '';
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify({method, endpoint, input}) + '\n');
const out = value => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const fail = message => { process.stderr.write(message + '\n'); process.exit(1); };
if (args[0] !== 'api') fail('unsupported fake command');
const [path, query = ''] = endpoint.split('?');
const params = new URLSearchParams(query);
const labelsFile = join(state, 'labels.json');
const labels = () => existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, 'utf8')) : [];
const page = list => { const n = Number(params.get('page') ?? 1), size = Number(params.get('per_page') ?? 30); return list.slice((n - 1) * size, n * size); };

if (path === 'repos/example/demo' && method === 'GET') out({id: 1, node_id: 'R_example', full_name: 'example/demo', html_url: 'https://github.com/example/demo'});
if (path === 'repos/example/demo/labels') {
  if (method === 'GET') out(page(labels()));
  if (method === 'POST') {
    const body = JSON.parse(input), all = labels();
    if (all.some(l => l.name.toLowerCase() === body.name.toLowerCase())) fail('already_exists');
    const label = {id: all.length + 1, node_id: `LA_${all.length + 1}`, name: body.name, color: body.color.toLowerCase(), description: body.description ?? ''};
    writeFileSync(labelsFile, JSON.stringify([...all, label]));
    appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, label: body}) + '\n');
    out(label);
  }
}
if (path === 'repos/example/demo/issues' && method === 'GET') out(page(existsSync(join(state, 'issue-10.json')) ? [JSON.parse(readFileSync(join(state, 'issue-10.json'), 'utf8'))] : []));
const m = /^repos\/example\/demo\/issues\/(\d+)(?:\/(sub_issues))?$/.exec(path);
if (!m) fail('unsupported fake endpoint ' + endpoint);
const file = join(state, `issue-${m[1]}.json`);
if (!existsSync(file)) fail('not found');
const issue = JSON.parse(readFileSync(file, 'utf8'));
if (m[2] === 'sub_issues') out([]);
if (method === 'PATCH') {
  const delay = Number(process.env.FAKE_GH_DELAY_MS ?? 0);
  if (delay) await new Promise(r => setTimeout(r, delay));
  const patch = JSON.parse(input);
  if (typeof patch.body === 'string') issue.body = patch.body;
  if (typeof patch.title === 'string') issue.title = patch.title;
  writeFileSync(file, JSON.stringify(issue));
  appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, patch}) + '\n');
}
out(issue);
