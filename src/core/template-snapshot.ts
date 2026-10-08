// Copies a bundled pi-gh Issue template into an owned directory together with a model policy built only from
// the given bindings (relative `models.yml`). No owner settings or secrets are copied.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeOwnedFile} from './files.js';
import {sha256Text} from './digests.js';
import type {ModelBinding} from './contracts.js';

export type TemplateKind = 'epic' | 'feature' | 'task';
export const TEMPLATE_ROLES: Record<TemplateKind, readonly string[]> = {
  epic: ['planner'], feature: ['coding-manager', 'coder', 'tester'], task: ['coder', 'tester'],
};
export const TEMPLATE_IDS: Record<TemplateKind, string> = {epic: 'scaffold-epic-v1', feature: 'scaffold-feature-v1', task: 'scaffold-task-v1'};
export const TEMPLATE_FIELD = 'scaffold';
export interface TemplateSnapshot { kind: TemplateKind; templateId: string; templatePath: string; policyPath: string; templateSha256: string; policySha256: string }

export function bundledTemplate(kind: TemplateKind): string {
  return readFileSync(new URL(`../../../resources/templates/${TEMPLATE_IDS[kind]}.yml`, import.meta.url), 'utf8');
}

/** Bindings must name exactly the template's roles. Every tuple is recorded as tier basic. */
export async function buildTemplateSnapshot(kind: TemplateKind, bindings: Record<string, ModelBinding>, dir: string, root: string): Promise<TemplateSnapshot> {
  const roles = TEMPLATE_ROLES[kind];
  const missing = roles.filter(r => !bindings[r]), extra = Object.keys(bindings).filter(r => !roles.includes(r));
  if (missing.length || extra.length) throw new Error(`Template ${TEMPLATE_IDS[kind]} needs bindings for ${roles.join(', ')} (missing: ${missing.join(', ') || 'none'}, unexpected: ${extra.join(', ') || 'none'}).`);
  const template = bundledTemplate(kind);
  const policy = JSON.stringify({version: 1, agents: Object.fromEntries(roles.map(r => [r, [{model: bindings[r]!.model, thinking: bindings[r]!.thinking, tier: 'basic'}]]))}, null, 2) + '\n';
  const templatePath = join(dir, `${TEMPLATE_IDS[kind]}.yml`), policyPath = join(dir, 'models.yml');
  await writeOwnedFile(templatePath, template, {root});
  await writeOwnedFile(policyPath, policy, {root});
  return {kind, templateId: TEMPLATE_IDS[kind], templatePath, policyPath, templateSha256: sha256Text(template), policySha256: sha256Text(policy)};
}
