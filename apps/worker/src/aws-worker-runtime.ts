import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { restoreFromGitBundle } from '../../../packages/adapters/src/git-bundle.js';
import { processEnvironment, runExecutable } from '../../../packages/adapters/src/process.js';

export interface AwsWorkerControlPort {
  reportSpotInterrupted(input: {
    taskId: string;
    runId: string;
    checkpointRef: string;
    reason: string;
  }): Promise<void>;
}

export interface AwsWorkerExecutor {
  /**
   * Executes the model agent (Codex/Claude CLI) inside the restored workspace.
   * Must respect `signal` (aborted on Fargate Spot SIGTERM) and return checkpoint metadata if available.
   */
  run(input: {
    workspacePath: string;
    baseCommit: string;
    taskId: string;
    runId: string;
    iteration: number;
    priorCheckpoint?: Uint8Array;
    restoredCheckpointPatch?: boolean;
    signal: AbortSignal;
  }): Promise<{ checkpointBytes?: Uint8Array; summary: string }>;
}

export interface RunAwsWorkerOptions {
  taskId: string;
  runId: string;
  iteration: number;
  baseCommit: string;
  bundleS3Key: string;
  bundleSha256: string;
  checkpointS3Key?: string;
  preserveWorkspaceOnRetry?: boolean;
  s3: S3ObjectPort;
  control: AwsWorkerControlPort;
  executor: AwsWorkerExecutor;
  spotSignal?: AbortSignal;
  spotFlushTimeoutMs?: number;
  workRoot?: string;
  /** Secret values that must never appear in an uploaded patch or checkpoint (tokens given to the model). */
  forbiddenPatchValues?: string[];
}

/** Refuses a patch that carries a secret the model could see; it would end up in a pull request. */
export function assertPatchHasNoSecrets(patch: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && patch.includes(secret)) {
      throw new Error('The worker patch contains a secret value given to the model; it was not uploaded');
    }
  }
}

export type AwsWorkerOutcome =
  | { kind: 'completed'; patchS3Key: string; patchSha256: string; summary: string; checkpointS3Key?: string }
  | { kind: 'spot_interrupted'; checkpointS3Key: string; reason: string };

async function restorePriorCheckpointPatch(
  workspacePath: string,
  homeDir: string,
  priorCheckpoint: Uint8Array,
  signal: AbortSignal,
): Promise<boolean> {
  let parsed: { version?: unknown; partialPatch?: unknown; partialPatchSha256?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(priorCheckpoint).toString('utf8')) as {
      version?: unknown;
      partialPatch?: unknown;
      partialPatchSha256?: unknown;
    };
  } catch {
    return false;
  }
  if (parsed.version !== 1 || typeof parsed.partialPatch !== 'string' || !parsed.partialPatch) {
    return false;
  }
  const actualSha = createHash('sha256').update(parsed.partialPatch, 'utf8').digest('hex');
  if (typeof parsed.partialPatchSha256 !== 'string' || actualSha !== parsed.partialPatchSha256.toLowerCase()) {
    throw new Error('Prior checkpoint partialPatch SHA-256 mismatch');
  }
  const patchPath = join(homeDir, 'prior-checkpoint.patch');
  await writeFile(patchPath, parsed.partialPatch, 'utf8');
  const env = processEnvironment(homeDir);
  const applied = await runExecutable(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'apply', '--whitespace=nowarn', patchPath],
    {
      cwd: workspacePath,
      signal,
      timeoutMs: 60_000,
      env,
      maxOutputBytes: 256_000,
    },
  );
  if (applied.status !== 'passed') {
    throw new Error(`Failed to restore prior checkpoint patch: ${applied.stderr.slice(0, 1000)}`);
  }
  return true;
}

async function collectCleanPatch(workspacePath: string, baseCommit: string, homeDir: string, signal: AbortSignal): Promise<string> {
  const env = processEnvironment(homeDir);
  const indexDir = await mkdtemp(join(homeDir, 'idx-'));
  try {
    const isolatedEnv = { ...env, GIT_INDEX_FILE: join(indexDir, 'index') };
    const runGit = async (args: string[]) => {
      const res = await runExecutable('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
        cwd: workspacePath,
        signal,
        timeoutMs: 60_000,
        env: isolatedEnv,
        maxOutputBytes: 2_000_000,
      });
      if (res.status !== 'passed') throw new Error(`Git ${args[0]} failed: ${res.stderr.slice(0, 1000)}`);
      return res.stdout;
    };
    await runGit(['read-tree', baseCommit]);
    await runGit(['add', '--all']);
    return await runGit(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', baseCommit, '--']);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

export async function runAwsWorkerOnce(options: RunAwsWorkerOptions): Promise<AwsWorkerOutcome> {
  const flushTimeoutMs = options.spotFlushTimeoutMs ?? 90_000;
  const scratch = await mkdtemp(join(options.workRoot ?? tmpdir(), 'hivemind-aws-worker-'));
  const repoDir = join(scratch, 'repo');
  const homeDir = join(scratch, 'home');
  await mkdir(homeDir, { recursive: true });

  const workController = new AbortController();
  let spotInterrupted = false;
  const onSpot = () => {
    spotInterrupted = true;
    workController.abort(new Error('Fargate Spot SIGTERM'));
  };
  if (options.spotSignal?.aborted) {
    onSpot();
  } else {
    options.spotSignal?.addEventListener('abort', onSpot, { once: true });
  }

  try {
    const bundleBytes = await options.s3.getObject(options.bundleS3Key, options.bundleSha256, workController.signal);
    const bundlePath = join(scratch, 'pinned.bundle');
    await writeFile(bundlePath, bundleBytes);
    await restoreFromGitBundle(bundlePath, options.bundleSha256, options.baseCommit, repoDir, workController.signal);

    const priorCheckpoint = options.checkpointS3Key
      ? await options.s3.getObject(options.checkpointS3Key, undefined, workController.signal)
      : undefined;
    const restoredCheckpointPatch = priorCheckpoint
      ? await restorePriorCheckpointPatch(repoDir, homeDir, priorCheckpoint, workController.signal)
      : false;

    let execResult: { checkpointBytes?: Uint8Array; summary: string } | undefined;
    try {
      execResult = await options.executor.run({
        workspacePath: repoDir,
        baseCommit: options.baseCommit,
        taskId: options.taskId,
        runId: options.runId,
        iteration: options.iteration,
        priorCheckpoint,
        restoredCheckpointPatch,
        signal: workController.signal,
      });
    } catch (error) {
      if (!spotInterrupted) throw error;
    }

    if (spotInterrupted) {
      // Flush checkpoint + partial diff within Fargate Spot 120s SIGTERM window using a fresh bounded signal.
      const flushSignal = AbortSignal.timeout(flushTimeoutMs);
      let partialPatch = await collectCleanPatch(repoDir, options.baseCommit, homeDir, flushSignal).catch(() => '');
      try {
        assertPatchHasNoSecrets(partialPatch, options.forbiddenPatchValues ?? []);
      } catch {
        partialPatch = '';
      }
      const checkpointPayload = JSON.stringify({
        version: 1,
        taskId: options.taskId,
        runId: options.runId,
        iteration: options.iteration,
        partialPatchSha256: createHash('sha256').update(partialPatch, 'utf8').digest('hex'),
        partialPatch,
        hasSessionState: Boolean(execResult?.checkpointBytes?.byteLength),
      });
      const checkpointS3Key = `sessions/${options.taskId}/${options.runId}.json`;
      await options.s3.putObject(
        checkpointS3Key,
        Buffer.from(checkpointPayload, 'utf8'),
        'application/json',
        flushSignal,
      );
      const reason = 'Fargate Spot SIGTERM received; checkpoint flushed cleanly to S3';
      await options.control.reportSpotInterrupted({
        taskId: options.taskId,
        runId: options.runId,
        checkpointRef: checkpointS3Key,
        reason,
      });
      return { kind: 'spot_interrupted', checkpointS3Key, reason };
    }

    const patch = await collectCleanPatch(repoDir, options.baseCommit, homeDir, AbortSignal.timeout(60_000));
    assertPatchHasNoSecrets(patch, options.forbiddenPatchValues ?? []);
    const patchBytes = Buffer.from(patch, 'utf8');
    const patchS3Key = `patches/${options.taskId}/${options.runId}.patch`;
    const uploaded = await options.s3.putObject(patchS3Key, patchBytes, 'text/x-diff', AbortSignal.timeout(60_000));

    let completedCheckpointS3Key: string | undefined;
    if (options.preserveWorkspaceOnRetry) {
      completedCheckpointS3Key = `sessions/${options.taskId}/${options.runId}.json`;
      const checkpointPayload = JSON.stringify({
        version: 1,
        taskId: options.taskId,
        runId: options.runId,
        iteration: options.iteration,
        partialPatchSha256: uploaded.sha256,
        partialPatch: patch,
        hasSessionState: Boolean(execResult?.checkpointBytes?.byteLength),
      });
      await options.s3.putObject(
        completedCheckpointS3Key,
        Buffer.from(checkpointPayload, 'utf8'),
        'application/json',
        AbortSignal.timeout(60_000),
      );
    }

    if (execResult?.checkpointBytes?.byteLength) {
      await options.s3.putObject(
        `sessions/${options.taskId}/${options.runId}.bin`,
        execResult.checkpointBytes,
        'application/octet-stream',
        AbortSignal.timeout(60_000),
      );
    }

    return {
      kind: 'completed',
      patchS3Key,
      patchSha256: uploaded.sha256,
      summary: execResult?.summary ?? 'Worker execution completed',
      ...(completedCheckpointS3Key ? { checkpointS3Key: completedCheckpointS3Key } : {}),
    };
  } finally {
    options.spotSignal?.removeEventListener('abort', onSpot);
    await rm(scratch, { recursive: true, force: true });
  }
}
