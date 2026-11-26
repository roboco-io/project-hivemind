import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CreateDeliveryTask, VerificationAttestation } from '../packages/contracts/src/delivery.js';
import {
  DeliveryStore,
  assertPatchDoesNotTouchAcceptancePaths,
  computeAcceptanceTestDigest,
} from '../packages/core/src/delivery.js';

const BASE_COMMIT = 'a'.repeat(40);
const TREE_HASH = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const FILE_SHA = 'd'.repeat(64);
const PATCH_SHA = 'e'.repeat(64);
const BUNDLE_SHA = 'f'.repeat(64);

function sampleInput(): CreateDeliveryTask {
  const files = [{ path: 'tests/acceptance.test.ts', sha256: FILE_SHA }];
  const testCommand = ['npm', 'run', 'check'];
  return {
    title: 'Add AWS delivery flow',
    instructions: 'Implement the approved change without editing acceptance tests.',
    provider: 'codex',
    maxIterations: 3,
    budgetMicros: 500_000,
    acceptance: {
      baseCommit: BASE_COMMIT,
      files,
      testCommand,
      digest: computeAcceptanceTestDigest({ baseCommit: BASE_COMMIT, files, testCommand }),
    },
    delivery: {
      mode: 'draft_pr',
      repository: 'roboco-io/project-hivemind',
      baseBranch: 'main',
      branchPrefix: 'hivemind/',
      autoMerge: false,
    },
    bundle: {
      baseCommit: BASE_COMMIT,
      bundleSha256: BUNDLE_SHA,
      sizeBytes: 11_560_000,
      fileCount: 790,
      s3Key: 'bundles/hivemind.bundle',
    },
    spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
  };
}

function sampleAttestation(overrides: Partial<VerificationAttestation> = {}): VerificationAttestation {
  const input = sampleInput();
  return {
    runId: 'run-1',
    iteration: 1,
    baseCommit: BASE_COMMIT,
    acceptanceTestDigest: input.acceptance.digest,
    verifiedTreeHash: TREE_HASH,
    patchSha256: PATCH_SHA,
    checksPassed: true,
    acceptancePathsUnmodified: true,
    durationMs: 4200,
    exitCode: 0,
    summary: 'All acceptance checks passed',
    verifiedAt: '2026-11-25T12:00:00.000Z',
    ...overrides,
  };
}

test('rejects unsupported providers (e.g. gemini), main branch prefix, autoMerge, and tampered acceptance paths', () => {
  const store = new DeliveryStore(':memory:');
  try {
    assert.throws(
      () => store.create({ ...sampleInput(), provider: 'gemini' as never }),
      /Only codex and claude providers/,
    );
    assert.throws(
      () => store.create({ ...sampleInput(), delivery: { ...sampleInput().delivery, branchPrefix: 'main/' } }),
      /protected or base branch/,
    );
    assert.throws(
      () => store.create({ ...sampleInput(), delivery: { ...sampleInput().delivery, autoMerge: true as never } }),
      /Automatic merge/,
    );
    assert.throws(
      () => assertPatchDoesNotTouchAcceptancePaths(['src/app.ts', 'tests/acceptance.test.ts'], sampleInput().acceptance),
      /pinned acceptance test path/,
    );
  } finally {
    store.close();
  }
});

test('enforces fingerprint approval, Spot interruption retry cap, Ralph retry loop, verifiedTreeHash match, and human no-diff decision persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-dlv-core-'));
  const dbPath = join(dir, 'delivery.sqlite');
  let clock = Date.parse('2026-11-25T12:00:00.000Z');
  const store1 = new DeliveryStore(dbPath, () => clock);
  try {
    const draft = store1.create(sampleInput());
    assert.equal(draft.status, 'awaiting_approval');
    assert.throws(() => store1.startIteration(draft.id, 'w-1', 'run-0'), /Cannot start iteration/);
    assert.throws(() => store1.approve(draft.id, '0'.repeat(64), 'bad hash'), /fingerprint/);

    const approved = store1.approve(draft.id, draft.approvalFingerprint, 'Approved for Milestone 1');
    assert.equal(approved.status, 'queued');

    // Attempt 1 interrupted by Fargate Spot SIGTERM -> flushes checkpoint and requeues without consuming iteration budget.
    store1.startIteration(draft.id, 'fargate-spot-1', 'run-spot-1');
    clock += 10_000;
    const afterSpot = store1.recordSpotInterruption(
      draft.id,
      'run-spot-1',
      'sessions/run-spot-1.enc',
      'Fargate Spot 2-minute SIGTERM',
    );
    assert.equal(afterSpot.status, 'queued');
    assert.equal(afterSpot.spotRetriesUsed, 1);
    assert.equal(afterSpot.currentIteration, 0);
    assert.equal(afterSpot.latestCheckpointRef, 'sessions/run-spot-1.enc');

    // Iteration 1 fails verification -> Ralph loop requeues for iteration 2.
    store1.startIteration(draft.id, 'fargate-spot-2', 'run-1');
    const afterFail = store1.recordVerification(
      draft.id,
      sampleAttestation({ runId: 'run-1', iteration: 1, checksPassed: false, exitCode: 1, summary: '1 test failed' }),
    );
    assert.equal(afterFail.status, 'queued');

    // Iteration 2 passes verification -> ready for Draft PR publication.
    store1.startIteration(draft.id, 'fargate-spot-3', 'run-2');
    const verified = store1.recordVerification(
      draft.id,
      sampleAttestation({ runId: 'run-2', iteration: 2, checksPassed: true, exitCode: 0 }),
    );
    assert.equal(verified.status, 'verified');

    // Mismatched prTreeHash or protected branch must be rejected.
    assert.throws(
      () =>
        store1.recordDraftPrPublication(draft.id, {
          branchName: `hivemind/${draft.id}-r2`,
          commitSha: COMMIT_SHA,
          prTreeHash: '9'.repeat(40),
          prNumber: 42,
          prUrl: 'https://github.com/roboco-io/project-hivemind/pull/42',
          verifiedTreeHash: TREE_HASH,
          acceptanceTestDigest: draft.acceptance.digest,
          patchSha256: PATCH_SHA,
          publishedAt: '2026-11-25T12:05:00.000Z',
        }),
      /tree hash does not match/,
    );
    assert.throws(
      () =>
        store1.recordDraftPrPublication(draft.id, {
          branchName: 'main',
          commitSha: COMMIT_SHA,
          prTreeHash: TREE_HASH,
          prNumber: 42,
          prUrl: 'https://github.com/roboco-io/project-hivemind/pull/42',
          verifiedTreeHash: TREE_HASH,
          acceptanceTestDigest: draft.acceptance.digest,
          patchSha256: PATCH_SHA,
          publishedAt: '2026-11-25T12:05:00.000Z',
        }),
      /isolated branchPrefix/,
    );

    const published = store1.recordDraftPrPublication(draft.id, {
      branchName: `hivemind/${draft.id}-r2`,
      commitSha: COMMIT_SHA,
      prTreeHash: TREE_HASH,
      prNumber: 42,
      prUrl: 'https://github.com/roboco-io/project-hivemind/pull/42',
      verifiedTreeHash: TREE_HASH,
      acceptanceTestDigest: draft.acceptance.digest,
      patchSha256: PATCH_SHA,
      publishedAt: '2026-11-25T12:05:00.000Z',
    });
    assert.equal(published.status, 'draft_pr_published');

    const decided = store1.recordHumanDecision(draft.id, {
      decision: 'approve',
      openedDiff: false,
      durationMinutes: 2.5,
      reason: 'Approved from immutable acceptance checks and verifiedTreeHash match without opening diff',
    });
    assert.equal(decided.status, 'approved');
    assert.equal(decided.humanDecision?.openedDiff, false);
    assert.equal(decided.humanDecision?.durationMinutes, 2.5);
    store1.close();

    // Restart persistence check.
    const store2 = new DeliveryStore(dbPath);
    try {
      const reloaded = store2.get(draft.id);
      assert.equal(reloaded.status, 'approved');
      assert.equal(reloaded.publication?.prTreeHash, TREE_HASH);
      assert.equal(reloaded.humanDecision?.openedDiff, false);
      assert.equal(reloaded.humanDecision?.durationMinutes, 2.5);
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails immediately when acceptance paths are modified and blocks publication after cancellation', () => {
  const store = new DeliveryStore(':memory:');
  try {
    const t1 = store.create(sampleInput());
    store.approve(t1.id, t1.approvalFingerprint, 'go');
    store.startIteration(t1.id, 'w-1', 'run-1');
    const tampered = store.recordVerification(
      t1.id,
      sampleAttestation({ runId: 'run-1', iteration: 1, checksPassed: true, acceptancePathsUnmodified: false }),
    );
    assert.equal(tampered.status, 'failed');

    const t2 = store.create(sampleInput());
    store.approve(t2.id, t2.approvalFingerprint, 'go');
    store.startIteration(t2.id, 'w-1', 'run-1');
    store.recordVerification(t2.id, sampleAttestation({ runId: 'run-1', iteration: 1 }));
    store.cancel(t2.id, 'Operator stopped before publish');
    assert.throws(
      () =>
        store.recordDraftPrPublication(t2.id, {
          branchName: `hivemind/${t2.id}-r1`,
          commitSha: COMMIT_SHA,
          prTreeHash: TREE_HASH,
          prNumber: 99,
          prUrl: 'https://github.com/roboco-io/project-hivemind/pull/99',
          verifiedTreeHash: TREE_HASH,
          acceptanceTestDigest: t2.acceptance.digest,
          patchSha256: PATCH_SHA,
          publishedAt: '2026-11-25T12:10:00.000Z',
        }),
      /Cannot publish Draft PR in state cancelled/,
    );
  } finally {
    store.close();
  }
});
