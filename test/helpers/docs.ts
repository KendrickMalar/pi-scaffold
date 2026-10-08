import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {EpicDocV1, FeatureDocV1} from '../../src/core/contracts.js';

export const fixtureDir = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
export function fixtureText(name: string): string { return readFileSync(fixtureDir + name, 'utf8'); }
export function clone<T>(value: T): T { return structuredClone(value); }

export const WORKFLOW_ID = '11111111-1111-4111-8111-111111111111';
export const CREATE_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
export const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const COMMIT = 'c'.repeat(40);

export function initialDoc(): EpicDocV1 { return JSON.parse(fixtureText('epic-v1.initial.json')) as EpicDocV1; }
export function populatedDoc(): EpicDocV1 { return JSON.parse(fixtureText('epic-v1.populated.json')) as EpicDocV1; }

export function featureDoc(): FeatureDocV1 {
  return {
    version: 1, kind: 'feature', workflowId: WORKFLOW_ID, revision: 1, createOperationId: OPERATION_ID,
    featureKey: 'F001', parentEpic: 10, stage: 'basic-design', purpose: '一覧画面にCSV出力ボタンを追加する。',
    editScope: ['src/export/'], outOfScope: ['PDF出力'],
    designRef: {path: 'docs/design/export.md', sha256: SHA_A, gitRef: COMMIT},
    criteria: [{id: 'AC001', requirementIds: ['REQ001'], verification: 'E2Eテスト', expectedResult: 'CSVがダウンロードされる'}],
    bindings: {
      'coding-manager': {model: 'example-provider/manager-1', thinking: 'medium', reason: '計画の分解'},
      coder: {model: 'example-provider/coder-1', thinking: 'high', reason: '実装'},
      tester: {model: 'example-provider/tester-1', thinking: 'low', reason: '検証'},
    },
    evidenceRefs: [],
  };
}
