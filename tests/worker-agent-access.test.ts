import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentAccessEnv } from '../apps/worker/src/aws-worker-policy.js';
import { assertPatchHasNoSecrets } from '../apps/worker/src/aws-worker-runtime.js';
import type { CreateDeliveryTask } from '../packages/contracts/src/delivery.js';
import { DeliveryStore, computeAcceptanceTestDigest, validateWorkerExecutionPolicy } from '../packages/core/src/delivery.js';

const BASE = 'a'.repeat(40);
const REPO = 'roboco-io/silicon-model-factory';

function input(executionPolicy?: CreateDeliveryTask['executionPolicy']): CreateDeliveryTask {
  const files = [{ path: 'package.json', sha256: 'd'.repeat(64) }];
  const testCommand = ['npm', 'test'];
  return {
    title: 'Advance', instructions: 'Advance one stage.', provider: 'codex', maxIterations: 1, budgetMicros: 1,
    acceptance: { baseCommit: BASE, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit: BASE, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository: REPO, baseBranch: 'main', branchPrefix: 'hivemind/autonomy/', autoMerge: false },
    bundle: { baseCommit: BASE, bundleSha256: 'f'.repeat(64), sizeBytes: 1, fileCount: 1, s3Key: 'bundles/x.bundle' },
    spot: { maxSpotRetries: 1, checkpointFlushTimeoutMs: 60_000 },
    ...(executionPolicy ? { executionPolicy } : {}),
  };
}

test('agent access is opt-in, limited to operator-listed repositories, and part of the approval fingerprint', async () => {
  assert.equal(validateWorkerExecutionPolicy({ hivemindAgentAccess: true }).hivemindAgentAccess, true);
  assert.equal('hivemindAgentAccess' in validateWorkerExecutionPolicy({ hivemindAgentAccess: false }), false);
  assert.throws(() => validateWorkerExecutionPolicy({ hivemindAgentAccess: 'yes' }), /boolean/);
  await assert.rejects(new DeliveryStore(':memory:').create(input({ hivemindAgentAccess: true })), (e: { statusCode?: number }) => e.statusCode === 403);
  const store = new DeliveryStore(':memory:', Date.now, [REPO]);
  const withAccess = await store.create(input({ hivemindAgentAccess: true }));
  const without = await store.create(input());
  assert.notEqual(withAccess.approvalFingerprint, without.approvalFingerprint);
});

test('the model gets the agent token and Control Plane URL only when the task opted in and the token exists', () => {
  assert.deepEqual(buildAgentAccessEnv({ hivemindAgentAccess: true }, 'agent-token-value', 'http://10.0.0.5:4310'), { HIVEMIND_API_URL: 'http://10.0.0.5:4310', HIVEMIND_AGENT_TOKEN: 'agent-token-value' });
  assert.deepEqual(buildAgentAccessEnv({}, 'agent-token-value', 'http://10.0.0.5:4310'), {});
  assert.deepEqual(buildAgentAccessEnv(undefined, 'agent-token-value', 'http://10.0.0.5:4310'), {});
  assert.deepEqual(buildAgentAccessEnv({ hivemindAgentAccess: true }, '', 'http://10.0.0.5:4310'), {});
});

test('a patch carrying a token given to the model is refused before upload', () => {
  assert.doesNotThrow(() => assertPatchHasNoSecrets('+ok line\n', ['agent-token-value-123']));
  assert.throws(() => assertPatchHasNoSecrets('+token = agent-token-value-123\n', ['agent-token-value-123']), /contains a secret/);
  assert.doesNotThrow(() => assertPatchHasNoSecrets('+short\n', ['short']), 'values shorter than 8 characters are not checked');
});
