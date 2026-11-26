import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureAcceptanceTestSpec,
  createPinnedGitBundle,
  restoreFromGitBundle,
  verifyPatchWithImmutableAcceptance,
} from '../packages/adapters/src/git-bundle.js';
import { publishVerifiedDraftPr, type GitHubDraftPrRequest } from '../packages/adapters/src/draft-pr-publisher.js';
import { DeliveryStore } from '../packages/core/src/delivery.js';

function gitExec(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: 'HIVEMIND Test',
      GIT_AUTHOR_EMAIL: 'test@hivemind.local',
      GIT_COMMITTER_NAME: 'HIVEMIND Test',
      GIT_COMMITTER_EMAIL: 'test@hivemind.local',
    },
  }).trim();
}

function makeFixtureRepo(root: string, includeLargeFile = false): { repoPath: string; baseCommit: string } {
  const repoPath = join(root, 'repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'tests'), { recursive: true });
  gitExec(repoPath, ['init', '-b', 'main']);
  writeFileSync(join(repoPath, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
  writeFileSync(
    join(repoPath, 'tests/acceptance.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.mjs';",
      'assert.equal(add(2, 3), 5);',
      "console.log('ACCEPTANCE_OK');",
    ].join('\n') + '\n',
    'utf8',
  );
  if (includeLargeFile) {
    // 5 MiB binary-ish text payload proves git bundle surpasses the old 4 MiB JSON snapshot ceiling.
    writeFileSync(join(repoPath, 'large-fixture.bin'), Buffer.alloc(5 * 1024 * 1024, 0x61));
  }
  gitExec(repoPath, ['add', '--all']);
  gitExec(repoPath, ['commit', '-m', 'initial pinned commit']);
  const baseCommit = gitExec(repoPath, ['rev-parse', 'HEAD']);
  return { repoPath, baseCommit };
}

function makePatchForEdit(repoPath: string, relPath: string, content: string): string {
  const full = join(repoPath, relPath);
  writeFileSync(full, content, 'utf8');
  const diff = gitExec(repoPath, ['diff', '--binary']);
  gitExec(repoPath, ['checkout', '--', relPath]);
  return diff + '\n';
}

test('git bundle handles >4MiB repo, enforces bundle SHA-256, rejects acceptance tampering, and proves verifiedTreeHash === prTreeHash in Draft PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-bundle-'));
  const signal = new AbortController().signal;
  try {
    const { repoPath, baseCommit } = makeFixtureRepo(root, true);
    const bundlePath = join(root, 'pinned.bundle');
    const manifest = await createPinnedGitBundle(repoPath, baseCommit, bundlePath, signal);
    assert.equal(manifest.baseCommit, baseCommit);
    assert.equal(manifest.fileCount, 3);
    assert.ok(manifest.sizeBytes > 0);

    // Corrupted bundle hash is rejected before restore.
    await assert.rejects(
      () => restoreFromGitBundle(bundlePath, '0'.repeat(64), baseCommit, join(root, 'bad-restore'), signal),
      /SHA-256 verification failed/,
    );

    const acceptance = await captureAcceptanceTestSpec(
      repoPath,
      baseCommit,
      ['tests/acceptance.test.mjs'],
      [process.execPath, 'tests/acceptance.test.mjs'],
      signal,
    );

    const store = new DeliveryStore(':memory:');
    const task = await store.create({
      title: 'Fix add implementation',
      instructions: 'Fix add(a, b) in src/math.mjs so acceptance passes.',
      provider: 'claude',
      maxIterations: 3,
      budgetMicros: 200_000,
      acceptance,
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/project-hivemind',
        baseBranch: 'main',
        branchPrefix: 'hivemind/',
        autoMerge: false,
      },
      bundle: manifest,
    });
    await store.approve(task.id, task.approvalFingerprint, 'Approved for git-bundle test');

    // 1. Tampered worker patch touching pinned acceptance test is rejected immediately.
    const tamperPatch = makePatchForEdit(repoPath, 'tests/acceptance.test.mjs', 'console.log("CHEAT");\n');
    const tamperAttestation = await verifyPatchWithImmutableAcceptance(
      {
        runId: 'run-tamper',
        iteration: 1,
        bundlePath,
        expectedBundleSha256: manifest.bundleSha256,
        acceptance,
        patch: tamperPatch,
        workRoot: root,
      },
      signal,
    );
    assert.equal(tamperAttestation.acceptancePathsUnmodified, false);
    assert.equal(tamperAttestation.checksPassed, false);

    // 2. Iteration 1: buggy fix fails independent verification -> Ralph loop retries.
    await store.startIteration(task.id, 'worker-1', 'run-1');
    const badPatch = makePatchForEdit(repoPath, 'src/math.mjs', 'export const add = (a, b) => a * b;\n');
    const failAttestation = await verifyPatchWithImmutableAcceptance(
      {
        runId: 'run-1',
        iteration: 1,
        bundlePath,
        expectedBundleSha256: manifest.bundleSha256,
        acceptance,
        patch: badPatch,
        workRoot: root,
      },
      signal,
    );
    assert.equal(failAttestation.acceptancePathsUnmodified, true);
    assert.equal(failAttestation.checksPassed, false);
    const afterFail = await store.recordVerification(task.id, failAttestation);
    assert.equal(afterFail.status, 'queued');

    // 3. Iteration 2: valid fix passes independent verification.
    await store.startIteration(task.id, 'worker-1', 'run-2');
    const goodPatch = makePatchForEdit(repoPath, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
    const passAttestation = await verifyPatchWithImmutableAcceptance(
      {
        runId: 'run-2',
        iteration: 2,
        bundlePath,
        expectedBundleSha256: manifest.bundleSha256,
        acceptance,
        patch: goodPatch,
        workRoot: root,
      },
      signal,
    );
    assert.equal(passAttestation.acceptancePathsUnmodified, true);
    assert.equal(passAttestation.checksPassed, true);
    const verifiedTask = await store.recordVerification(task.id, passAttestation);
    assert.equal(verifiedTask.status, 'verified');

    // 4. Draft PR publisher independently recomputes prTreeHash and enforces equality with verifiedTreeHash.
    let capturedRequest: GitHubDraftPrRequest | null = null;
    const publication = await publishVerifiedDraftPr(
      {
        task: verifiedTask,
        attestation: passAttestation,
        bundlePath,
        expectedBundleSha256: manifest.bundleSha256,
        patch: goodPatch,
        workRoot: root,
        redactSecrets: ['super-secret-token-value'],
        github: {
          async publishDraftPr(req) {
            capturedRequest = req;
            return {
              commitSha: '1'.repeat(40),
              prTreeHash: req.expectedTreeHash,
              prNumber: 77,
              prUrl: 'https://github.com/roboco-io/project-hivemind/pull/77',
            };
          },
        },
      },
      signal,
    );
    assert.ok(capturedRequest);
    const sent = capturedRequest as GitHubDraftPrRequest;
    assert.equal(sent.draft, true);
    assert.equal(sent.branchName, `hivemind/${task.id}-r2`);
    assert.match(sent.body, /VERIFIED/);
    assert.equal(publication.prTreeHash, passAttestation.verifiedTreeHash);

    const publishedTask = await store.recordDraftPrPublication(task.id, publication);
    assert.equal(publishedTask.status, 'draft_pr_published');

    // Refuses remote PR response whose tree hash diverges from verifiedTreeHash.
    await assert.rejects(
      () =>
        publishVerifiedDraftPr(
          {
            task: verifiedTask,
            attestation: passAttestation,
            bundlePath,
            expectedBundleSha256: manifest.bundleSha256,
            patch: goodPatch,
            workRoot: root,
            github: {
              async publishDraftPr() {
                return {
                  commitSha: '1'.repeat(40),
                  prTreeHash: '9'.repeat(40),
                  prNumber: 78,
                  prUrl: 'https://github.com/roboco-io/project-hivemind/pull/78',
                };
              },
            },
          },
          signal,
        ),
      /remote PR tree hash does not match verifiedTreeHash/,
    );
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
