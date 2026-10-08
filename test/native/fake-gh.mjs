#!/usr/bin/env node
// Stateful fake `gh api` for native tests. Fictional example/demo data only; never contacts GitHub.
import {appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const state = process.env.FAKE_GH_STATE;
let input = '';
if (process.argv.includes('--input')) for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const endpoint = args.find(a => /^repos\//.test(a)) ?? '';
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify({method, endpoint, input}) + '\n');
// Hold one matching call in flight until the test removes the sentinel; records whether the process lived to see the release.
const hold = process.env.FAKE_GH_HOLD;
if (hold && `${method} ${endpoint.split('?')[0]}` === process.env.FAKE_GH_HOLD_MATCH && existsSync(hold)) {
  appendFileSync(hold + '.entered', `${process.pid}\n`);
  while (existsSync(hold)) await new Promise(r => setTimeout(r, 50));
  appendFileSync(hold + '.released', `${process.pid}\n`);
}
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
const issueFiles = () => readdirSync(state).filter(f => /^issue-\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(state, f), 'utf8'))).sort((a, b) => a.number - b.number);
if (path === 'repos/example/demo/issues' && method === 'GET') out(page(issueFiles()));
if (path === 'repos/example/demo/issues' && method === 'POST') {
  const body = JSON.parse(input), all = labels(), number = Math.max(0, ...issueFiles().map(i => i.number)) + 1;
  const issue = {id: 1000 + number, node_id: `I_example${number}`, number, title: body.title, body: body.body, state: 'open', html_url: `https://github.com/example/demo/issues/${number}`,
    labels: (body.labels ?? []).map(n => all.find(l => l.name === n)).filter(Boolean)};
  writeFileSync(join(state, `issue-${number}.json`), JSON.stringify(issue));
  appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, created: number, title: body.title}) + '\n');
  out(issue);
}
const m = /^repos\/example\/demo\/issues\/(\d+)(?:\/(sub_issues))?$/.exec(path);
if (!m) fail('unsupported fake endpoint ' + endpoint);
const file = join(state, `issue-${m[1]}.json`);
if (!existsSync(file)) fail('not found');
const issue = JSON.parse(readFileSync(file, 'utf8'));
if (m[2] === 'sub_issues') {
  // Native sub-issues: stored as numbers on the parent; POST takes the child's REST id like GitHub.
  if (method === 'POST') {
    const child = issueFiles().find(i => i.id === JSON.parse(input).sub_issue_id);
    if (!child) fail('sub-issue not found');
    issue.sub_issues = [...new Set([...(issue.sub_issues ?? []), child.number])];
    writeFileSync(file, JSON.stringify(issue));
    appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, subIssue: child.number}) + '\n');
    out(child);
  }
  out(page((issue.sub_issues ?? []).map(n => JSON.parse(readFileSync(join(state, `issue-${n}.json`), 'utf8')))));
}
if (method === 'PATCH') {
  const delay = Number(process.env.FAKE_GH_DELAY_MS ?? 0);
  if (delay) await new Promise(r => setTimeout(r, delay));
  const patch = JSON.parse(input);
  if (typeof patch.body === 'string') issue.body = patch.body;
  if (typeof patch.title === 'string') issue.title = patch.title;
  if (Array.isArray(patch.labels)) issue.labels = patch.labels.map(n => labels().find(l => l.name === n)).filter(Boolean);
  if (typeof patch.state === 'string') { issue.state = patch.state; issue.state_reason = patch.state_reason ?? null; }
  writeFileSync(file, JSON.stringify(issue));
  appendFileSync(join(state, 'writes.jsonl'), JSON.stringify({endpoint, patch}) + '\n');
}
out(issue);
