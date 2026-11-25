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
  s3: S3ObjectPort;
  control: AwsWorkerControlPort;
  executor: AwsWorkerExecutor;
  spotSignal?: AbortSignal;
  spotFlushTimeoutMs?: number;
  workRoot?: string;
}

export type AwsWorkerOutcome =
  | { kind: 'completed'; patchS3Key: string; patchSha256: string; summary: string }
  | { kind: 'spot_interrupted'; checkpointS3Key: string; reason: string };

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

    let execResult: { checkpointBytes?: Uint8Array; summary: string } | undefined;
    try {
      execResult = await options.executor.run({
        workspacePath: repoDir,
        baseCommit: options.baseCommit,
        taskId: options.taskId,
        runId: options.runId,
        iteration: options.iteration,
        priorCheckpoint,
        signal: workController.signal,
      });
    } catch (error) {
      if (!spotInterrupted) throw error;
    }

    if (spotInterrupted) {
      // Flush checkpoint + partial diff within Fargate Spot 120s SIGTERM window using a fresh bounded signal.
      const flushSignal = AbortSignal.timeout(flushTimeoutMs);
      const partialPatch = await collectCleanPatch(repoDir, options.baseCommit, homeDir, flushSignal).catch(() => '');
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
    const patchBytes = Buffer.from(patch, 'utf8');
    const patchS3Key = `patches/${options.taskId}/${options.runId}.patch`;
    const uploaded = await options.s3.putObject(patchS3Key, patchBytes, 'text/x-diff', AbortSignal.timeout(60_000));

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
    };
  } finally {
    options.spotSignal?.removeEventListener('abort', onSpot);
    await rm(scratch, { recursive: true, force: true });
  }
}
