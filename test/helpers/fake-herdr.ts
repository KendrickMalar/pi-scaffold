// In-memory Herdr 0.9.1 for handoff tests. Never touches a real Herdr session.
import type {HerdrPort} from '../../src/handoff/herdr-client.js';
import {HerdrError} from '../../src/handoff/herdr-client.js';

export class FakeHerdr implements HerdrPort {
  readonly calls: {command: string; args: unknown}[] = [];
  version_ = {version: '0.9.1', protocol: 22};
  pane = {workspaceId: 'w9', paneId: 'w9:pA'};
  readonly tabs: {tabId: string; label: string; paneId: string; cwd: string}[] = [];
  onPaneRun?: (paneId: string, command: string) => Promise<void> | void;
  onPrompt?: (paneId: string, text: string) => Promise<void> | void;
  fail: Partial<Record<'tabCreate' | 'paneRun' | 'agentPrompt', 'unknown' | 'not-started' | 'unknown-before'>> = {};
  shellReady = true;

  get tabCreates() { return this.calls.filter(c => c.command === 'tabCreate').length; }
  count(command: string) { return this.calls.filter(c => c.command === command).length; }
  async version() { this.calls.push({command: 'version', args: {}}); return this.version_; }
  async currentPane() { this.calls.push({command: 'currentPane', args: {}}); return {...this.pane}; }
  async tabCreate(o: {workspaceId: string; cwd: string; label: string}) {
    this.calls.push({command: 'tabCreate', args: o});
    const n = this.tabs.length + 2, tab = {tabId: `${o.workspaceId}:t${n}`, label: o.label, paneId: `${o.workspaceId}:p${n}`, cwd: o.cwd};
    if (this.fail.tabCreate === 'not-started') throw new HerdrError('not-started', 'tab create did not start');
    if (this.fail.tabCreate === 'unknown-before') throw new HerdrError('unknown', 'reply lost before the tab existed');
    this.tabs.push(tab);
    if (this.fail.tabCreate === 'unknown') throw new HerdrError('unknown', 'reply lost');
    return {tabId: tab.tabId, paneId: tab.paneId};
  }
  async tabList(workspaceId: string) { this.calls.push({command: 'tabList', args: {workspaceId}}); return this.tabs.map(t => ({tabId: t.tabId, label: t.label, paneId: t.paneId})); }
  async processInfo(paneId: string) { this.calls.push({command: 'processInfo', args: {paneId}}); return {shellReady: this.shellReady}; }
  async paneRun(paneId: string, command: string) {
    this.calls.push({command: 'paneRun', args: {paneId, command}});
    if (this.fail.paneRun) throw new HerdrError(this.fail.paneRun === 'unknown-before' ? 'unknown' : this.fail.paneRun, 'pane run failed');
    await this.onPaneRun?.(paneId, command);
  }
  async agentPrompt(paneId: string, text: string) {
    this.calls.push({command: 'agentPrompt', args: {paneId, text}});
    if (this.fail.agentPrompt) throw new HerdrError(this.fail.agentPrompt === 'unknown-before' ? 'unknown' : this.fail.agentPrompt, 'prompt failed');
    await this.onPrompt?.(paneId, text);
  }
}
