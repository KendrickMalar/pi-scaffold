// In-memory stand-in for a loaded pi-gh 0.2.0 reached through ctx.executeTool(). Fictional data only.
import type {ToolExecutor, ToolOutcome} from '../../src/ports/pi-gh.js';

export const PI_GH_020_OPERATIONS = [
  'gh_issue_validate', 'gh_issue_preview', 'gh_issue_submit', 'gh_labels_validate', 'gh_labels_preview', 'gh_labels_apply', 'gh_issue_form',
  'gh_issue_get', 'gh_issue_list', 'gh_subissues_list', 'gh_dependencies_list', 'gh_project_get', 'gh_project_items',
  'gh_issue_edit', 'gh_issue_close', 'gh_subissue_add', 'gh_dependency_add', 'gh_project_add_issue', 'gh_project_field_update', 'gh_capabilities',
];
export const READ_TOOLS = new Set(['gh_capabilities', 'gh_issue_get', 'gh_issue_list', 'gh_subissues_list', 'gh_dependencies_list', 'gh_project_get', 'gh_project_items', 'gh_issue_validate', 'gh_issue_preview', 'gh_labels_validate', 'gh_labels_preview', 'gh_issue_form']);

export interface FakeIssue { number: number; title: string; body: string; labels: string[]; state: 'open' | 'closed'; subIssues?: number[] }
type Override = (args: unknown, call: number) => ToolOutcome | Promise<ToolOutcome> | undefined;

export class FakePiGh {
  readonly calls: {name: string; args: unknown}[] = [];
  readonly issues = new Map<number, FakeIssue>();
  operations = [...PI_GH_020_OPERATIONS];
  contractVersion: unknown = 1;
  loaded = true;
  readonly overrides = new Map<string, Override>();
  constructor(readonly repo = 'example/demo') {}

  get writes() { return this.calls.filter(c => !READ_TOOLS.has(c.name)).length; }
  count(name: string) { return this.calls.filter(c => c.name === name).length; }
  add(issue: FakeIssue) { this.issues.set(issue.number, issue); return this; }
  enableProposals() { this.operations.push('gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current'); return this; }

  static ok(data: unknown, status = 'read'): ToolOutcome { return {result: {content: [{type: 'text', text: JSON.stringify({status, data})}], structuredContent: {status, data}}, isError: false}; }
  static err(status: string, code = 'GITHUB_READ'): ToolOutcome { return {result: {content: [], structuredContent: {status, problems: [{code, path: '', message: code}]}}, isError: true}; }

  readonly execute: ToolExecutor = async (name, args) => {
    this.calls.push({name, args});
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
    return FakePiGh.ok({repo: this.repo}, 'applied');
  };

  github(i: FakeIssue) {
    return {
      id: 1000 + i.number, node_id: `I_example${i.number}`, number: i.number, title: i.title, body: i.body, state: i.state,
      labels: i.labels.map((name, k) => ({id: k + 1, name, color: '000000'})),
      html_url: `https://github.com/${this.repo}/issues/${i.number}`,
    };
  }
}
