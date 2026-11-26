import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AcceptanceTestFile,
  AcceptanceTestSpec,
  BundleManifest,
  ChangedFileStat,
  VerificationAttestation,
} from '../../contracts/src/delivery.js';
import {
  assertPatchDoesNotTouchAcceptancePaths,
  computeAcceptanceTestDigest,
  normalizeRepoRelativePath,
  validateAcceptanceTestSpec,
} from '../../core/src/delivery.js';
import { processEnvironment, runExecutable, runProcess } from './process.js';

const HEX40 = /^[a-f0-9]{40}$/i;
const HEX64 = /^[a-f0-9]{64}$/i;

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  maxOutputBytes = 256_000,
) {
  const result = await runExecutable(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, signal, timeoutMs: 60_000, env, maxOutputBytes },
  );
  if (result.status !== 'passed') {
    throw new Error(`Git ${args[0]} failed: ${result.stderr.slice(0, 2000)}`);
  }
  return result;
}

export async function sha256File(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const bytes = await readFile(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

export async function captureAcceptanceTestSpec(
  repositoryPath: string,
  baseCommit: string,
  relativePaths: string[],
  testCommand: string[],
  signal: AbortSignal,
): Promise<AcceptanceTestSpec> {
  if (!HEX40.test(baseCommit)) throw new Error('Invalid baseCommit');
  if (!relativePaths.length) throw new Error('At least one acceptance test path is required');
  const tmpHome = await mkdtemp(join(dirname(repositoryPath), '.hivemind-cap-'));
  try {
    const env = processEnvironment(tmpHome);
    const commit = baseCommit.toLowerCase();
    const files: AcceptanceTestFile[] = [];
    for (const rawPath of relativePaths) {
      const normalized = normalizeRepoRelativePath(rawPath);
      const blob = await git(repositoryPath, ['show', `${commit}:${normalized}`], signal, env, 4_000_000);
      if (blob.truncated) throw new Error(`Acceptance test file too large: ${normalized}`);
      files.push({
        path: normalized,
        sha256: createHash('sha256').update(blob.stdout, 'utf8').digest('hex'),
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const digest = computeAcceptanceTestDigest({ baseCommit: commit, files, testCommand });
    return validateAcceptanceTestSpec({ baseCommit: commit, files, testCommand, digest });
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
}

export async function createPinnedGitBundle(
  repositoryPath: string,
  baseCommit: string,
  outputBundlePath: string,
  signal: AbortSignal,
): Promise<BundleManifest> {
  const commitMatch = /^[a-f0-9]{40}$/i.exec(baseCommit);
  if (!commitMatch) throw new Error('Invalid baseCommit');
  const commit = commitMatch[0].toLowerCase();
  const tmpDir = await mkdtemp(join(dirname(outputBundlePath), '.hivemind-bundle-'));
  try {
    const env = processEnvironment(tmpDir);
    const shallow = (await git(repositoryPath, ['rev-parse', '--is-shallow-repository'], signal, env)).stdout.trim();
    if (shallow === 'true') {
      throw new Error('Cannot create a self-contained git bundle from a shallow repository; fetch full history first');
    }
    await mkdir(dirname(outputBundlePath), { recursive: true });
    // Create a temporary pinned ref pointing strictly at baseCommit so git bundle includes exact history to baseCommit.
    const refName = `refs/hivemind-bundles/${commit.slice(0, 12)}-${Date.now()}`;
    await git(repositoryPath, ['update-ref', refName, commit], signal, env);
    try {
      await git(repositoryPath, ['bundle', 'create', outputBundlePath, refName], signal, env);
    } finally {
      await git(repositoryPath, ['update-ref', '-d', refName], signal, env).catch(() => undefined);
    }
    const tree = await git(repositoryPath, ['ls-tree', '-r', '--name-only', commit], signal, env, 8_000_000);
    const fileCount = tree.stdout.split('\n').filter((line) => line.length > 0).length;
    const { sha256, sizeBytes } = await sha256File(outputBundlePath);
    return { baseCommit: commit, bundleSha256: sha256, sizeBytes, fileCount };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function restoreFromGitBundle(
  bundlePath: string,
  expectedBundleSha256: string,
  baseCommit: string,
  targetDir: string,
  signal: AbortSignal,
): Promise<void> {
  if (!HEX64.test(expectedBundleSha256)) throw new Error('Invalid expectedBundleSha256');
  if (!HEX40.test(baseCommit)) throw new Error('Invalid baseCommit');
  const actual = await sha256File(bundlePath);
  if (actual.sha256 !== expectedBundleSha256.toLowerCase()) {
    throw new Error('Git bundle SHA-256 verification failed');
  }
  const commit = baseCommit.toLowerCase();
  await mkdir(targetDir, { recursive: true });
  const tmpHome = await mkdtemp(join(dirname(targetDir), '.hivemind-restore-'));
  try {
    const env = processEnvironment(tmpHome);
    await git(targetDir, ['init', '-q'], signal, env);
    await git(targetDir, ['fetch', '-q', bundlePath, `${commit}:refs/hivemind/base`], signal, env).catch(async () => {
      // Fallback when bundle exposes a pinned ref instead of raw commit advertisement.
      await git(targetDir, ['fetch', '-q', bundlePath, 'refs/hivemind-bundles/*:refs/hivemind/*'], signal, env);
    });
    await git(targetDir, ['checkout', '-q', '--detach', commit], signal, env);
    const head = (await git(targetDir, ['rev-parse', 'HEAD'], signal, env)).stdout.trim().toLowerCase();
    if (head !== commit) throw new Error('Restored bundle HEAD does not match pinned baseCommit');
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
}

async function listPatchFileStats(
  workspacePath: string,
  patchFilePath: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<ChangedFileStat[]> {
  const numstat = await git(workspacePath, ['apply', '--numstat', patchFilePath], signal, env, 512_000);
  const stats: ChangedFileStat[] = [];
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const added = parts[0]?.trim();
    const removed = parts[1]?.trim();
    const filePath = parts[2]?.trim();
    if (!filePath) continue;
    const binary = added === '-' || removed === '-';
    stats.push({
      path: normalizeRepoRelativePath(filePath),
      insertions: binary ? null : Number(added),
      deletions: binary ? null : Number(removed),
      binary,
    });
  }
  stats.sort((a, b) => a.path.localeCompare(b.path));
  return stats;
}

async function listPatchModifiedPaths(
  workspacePath: string,
  patchFilePath: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  return (await listPatchFileStats(workspacePath, patchFilePath, signal, env)).map((entry) => entry.path);
}

async function writeDeterministicTreeHash(
  workspacePath: string,
  baseCommit: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const indexDir = await mkdtemp(join(dirname(workspacePath), '.hivemind-tree-'));
  try {
    const isolatedEnv = { ...env, GIT_INDEX_FILE: join(indexDir, 'index') };
    await git(workspacePath, ['read-tree', baseCommit], signal, isolatedEnv);
    await git(workspacePath, ['add', '--all'], signal, isolatedEnv);
    return (await git(workspacePath, ['write-tree'], signal, isolatedEnv)).stdout.trim().toLowerCase();
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

export interface VerifyPatchOptions {
  runId: string;
  iteration: number;
  bundlePath: string;
  expectedBundleSha256: string;
  acceptance: AcceptanceTestSpec;
  patch: string;
  workRoot: string;
  testTimeoutMs?: number;
  now?: () => number;
}

export async function verifyPatchWithImmutableAcceptance(
  options: VerifyPatchOptions,
  signal: AbortSignal,
): Promise<VerificationAttestation> {
  const acceptance = validateAcceptanceTestSpec(options.acceptance);
  const patchSha256 = createHash('sha256').update(options.patch, 'utf8').digest('hex');
  const workspaceDir = await mkdtemp(join(options.workRoot, 'verify-'));
  const worktreeDir = join(workspaceDir, 'repo');
  const homeDir = join(workspaceDir, 'home');
  const patchFile = join(workspaceDir, 'worker.patch');
  await mkdir(homeDir, { recursive: true });
  const env = processEnvironment(homeDir);
  const started = (options.now ?? Date.now)();
  try {
    await restoreFromGitBundle(
      options.bundlePath,
      options.expectedBundleSha256,
      acceptance.baseCommit,
      worktreeDir,
      signal,
    );
    await writeFile(patchFile, options.patch, 'utf8');
    const modifiedPaths = options.patch.trim()
      ? await listPatchModifiedPaths(worktreeDir, patchFile, signal, env)
      : [];
    try {
      assertPatchDoesNotTouchAcceptancePaths(modifiedPaths, acceptance);
    } catch (error) {
      const baseTree = await writeDeterministicTreeHash(worktreeDir, acceptance.baseCommit, signal, env);
      return {
        runId: options.runId,
        iteration: options.iteration,
        baseCommit: acceptance.baseCommit,
        acceptanceTestDigest: acceptance.digest,
        verifiedTreeHash: baseTree,
        patchSha256,
        checksPassed: false,
        acceptancePathsUnmodified: false,
        durationMs: Math.max(0, (options.now ?? Date.now)() - started),
        exitCode: null,
        summary: error instanceof Error ? error.message : 'Pinned acceptance test path modified',
        verifiedAt: new Date((options.now ?? Date.now)()).toISOString(),
      };
    }

    if (options.patch.trim()) {
      await git(worktreeDir, ['apply', '--whitespace=nowarn', patchFile], signal, env);
    }

    // Defense-in-depth: restore pinned acceptance files from baseCommit and re-verify every SHA-256 before running tests.
    await git(
      worktreeDir,
      ['checkout', acceptance.baseCommit, '--', ...acceptance.files.map((file) => file.path)],
      signal,
      env,
    );
    for (const pinned of acceptance.files) {
      const target = join(worktreeDir, pinned.path);
      const info = await stat(target);
      if (!info.isFile()) throw new Error(`Pinned acceptance test is not a regular file: ${pinned.path}`);
      const actual = await sha256File(target);
      if (actual.sha256 !== pinned.sha256) {
        throw new Error(`Pinned acceptance test hash mismatch: ${pinned.path}`);
      }
    }

    const verifiedTreeHash = await writeDeterministicTreeHash(worktreeDir, acceptance.baseCommit, signal, env);
    const result = await runProcess(acceptance.testCommand, {
      cwd: worktreeDir,
      signal,
      timeoutMs: options.testTimeoutMs ?? 120_000,
      env,
    });
    const summary =
      result.status === 'passed'
        ? `Acceptance verification passed (${result.durationMs}ms).`
        : `Acceptance verification ${result.status} (exit ${result.exitCode ?? 'null'}): ${(result.stderr || result.stdout).slice(0, 1500)}`;

    return {
      runId: options.runId,
      iteration: options.iteration,
      baseCommit: acceptance.baseCommit,
      acceptanceTestDigest: acceptance.digest,
      verifiedTreeHash,
      patchSha256,
      checksPassed: result.status === 'passed',
      acceptancePathsUnmodified: true,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      summary,
      verifiedAt: new Date((options.now ?? Date.now)()).toISOString(),
    };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

export async function computePatchTreeHash(
  bundlePath: string,
  expectedBundleSha256: string,
  baseCommit: string,
  patch: string,
  workRoot: string,
  signal: AbortSignal,
): Promise<{
  prTreeHash: string;
  patchSha256: string;
  changedFiles: ChangedFileStat[];
  totalInsertions: number;
  totalDeletions: number;
}> {
  const workspaceDir = await mkdtemp(join(workRoot, 'publish-tree-'));
  const worktreeDir = join(workspaceDir, 'repo');
  const homeDir = join(workspaceDir, 'home');
  const patchFile = join(workspaceDir, 'verified.patch');
  await mkdir(homeDir, { recursive: true });
  const env = processEnvironment(homeDir);
  try {
    await restoreFromGitBundle(bundlePath, expectedBundleSha256, baseCommit, worktreeDir, signal);
    let changedFiles: ChangedFileStat[] = [];
    if (patch.trim()) {
      await writeFile(patchFile, patch, 'utf8');
      changedFiles = await listPatchFileStats(worktreeDir, patchFile, signal, env);
      await git(worktreeDir, ['apply', '--whitespace=nowarn', patchFile], signal, env);
    }
    const prTreeHash = await writeDeterministicTreeHash(worktreeDir, baseCommit.toLowerCase(), signal, env);
    const patchSha256 = createHash('sha256').update(patch, 'utf8').digest('hex');
    const totalInsertions = changedFiles.reduce((sum, f) => sum + (f.insertions ?? 0), 0);
    const totalDeletions = changedFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
    return { prTreeHash, patchSha256, changedFiles, totalInsertions, totalDeletions };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
