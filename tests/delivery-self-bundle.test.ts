import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPinnedGitBundle, restoreFromGitBundle } from '../packages/adapters/src/git-bundle.js';

test('self-dogfooding proof: project-hivemind repository (>4MiB) packages cleanly into SHA-256 verified git bundle and restores exact HEAD', async () => {
  const repoRoot = process.cwd();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-self-bundle-'));
  const signal = new AbortController().signal;
  try {
    const bundlePath = join(scratch, 'project-hivemind.bundle');
    const manifest = await createPinnedGitBundle(repoRoot, head, bundlePath, signal);
    assert.equal(manifest.baseCommit, head);
    assert.ok(manifest.fileCount >= 700, `expected >=700 tracked files, got ${manifest.fileCount}`);
    assert.ok(manifest.sizeBytes > 100_000, `expected real bundle bytes, got ${manifest.sizeBytes}`);

    const restoreDir = join(scratch, 'restored');
    await restoreFromGitBundle(bundlePath, manifest.bundleSha256, head, restoreDir, signal);
    const restoredHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: restoreDir, encoding: 'utf8' }).trim();
    assert.equal(restoredHead, head);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
