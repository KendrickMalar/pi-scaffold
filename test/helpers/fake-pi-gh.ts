// In-memory stand-in for a loaded pi-gh 0.2.0 reached through ctx.executeTool(). Fictional data only.
import {readFileSync} from 'node:fs';
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

export interface FakeIssue { number: number; title: string; body: string; labels: string[]; state: 'open' | 'closed'; subIssues?: number[] }
type Override = (args: unknown, call: number) => ToolOutcome | Promise<ToolOutcome> | undefined;

export class FakePiGh {
  readonly calls: {name: string; args: unknown}[] = [];
  readonly issues = new Map<number, FakeIssue>();
  operations = [...PI_GH_WITH_LABELS_LIST];
  contractVersion: unknown = 1;
  loaded = true;
  readonly overrides = new Map<string, Override>();
  /** Repository labels keyed by lower-case name, like GitHub. */
  readonly labels = new Map<string, FakeLabel & {id: number}>();
  readonly labelChanges: {operation: string; name?: string; issue?: number}[] = [];
  onCall?: (name: string) => void;
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
    if (name === 'gh_capabilities') return FakePiGh.ok({contractVersion: this.contractVersion, operations: this.operations});
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
    if (name === 'gh_labels_list') return FakePiGh.ok({repo: a.repo, labels: [...this.labels.values()].map(({name, color, description}) => ({name, color, description})).sort((x, y) => x.name < y.name ? -1 : 1)});
    if (name === 'gh_labels_preview' || name === 'gh_labels_apply') return this.label(name, args as {changePath: string});
    return FakePiGh.ok({repo: this.repo}, 'applied');
  };

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
