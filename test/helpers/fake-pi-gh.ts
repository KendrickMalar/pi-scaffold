// In-memory stand-in for a loaded pi-gh 0.2.0 reached through ctx.executeTool(). Fictional data only.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
export const labelsSha = (names: string[]) => sha(JSON.stringify([...names].sort()));
import type {ToolExecutor, ToolOutcome} from '../../src/ports/pi-gh.js';

export interface FakeLabel { name: string; color: string; description: string }

export const PI_GH_020_OPERATIONS = [
  'gh_issue_validate', 'gh_issue_preview', 'gh_issue_submit', 'gh_labels_validate', 'gh_labels_preview', 'gh_labels_apply', 'gh_issue_form',
  'gh_issue_get', 'gh_issue_list', 'gh_subissues_list', 'gh_dependencies_list', 'gh_project_get', 'gh_project_items',
  'gh_issue_edit', 'gh_issue_close', 'gh_subissue_add', 'gh_dependency_add', 'gh_project_add_issue', 'gh_project_field_update', 'gh_capabilities',
];
/** pi-gh with the B4 addition (KendrickMalar/pi-gh#5). */
export const PI_GH_WITH_LABELS_LIST = [...PI_GH_020_OPERATIONS, 'gh_labels_list'];
export const READ_TOOLS = new Set(['gh_labels_list', 'gh_capabilities', 'gh_issue_get', 'gh_issue_list', 'gh_subissues_list', 'gh_dependencies_list', 'gh_project_get', 'gh_project_items', 'gh_issue_validate', 'gh_issue_preview', 'gh_labels_validate', 'gh_labels_preview', 'gh_issue_form']);

export interface FakeIssue { number: number; title: string; body: string; labels: string[]; state: 'open' | 'closed'; subIssues?: number[]; blockedBy?: (number | string)[] }
type Override = (args: unknown, call: number) => ToolOutcome | Promise<ToolOutcome> | undefined;

export class FakePiGh {
  readonly calls: {name: string; args: unknown}[] = [];
  readonly issues = new Map<number, FakeIssue>();
  operations = [...PI_GH_WITH_LABELS_LIST];
  contractVersion: unknown = 1;
  features: string[] = ['issue-list-labels'];
  loaded = true;
  readonly overrides = new Map<string, Override>();
  /** Repository labels keyed by lower-case name, like GitHub. */
  readonly labels = new Map<string, FakeLabel & {id: number}>();
  readonly labelChanges: {operation: string; name?: string; issue?: number}[] = [];
  onCall?: (name: string) => void;
  readonly submitted: {draft: Record<string, unknown>; number: number}[] = [];
  readonly conditionalChanges: {operation: string; issue: number}[] = [];
  /** Projects V2 by node id; items are Issue numbers of this repository. */
  readonly projects = new Map<string, number[]>();
  constructor(readonly repo = 'example/demo') {}

  get writes() { return this.calls.filter(c => !READ_TOOLS.has(c.name)).length; }
  count(name: string) { return this.calls.filter(c => c.name === name).length; }
  add(issue: FakeIssue) { this.issues.set(issue.number, issue); return this; }
  seedLabels(labels: FakeLabel[]) { for (const l of labels) this.labels.set(l.name.toLowerCase(), {...l, color: l.color.toLowerCase(), id: this.labels.size + 1}); return this; }
  enableProposals() { this.operations.push('gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current'); return this; }

  static ok(data: unknown, status = 'read'): ToolOutcome { return {result: {content: [{type: 'text', text: JSON.stringify({status, data})}], structuredContent: {status, data}}, isError: false}; }
  static err(status: string, code = 'GITHUB_READ'): ToolOutcome { return {result: {content: [], structuredContent: {status, problems: [{code, path: '', message: code}]}}, isError: true}; }

  readonly execute: ToolExecutor = async (name, args) => {
    this.calls.push({name, args});
    this.onCall?.(name);
    if (!this.loaded) return {result: {content: [{type: 'text', text: `Tool ${name} not found`}]}, isError: true};
    const override = this.overrides.get(name);
    if (override) { const r = await override(args, this.count(name)); if (r) return r; }
    if (name === 'gh_capabilities') return FakePiGh.ok({contractVersion: this.contractVersion, operations: this.operations, features: this.features});
    if (!this.operations.includes(name)) return {result: {content: [{type: 'text', text: `Tool ${name} not found`}]}, isError: true};
    const a = args as {repo: string; issue: number};
    if (name === 'gh_issue_get') {
      const i = this.issues.get(a.issue);
      if (!i || a.repo !== this.repo) return FakePiGh.err('rejected');
      return FakePiGh.ok(this.github(i));
    }
    if (name === 'gh_subissues_list') {
      const i = this.issues.get(a.issue);
      if (!i) return FakePiGh.err('rejected');
      return FakePiGh.ok((i.subIssues ?? []).map(n => this.github(this.issues.get(n)!)));
    }
    if (name === 'gh_issue_list') {
      const filter = (args as {labels?: string[]}).labels;
      if (filter && !this.features.includes('issue-list-labels')) return FakePiGh.err('rejected', 'ARGUMENT');
      return FakePiGh.ok([...this.issues.values()].filter(i => !filter || filter.every(l => i.labels.includes(l))).sort((x, y) => x.number - y.number).map(i => this.github(i)));
    }
    if (name === 'gh_issue_validate' || name === 'gh_issue_preview' || name === 'gh_issue_submit') return this.issue(name, args as {draftPath: string; templatePath: string});
    if (name === 'gh_dependencies_list') {
      // blocked_by of the issue; a string entry stands for an Issue of another repository (html_url).
      const i = this.issues.get(a.issue);
      if (!i) return FakePiGh.err('rejected');
      return FakePiGh.ok((i.blockedBy ?? []).map(b => typeof b === 'string' ? {number: 1, html_url: b} : this.github(this.issues.get(b)!)));
    }
    if (name === 'gh_dependency_add' || name === 'gh_project_add_issue') {
      const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8')) as Record<string, unknown>;
      const allowed = name === 'gh_dependency_add' ? ['version', 'repo', 'operation', 'issue', 'relatedIssue'] : ['version', 'repo', 'operation', 'issue', 'projectId'];
      if (Object.keys(c).some(k => !allowed.includes(k)) || c.repo !== this.repo) return FakePiGh.err('rejected', 'UNKNOWN_KEY');
      const target = this.issues.get(c.issue as number);
      if (!target) return FakePiGh.err('rejected', 'ARGUMENT');
      if (name === 'gh_dependency_add') {
        // pi-gh: `issue` is blocked by `relatedIssue`.
        if (c.operation !== 'dependency-add' || !this.issues.has(c.relatedIssue as number) || c.relatedIssue === c.issue) return FakePiGh.err('rejected', 'ARGUMENT');
        if ((target.blockedBy ?? []).includes(c.relatedIssue as number)) return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
        target.blockedBy = [...(target.blockedBy ?? []), c.relatedIssue as number];
        return FakePiGh.ok({issue: target.number}, 'applied');
      }
      const items = this.projects.get(c.projectId as string);
      if (c.operation !== 'project-add-issue' || !items) return FakePiGh.err('rejected', 'GITHUB_IDENTITY');
      if (items.includes(target.number)) return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
      items.push(target.number);
      return FakePiGh.ok({projectId: c.projectId, itemId: `PVTI_${target.number}`}, 'applied');
    }
    if (name === 'gh_project_items') {
      const items = this.projects.get((args as {projectId: string}).projectId);
      if (!items) return FakePiGh.err('rejected', 'GITHUB_IDENTITY');
      return FakePiGh.ok({id: (args as {projectId: string}).projectId, title: 'Fixture', items: items.map(n => ({id: `PVTI_${n}`, content: {__typename: 'Issue', id: `I_${n}`, number: n, repository: {nameWithOwner: this.repo}}}))});
    }
    if (name === 'gh_subissue_add') {
      // pi-gh 0.5.0: {version, repo, operation:'subissue-add', issue (parent), relatedIssue (child)}; noop when already attached.
      const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8')) as Record<string, unknown>;
      if (Object.keys(c).some(k => !['version', 'repo', 'operation', 'issue', 'relatedIssue'].includes(k))) return FakePiGh.err('rejected', 'UNKNOWN_KEY');
      const parent = this.issues.get(c.issue as number), child = this.issues.get(c.relatedIssue as number);
      if (c.repo !== this.repo || c.operation !== 'subissue-add' || !parent || !child || parent === child) return FakePiGh.err('rejected', 'ARGUMENT');
      if ((parent.subIssues ?? []).includes(child.number)) return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
      parent.subIssues = [...(parent.subIssues ?? []), child.number];
      return FakePiGh.ok({issue: parent.number, relatedIssue: child.number}, 'applied');
    }
    if (name === 'gh_issue_edit_if_current' || name === 'gh_issue_labels_if_current' || name === 'gh_issue_close_if_current') return this.conditional(name, args as {changePath: string});
    if (name === 'gh_labels_list') return FakePiGh.ok({repo: a.repo, labels: [...this.labels.values()].map(({name, color, description}) => ({name, color, description})).sort((x, y) => x.name < y.name ? -1 : 1)});
    if (name === 'gh_labels_preview' || name === 'gh_labels_apply') return this.label(name, args as {changePath: string});
    return FakePiGh.ok({repo: this.repo}, 'applied');
  };

  /** pi-gh 0.5.0 *_if_current semantics: desired state → noop, then precondition, then apply. */
  private conditional(name: string, args: {changePath: string}): ToolOutcome {
    const c = JSON.parse(readFileSync(args.changePath, 'utf8')) as {repo: string; operation: string; issue: number; body?: string; add?: string[]; remove?: string[]; expectedBodySha256?: string; expectedLabelsSha256?: string};
    const i = this.issues.get(c.issue);
    if (!i || c.repo !== this.repo || c.operation !== name.replace(/^gh_/, '').replace(/_/g, '-')) return FakePiGh.err('rejected', 'ARGUMENT');
    // Like pi-gh 0.5.0, a change file with any key outside its contract is rejected (UNKNOWN_KEY).
    const allowed = {'issue-edit-if-current': ['body', 'expectedBodySha256'], 'issue-labels-if-current': ['add', 'remove', 'expectedLabelsSha256'], 'issue-close-if-current': ['expectedBodySha256', 'reason']}[c.operation] ?? [];
    if (Object.keys(c).some(k => !['version', 'repo', 'operation', 'issue', ...allowed].includes(k))) return FakePiGh.err('rejected', 'UNKNOWN_KEY');
    if (c.operation === 'issue-edit-if-current') {
      if (i.body === c.body) return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
      if (sha(i.body) !== c.expectedBodySha256) return FakePiGh.err('rejected', 'PRECONDITION_FAILED');
      i.body = c.body!;
    } else if (c.operation === 'issue-labels-if-current') {
      const remove = new Set((c.remove ?? []).map(l => l.toLowerCase()));
      const desired = [...i.labels.filter(l => !remove.has(l.toLowerCase())), ...(c.add ?? []).filter(a => !i.labels.some(l => l.toLowerCase() === a.toLowerCase()))];
      if (JSON.stringify([...desired].sort()) === JSON.stringify([...i.labels].sort())) return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
      if (labelsSha(i.labels) !== c.expectedLabelsSha256) return FakePiGh.err('rejected', 'PRECONDITION_FAILED');
      i.labels = desired;
    } else {
      if (i.state === 'closed') return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false};
      if (sha(i.body) !== c.expectedBodySha256) return FakePiGh.err('rejected', 'PRECONDITION_FAILED');
      i.state = 'closed';
    }
    this.conditionalChanges.push({operation: c.operation, issue: c.issue});
    return FakePiGh.ok({repo: this.repo, operation: name}, 'applied');
  }

  /** Mirrors pi-gh 0.3.0 validateDraft/renderIssue closely enough for pi-scaffold tests (fictional data only). */
  private issue(name: string, args: {draftPath: string; templatePath: string}): ToolOutcome {
    const draft = JSON.parse(readFileSync(args.draftPath, 'utf8')) as {template: string; repo: string; title: string; labels?: string[]; parentIssue?: number; fields: Record<string, string>; agents: Record<string, {model: string; thinking: string; reason: string}>};
    const template = readFileSync(args.templatePath, 'utf8');
    const id = /^id: (.+)$/m.exec(template)?.[1], kind = /^kind: (.+)$/m.exec(template)?.[1];
    if (draft.template !== id) return FakePiGh.err('rejected', 'DRAFT_TEMPLATE');
    if (kind === 'parent' && draft.parentIssue !== undefined) return FakePiGh.err('rejected', 'DRAFT_PARENT');
    if (kind === 'task' && !draft.parentIssue) return FakePiGh.err('rejected', 'DRAFT_PARENT');
    if (!draft.title?.trim() || /[\r\n]/.test(draft.title)) return FakePiGh.err('rejected', 'DRAFT_TITLE');
    const policy = JSON.parse(readFileSync(args.templatePath.replace(/[^/]+$/, 'models.yml'), 'utf8')) as {agents: Record<string, {model: string; thinking: string}[]>};
    for (const [role, a] of Object.entries(draft.agents)) if (!policy.agents[role]?.some(p => p.model === a.model && p.thinking === a.thinking)) return FakePiGh.err('rejected', 'AGENT_PROFILE');
    if (name === 'gh_issue_validate') return {result: {content: [], structuredContent: {status: 'validated'}}, isError: false};
    for (const l of draft.labels ?? []) if (!this.labels.has(l.toLowerCase())) return FakePiGh.err('rejected', 'LABEL_MISSING');
    const labels = [...template.matchAll(/^    label: (.+)$/gm)].map(m => m[1]!);
    const fieldIds = [...template.matchAll(/^  - id: (.+)$/gm)].map(m => m[1]!);
    const blocks = fieldIds.map((f, i) => `## ${labels[i]}\n\n${draft.fields[f]}`);
    blocks.push('## 担当モデル\n\n' + Object.entries(draft.agents).map(([n, a]) => `- ${n}: \`${a.model}\` / \`${a.thinking}\`\n  - 選定理由: ${a.reason}`).join('\n'));
    const body = blocks.join('\n\n') + '\n';
    if (name === 'gh_issue_preview') return FakePiGh.ok({repo: draft.repo, title: draft.title, body, labels: draft.labels ?? []}, 'preview');
    const number = Math.max(9, ...this.issues.keys()) + 1;
    this.add({number, title: draft.title, body, labels: (draft.labels ?? []).map(l => this.labels.get(l.toLowerCase())!.name), state: 'open'});
    this.submitted.push({draft: draft as unknown as Record<string, unknown>, number});
    return FakePiGh.ok({url: `https://github.com/${this.repo}/issues/${number}`}, 'created');
  }

  private label(name: string, args: {changePath: string}): ToolOutcome {
    const change = JSON.parse(readFileSync(args.changePath, 'utf8')) as {repo: string; operation: string; name?: string; newName?: string; color?: string; description?: string; issue?: number};
    if (change.repo !== this.repo) return FakePiGh.err('rejected', 'LABEL_REPO');
    const key = (change.name ?? '').toLowerCase(), before = this.labels.get(key);
    if (name === 'gh_labels_preview') {
      if (change.operation !== 'label-edit') return FakePiGh.err('rejected', 'UNSUPPORTED_IN_FAKE');
      if (!before) return FakePiGh.err('rejected', 'LABEL_MISSING');
      const after = {...before, name: change.newName ?? before.name, color: change.color?.toLowerCase() ?? before.color, description: change.description ?? before.description};
      return FakePiGh.ok({repo: this.repo, operation: 'label-edit', before, after, affected: [], noop: JSON.stringify(before) === JSON.stringify(after), digest: 'f'.repeat(64), sensitive: false}, 'preview');
    }
    this.labelChanges.push({operation: change.operation, ...(change.name !== undefined ? {name: change.name} : {}), ...(change.issue !== undefined ? {issue: change.issue} : {})});
    if (change.operation === 'label-create') {
      if (before) return FakePiGh.err('rejected', 'LABEL_EXISTS');
      this.labels.set(key, {name: change.name!, color: change.color!.toLowerCase(), description: change.description ?? '', id: this.labels.size + 1});
      return {result: {content: [], structuredContent: {status: 'applied'}}, isError: false};
    }
    if (change.operation === 'label-edit') {
      if (!before) return FakePiGh.err('rejected', 'LABEL_MISSING');
      this.labels.delete(key);
      this.labels.set((change.newName ?? before.name).toLowerCase(), {...before, name: change.newName ?? before.name, color: change.color?.toLowerCase() ?? before.color, description: change.description ?? before.description});
      return {result: {content: [], structuredContent: {status: 'applied'}}, isError: false};
    }
    return FakePiGh.err('rejected', 'UNSUPPORTED_IN_FAKE');
  }

  github(i: FakeIssue) {
    return {
      id: 1000 + i.number, node_id: `I_example${i.number}`, number: i.number, title: i.title, body: i.body, state: i.state,
      labels: i.labels.map((name, k) => ({id: k + 1, name, color: '000000'})),
      html_url: `https://github.com/${this.repo}/issues/${i.number}`,
    };
  }
}
