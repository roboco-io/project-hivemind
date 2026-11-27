import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryOrchestrator } from '../apps/control-plane/src/delivery-orchestrator.js';
import type { GitHubDraftPrPort } from '../packages/adapters/src/draft-pr-publisher.js';
import { createGitHubDraftPrPort } from '../packages/adapters/src/github-draft-pr.js';
import type { CreateDeliveryTask, DeliveryTask } from '../packages/contracts/src/delivery.js';
import { DeliveryStore, computeAcceptanceTestDigest, pathsInPatch, touchedProtectedPaths, validateDeliveryPolicy } from '../packages/core/src/delivery.js';

const BASE = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const REPO = 'roboco-io/silicon-model-factory';
const PROTECTED = ['tools/', 'infra/', 'ledger/policy.json', '.claude/', 'AGENTS.md', 'releases/*/criteria.json'];

function input(): CreateDeliveryTask {
  const files = [{ path: 'tools/release-check.mjs', sha256: 'd'.repeat(64) }];
  const testCommand = ['npm', 'test'];
  return {
    title: 'Advance the autonomy loop',
    instructions: 'Read ops/autonomy/state.json and advance one stage.',
    provider: 'codex',
    maxIterations: 2,
    budgetMicros: 100_000,
    acceptance: { baseCommit: BASE, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit: BASE, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository: REPO, baseBranch: 'main', branchPrefix: 'hivemind/autonomy/', autoMerge: true, protectedPaths: PROTECTED },
    bundle: { baseCommit: BASE, bundleSha256: 'f'.repeat(64), sizeBytes: 1000, fileCount: 10, s3Key: 'bundles/smf.bundle' },
    spot: { maxSpotRetries: 1, checkpointFlushTimeoutMs: 60_000 },
  };
}

async function published(store: DeliveryStore): Promise<DeliveryTask> {
  const draft = await store.create(input());
  await store.approve(draft.id, draft.approvalFingerprint, 'trigger');
  await store.startIteration(draft.id, 'w-1', 'run-1');
  await store.recordVerification(draft.id, {
    runId: 'run-1', iteration: 1, baseCommit: BASE, acceptanceTestDigest: draft.acceptance.digest, verifiedTreeHash: TREE,
    patchSha256: 'e'.repeat(64), checksPassed: true, acceptancePathsUnmodified: true, durationMs: 1, exitCode: 0, summary: 'npm test passed', verifiedAt: '2026-11-28T00:00:00Z',
  });
  return store.recordDraftPrPublication(draft.id, {
    branchName: `hivemind/autonomy/${draft.id}-r1`, commitSha: HEAD, prTreeHash: TREE, prNumber: 7,
    prUrl: `https://github.com/${REPO}/pull/7`, verifiedTreeHash: TREE, acceptanceTestDigest: draft.acceptance.digest,
    patchSha256: 'e'.repeat(64), publishedAt: '2026-11-28T00:01:00Z',
  });
}

const patchTouching = (...paths: string[]) => paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`).join('');

function orchestrator(store: DeliveryStore, github: GitHubDraftPrPort) {
  const notes: string[] = [];
  const refusals: string[] = [];
  const orch = new DeliveryOrchestrator({
    store,
    github,
    s3: {} as never,
    ecs: {} as never,
    notify: async (kind: string, subject: string) => { notes.push(`${kind}:${subject}`); },
    onAutoMergeRefused: async (_task: DeliveryTask, reason: string) => { refusals.push(reason); },
  } as never);
  const autoMerge = (task: DeliveryTask, patch: string) => (orch as unknown as { autoMerge(t: DeliveryTask, p: string, g: GitHubDraftPrPort, s: AbortSignal): Promise<DeliveryTask> }).autoMerge(task, patch, github, AbortSignal.timeout(5000));
  return { autoMerge, notes, refusals };
}

test('protected path patterns match prefixes, exact files and one star per segment', () => {
  const changed = pathsInPatch(patchTouching('plans/a.md', 'releases/rtl-repair/criteria.json', 'releases/rtl-repair/model-card.md', 'tools/x.mjs', 'AGENTS.md.bak'));
  assert.deepEqual(changed, ['AGENTS.md.bak', 'plans/a.md', 'releases/rtl-repair/criteria.json', 'releases/rtl-repair/model-card.md', 'tools/x.mjs']);
  assert.deepEqual(touchedProtectedPaths(changed, PROTECTED), ['releases/rtl-repair/criteria.json', 'tools/x.mjs']);
  const renamed = 'diff --git a/plans/x.md b/tools/x.md\nsimilarity index 100%\nrename from plans/x.md\nrename to tools/x.md\n';
  assert.deepEqual(touchedProtectedPaths(pathsInPatch(renamed), PROTECTED), ['tools/x.md'], 'a rename into a protected path counts');
  assert.throws(() => validateDeliveryPolicy({ ...input().delivery, protectedPaths: [] }), /protectedPaths/);
  assert.throws(() => validateDeliveryPolicy({ ...input().delivery, protectedPaths: ['../x'] }), /Invalid protected path/);
  assert.throws(() => validateDeliveryPolicy({ ...input().delivery, protectedPaths: ['**/x'] }), /Invalid protected path/);
  assert.throws(() => validateDeliveryPolicy({ ...input().delivery, autoMerge: false, protectedPaths: ['tools/'] }), /only for autoMerge/);
});

test('auto-merge is refused at registration for a repository the operator did not list', async () => {
  await assert.rejects(new DeliveryStore(':memory:').create(input()), (e: { statusCode?: number }) => e.statusCode === 403);
  const ok = await new DeliveryStore(':memory:', Date.now, [REPO]).create(input());
  assert.equal(ok.delivery.autoMerge, true);
  assert.deepEqual(ok.delivery.protectedPaths, PROTECTED);
});

test('a verified change outside protected paths is merged and the task is approved by the policy', async () => {
  const store = new DeliveryStore(':memory:', Date.now, [REPO]);
  const task = await published(store);
  const calls: unknown[] = [];
  const github: GitHubDraftPrPort = {
    async publishDraftPr() { throw new Error('unused'); },
    async mergePullRequest(request) { calls.push(request); return { mergeCommitSha: '9'.repeat(40) }; },
  };
  const o = orchestrator(store, github);
  const merged = await o.autoMerge(task, patchTouching('plans/tasks/rtl/plan.md', 'ops/autonomy/state.json'));
  assert.equal(merged.status, 'approved');
  assert.equal(merged.autoMerge?.outcome, 'merged');
  assert.equal(merged.autoMerge?.mergeCommitSha, '9'.repeat(40));
  assert.deepEqual(calls, [{ repository: REPO, prNumber: 7, expectedHeadSha: HEAD, title: 'Advance the autonomy loop' }]);
  assert.deepEqual(o.notes, []);
  assert.ok((await store.events(task.id)).some((e) => e.type === 'delivery.auto_merged'));
});

test('a change touching a protected path is not merged, is reported, and stops the trigger', async () => {
  const store = new DeliveryStore(':memory:', Date.now, [REPO]);
  const task = await published(store);
  let merges = 0;
  const github: GitHubDraftPrPort = { async publishDraftPr() { throw new Error('unused'); }, async mergePullRequest() { merges += 1; return { mergeCommitSha: '9'.repeat(40) }; } };
  const o = orchestrator(store, github);
  const refused = await o.autoMerge(task, patchTouching('plans/a.md', 'ledger/policy.json'));
  assert.equal(merges, 0);
  assert.equal(refused.status, 'draft_pr_published');
  assert.equal(refused.waitReason, 'auto_merge_refused');
  assert.deepEqual(refused.autoMerge?.touchedProtectedPaths, ['ledger/policy.json']);
  assert.equal(o.notes.length, 1);
  assert.match(o.notes[0]!, /^auto_merge_refused:/);
  assert.deepEqual(o.refusals, ['The change touches protected paths.']);
});

test('a moved head or a missing merge capability is a refusal, not a merge', async () => {
  for (const variant of ['moved', 'no-capability', 'not-allowed'] as const) {
    const store = new DeliveryStore(':memory:', Date.now, [REPO]);
    const task = await published(store);
    const github: GitHubDraftPrPort =
      variant === 'no-capability'
        ? { async publishDraftPr() { throw new Error('unused'); } }
        : { async publishDraftPr() { throw new Error('unused'); }, async mergePullRequest() { throw new Error('Pull request head moved after verification'); } };
    const target = variant === 'not-allowed' ? new DeliveryStore(':memory:') : store;
    const o = orchestrator(variant === 'not-allowed' ? Object.assign(store, { autoMergeAllowed: () => false }) : target, github);
    const refused = await o.autoMerge(task, patchTouching('plans/a.md'));
    assert.equal(refused.autoMerge?.outcome, 'refused', variant);
    assert.equal(o.refusals.length, 1, variant);
  }
});

test('the GitHub client marks the draft ready and squash-merges pinned to the verified head', async () => {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const github = createGitHubDraftPrPort(
    {
      token: 'ghs_test',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        requests.push({ url: String(url), method: init?.method ?? 'GET', body });
        if (String(url).endsWith('/pulls/7')) return Response.json({ node_id: 'PR_1', draft: true, state: 'open', head: { sha: HEAD } });
        if (String(url).endsWith('/graphql')) return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
        return Response.json({ merged: true, sha: '9'.repeat(40) });
      }) as typeof fetch,
    },
    { async createIsolatedBranchCommit() { throw new Error('unused'); } },
  );
  const result = await github.mergePullRequest!({ repository: REPO, prNumber: 7, expectedHeadSha: HEAD, title: 't' }, AbortSignal.timeout(5000));
  assert.equal(result.mergeCommitSha, '9'.repeat(40));
  assert.deepEqual(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`), [`GET /repos/${REPO}/pulls/7`, 'POST /graphql', `PUT /repos/${REPO}/pulls/7/merge`]);
  assert.deepEqual(requests[2]!.body, { sha: HEAD, merge_method: 'squash', commit_title: 't' });
  const moved = createGitHubDraftPrPort(
    { token: 'ghs_test', fetchImpl: (async () => Response.json({ node_id: 'PR_1', draft: false, state: 'open', head: { sha: '1'.repeat(40) } })) as typeof fetch },
    { async createIsolatedBranchCommit() { throw new Error('unused'); } },
  );
  await assert.rejects(moved.mergePullRequest!({ repository: REPO, prNumber: 7, expectedHeadSha: HEAD, title: 't' }, AbortSignal.timeout(5000)), /head moved/);
});
