import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, decodeMutationInput, decodeScaffoldDoc, decodeEpicDoc, isErrorStatus, parseStableId,
  isUuid, isSha256, isRepoRef, isGitObjectId, type Problem,
} from '../src/core/contracts.js';
import {initialDoc, populatedDoc, featureDoc, clone, OPERATION_ID, SHA_A} from './helpers/docs.js';

const validInput = () => ({repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1, expectedBodySha256: SHA_A});
const paths = (problems: Problem[]) => problems.map(p => p.path);
function rejected<T>(decoded: {ok: true; value: T} | {ok: false; problems: Problem[]}): Problem[] {
  assert.equal(decoded.ok, false, 'expected the value to be rejected');
  return decoded.ok ? [] : decoded.problems;
}

test('valid MutationInput decodes', () => {
  const r = decodeMutationInput(validInput());
  assert.equal(r.ok, true);
});

for (const field of ['repo', 'epicIssue', 'operationId', 'expectedRevision', 'expectedBodySha256'] as const) {
  for (const [label, value] of [['missing', undefined], ['null', null], ['wrong type', {}]] as const) {
    test(`MutationInput.${field} ${label} is rejected with its path`, () => {
      const input: Record<string, unknown> = validInput();
      if (value === undefined) delete input[field]; else input[field] = value;
      assert.ok(paths(rejected(decodeMutationInput(input))).includes(field));
    });
  }
}

test('MutationInput enforces UUID, positive integer, lowercase 64 hex and OWNER/REPO', () => {
  for (const [field, value] of [
    ['operationId', 'not-a-uuid'], ['operationId', 'abcdef01-abcd-4abc-8abc-abcdef012345'.toUpperCase()],
    ['expectedRevision', 0], ['expectedRevision', 1.5], ['expectedRevision', -1],
    ['expectedBodySha256', 'abc'], ['expectedBodySha256', 'A'.repeat(64)],
    ['epicIssue', 0], ['repo', 'example'], ['repo', 'example/demo/extra'], ['repo', ''],
  ] as const) {
    const input: Record<string, unknown> = {...validInput(), [field]: value};
    assert.ok(paths(rejected(decodeMutationInput(input))).includes(field), `${field}=${String(value)}`);
  }
});

test('approval, force and command keys are never accepted', () => {
  for (const key of ['approved', 'force', 'command']) {
    const problems = rejected(decodeMutationInput({...validInput(), [key]: true}));
    assert.ok(paths(problems).includes(key));
    assert.ok(problems.some(p => p.code === 'UNKNOWN_FIELD'));
  }
});

test('id/hash/ref predicates', () => {
  assert.equal(isUuid(OPERATION_ID), true);
  assert.equal(isUuid('11111111-1111-1111-1111-111111111111'), false);
  assert.equal(isSha256(SHA_A), true);
  assert.equal(isSha256(SHA_A.slice(1)), false);
  assert.equal(isRepoRef('example/demo'), true);
  assert.equal(isRepoRef('example/demo.js'), true);
  assert.equal(isRepoRef('../demo'), false);
  assert.equal(isGitObjectId('c'.repeat(40)), true);
  assert.equal(isGitObjectId('c'.repeat(64)), true);
  assert.equal(isGitObjectId('HEAD'), false);
  assert.equal(isGitObjectId('c'.repeat(41)), false);
});

test('stable IDs use a fixed prefix and zero padded positive numbers', () => {
  assert.deepEqual(parseStableId('REQ', 'REQ001'), {prefix: 'REQ', number: 1});
  assert.deepEqual(parseStableId('AC', 'AC1000'), {prefix: 'AC', number: 1000});
  for (const id of ['REQ000', 'REQ01', 'REQ0001', 'AC001', 'req001', 'REQ001 ', 'REQ-001']) assert.equal(parseStableId('REQ', id), undefined, id);
});

test('initial and populated fixtures decode', () => {
  assert.equal(decodeEpicDoc(initialDoc()).ok, true);
  const populated = decodeEpicDoc(populatedDoc());
  assert.equal(populated.ok, true, JSON.stringify(populated.ok ? [] : populated.problems));
  assert.equal(decodeScaffoldDoc(featureDoc()).ok, true);
});

test('doc decoding preserves null versus empty arrays', () => {
  const doc = initialDoc();
  const r = decodeEpicDoc(doc);
  assert.ok(r.ok);
  assert.equal(r.value.constraints, null);
  doc.constraints = [];
  const r2 = decodeEpicDoc(doc);
  assert.ok(r2.ok);
  assert.deepEqual(r2.value.constraints, []);
  assert.equal(r2.value.wavePlan, null);
  assert.equal('featureRefs' in r2.value, false);
});

test('blank required strings are rejected; nullable fields accept null', () => {
  for (const value of ['', '   ']) {
    const doc = initialDoc(); doc.purpose = value;
    assert.ok(paths(rejected(decodeEpicDoc(doc))).includes('purpose'));
  }
  const doc = populatedDoc(); doc.requirements[0]!.description = '  ';
  assert.ok(paths(rejected(decodeEpicDoc(doc))).includes('requirements[0].description'));
  const ok = initialDoc(); ok.background = null;
  assert.equal(decodeEpicDoc(ok).ok, true);
  const blank = initialDoc(); blank.background = ' ';
  assert.ok(paths(rejected(decodeEpicDoc(blank))).includes('background'));
});

test('duplicate IDs, wrong prefixes and unknown versions are rejected', () => {
  const dup = populatedDoc(); dup.requirements[1]!.id = 'REQ001';
  assert.ok(rejected(decodeEpicDoc(dup)).some(p => p.code === 'DUPLICATE_ID'));
  const kind = populatedDoc(); kind.requirements[0]!.id = 'AC001';
  assert.ok(paths(rejected(decodeEpicDoc(kind))).includes('requirements[0].id'));
  const version = initialDoc() as unknown as Record<string, unknown>; version.version = 2;
  assert.ok(rejected(decodeScaffoldDoc(version)).some(p => p.code === 'UNKNOWN_VERSION'));
  const unknownKey = initialDoc() as unknown as Record<string, unknown>; unknownKey.featureRefs = [];
  assert.ok(paths(rejected(decodeEpicDoc(unknownKey))).includes('featureRefs'));
});

test('criteria must reference existing requirements without duplicates', () => {
  const missing = populatedDoc(); missing.criteria[0]!.requirementIds = ['REQ009'];
  assert.ok(paths(rejected(decodeEpicDoc(missing))).includes('criteria[0].requirementIds[0]'));
  const empty = populatedDoc(); empty.criteria[0]!.requirementIds = [];
  assert.ok(paths(rejected(decodeEpicDoc(empty))).includes('criteria[0].requirementIds'));
  const twice = populatedDoc(); twice.criteria[0]!.requirementIds = ['REQ001', 'REQ001'];
  assert.ok(paths(rejected(decodeEpicDoc(twice))).includes('criteria[0].requirementIds[1]'));
  const noVerification = populatedDoc() as unknown as {criteria: Record<string, unknown>[]};
  delete noVerification.criteria[0]!.verification;
  assert.ok(paths(rejected(decodeEpicDoc(noVerification))).includes('criteria[0].verification'));
});

test('answered questions require a source; unanswered may have none', () => {
  const answered = populatedDoc(); answered.questions[0]!.sourceRef = null;
  assert.ok(paths(rejected(decodeEpicDoc(answered))).includes('questions[0].sourceRef'));
  const blank = populatedDoc(); blank.questions[0]!.sourceRef = '  ';
  assert.ok(paths(rejected(decodeEpicDoc(blank))).includes('questions[0].sourceRef'));
  const unanswered = populatedDoc(); unanswered.questions[1]!.answer = null; unanswered.questions[1]!.sourceRef = null;
  assert.equal(decodeEpicDoc(unanswered).ok, true);
});

test('research state invariants', () => {
  const resolved = populatedDoc(); resolved.research[0]!.evidenceRefs = [];
  assert.ok(paths(rejected(decodeEpicDoc(resolved))).includes('research[0].evidenceRefs'));
  const noClaim = populatedDoc(); noClaim.research[2]!.claim = null;
  assert.ok(paths(rejected(decodeEpicDoc(noClaim))).includes('research[2].claim'));
  const wrongClaim = populatedDoc(); wrongClaim.research[2]!.claim!.researchId = 'R001';
  assert.ok(paths(rejected(decodeEpicDoc(wrongClaim))).includes('research[2].claim.researchId'));
  const missing = populatedDoc() as unknown as {research: Record<string, unknown>[]};
  delete missing.research[1]!.doneCondition;
  assert.ok(paths(rejected(decodeEpicDoc(missing))).includes('research[1].doneCondition'));
});

test('collection limits are inclusive', () => {
  const at = initialDoc();
  at.requirements = Array.from({length: LIMITS.requirements}, (_, i) => ({id: `REQ${String(i + 1).padStart(3, '0')}`, description: 'x'}));
  assert.equal(decodeEpicDoc(at).ok, true);
  const over = clone(at); over.requirements.push({id: 'REQ101', description: 'x'});
  assert.ok(rejected(decodeEpicDoc(over)).some(p => p.code === 'LIMIT_EXCEEDED' && p.path === 'requirements'));
  const research = initialDoc();
  research.research = Array.from({length: LIMITS.research + 1}, (_, i) => ({researchId: `R${String(i + 1).padStart(3, '0')}`, question: 'q', requiredEvidence: 'e', doneCondition: 'd', state: 'pending' as const, claim: null, conclusion: null, evidenceRefs: [], limitations: []}));
  assert.ok(rejected(decodeEpicDoc(research)).some(p => p.code === 'LIMIT_EXCEEDED' && p.path === 'research'));
});

test('wave plan waves are integers from 1 to 200', () => {
  for (const wave of [0, 201, 1.5, '1']) {
    const doc = populatedDoc(); (doc.wavePlan!.assignments[0] as {wave: unknown}).wave = wave;
    assert.ok(paths(rejected(decodeEpicDoc(doc))).includes('wavePlan.assignments[0].wave'), String(wave));
  }
  for (const wave of [1, 200]) {
    const doc = populatedDoc(); doc.wavePlan!.assignments[0]!.wave = wave;
    assert.equal(decodeEpicDoc(doc).ok, true);
  }
});

test('handoff state exposes only the nonce digest', () => {
  const doc = populatedDoc();
  doc.handoff = {nonceSha256: SHA_A, sourceStage: 'specification', targetStage: 'basic-design', phase: 'prepared', operationId: OPERATION_ID};
  assert.equal(decodeEpicDoc(doc).ok, true);
  (doc.handoff as unknown as Record<string, unknown>).nonce = 'secret';
  assert.ok(paths(rejected(decodeEpicDoc(doc))).includes('handoff.nonce'));
});

test('feature docs validate bindings and keys', () => {
  const bad = featureDoc(); bad.featureKey = 'REQ001';
  assert.ok(paths(rejected(decodeScaffoldDoc(bad))).includes('featureKey'));
  const noTester = featureDoc() as unknown as {bindings: Record<string, unknown>};
  delete noTester.bindings.tester;
  assert.ok(paths(rejected(decodeScaffoldDoc(noTester))).includes('bindings.tester'));
  const model = featureDoc(); model.bindings.coder.model = 'no-slash';
  assert.ok(paths(rejected(decodeScaffoldDoc(model))).includes('bindings.coder.model'));
});

test('non-success statuses are errors', () => {
  for (const s of ['blocked', 'partial', 'unknown', 'cancelled'] as const) assert.equal(isErrorStatus(s), true);
  for (const s of ['validated', 'prepared', 'applied', 'noop'] as const) assert.equal(isErrorStatus(s), false);
});
