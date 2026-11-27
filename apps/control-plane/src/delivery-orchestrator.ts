import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveryTask, DraftPrPublication, VerificationAttestation } from '../../../packages/contracts/src/delivery.js';
import type { RegionPlacementDecision, RegionRoutingPolicy } from '../../../packages/contracts/src/multi-region.js';
import type { LaunchEcsWorkloadInput } from '../../../packages/adapters/src/aws-ecs-driver.js';
import type { MultiRegionLaunchInput } from '../../../packages/adapters/src/aws-multi-region-driver.js';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import type { SpotPlacementFeedPort } from '../../../packages/adapters/src/spot-placement-feed.js';
import { publishVerifiedDraftPr, type GitHubDraftPrPort } from '../../../packages/adapters/src/draft-pr-publisher.js';
import { pathsInPatch, touchedProtectedPaths, type DeliveryStore } from '../../../packages/core/src/delivery.js';
import { selectOptimalSpotPlacement } from '../../../packages/core/src/multi-region.js';

export interface DeliveryOrchestratorOptions {
  /** Best-effort notification (issue #20). */
  notify?: (kind: 'auto_merge_refused', subject: string, message: string) => Promise<void>;
  /** Called after an auto-merge was refused; the periodic trigger uses it to stop itself. */
  onAutoMergeRefused?: (task: DeliveryTask, reason: string) => Promise<void>;
  store: DeliveryStore;
  s3: S3ObjectPort;
  ecs: {
    launchWorkload(
      input: LaunchEcsWorkloadInput & Partial<Pick<MultiRegionLaunchInput, 'targetRegion' | 'targetAzId'>>,
      signal?: AbortSignal,
    ): Promise<{ taskArn: string; region?: string; azId?: string | null }>;
    stop(externalRunId: string): Promise<void>;
    /** Lifecycle state of an ECS task, or `null` when ECS no longer knows it. */
    describeTask?(taskArn: string, signal?: AbortSignal): Promise<{ lastStatus: string; stopCode: string | null; stoppedReason: string | null; exitCode: number | null } | null>;
  };
  /**
   * How long a task may stay `running` after its ECS task stopped before reconcile fails it. A worker reports
   * its hand-off just before it exits, and the verifier is launched right after, so a short gap is normal.
   */
  orphanGraceMs?: number;
  spotFeed?: SpotPlacementFeedPort;
  defaultRoutingPolicy?: RegionRoutingPolicy;
  github?: GitHubDraftPrPort;
  githubFactory?: (context: {
    task: DeliveryTask;
    bundlePath: string;
    expectedBundleSha256: string;
    workRoot: string;
    signal: AbortSignal;
  }) => Promise<{ port: GitHubDraftPrPort; redactSecrets?: string[] }> | { port: GitHubDraftPrPort; redactSecrets?: string[] };
  workRoot?: string;
  redactSecrets?: string[];
  now?: () => number;
}

export interface DispatchResult {
  task: DeliveryTask;
  runId: string;
  ecsTaskArn: string;
  placement?: RegionPlacementDecision;
}

export class DeliveryOrchestrator {
  private readonly workRoot: string;
  private readonly now: () => number;

  constructor(private readonly options: DeliveryOrchestratorOptions) {
    if (!options.github && !options.githubFactory) {
      throw new Error('DeliveryOrchestrator requires github or githubFactory');
    }
    this.workRoot = options.workRoot ?? tmpdir();
    this.now = options.now ?? Date.now;
  }

  async evaluateSpotPlacement(
    overridePolicy?: Partial<RegionRoutingPolicy>,
    signal?: AbortSignal,
  ): Promise<RegionPlacementDecision> {
    const base = this.options.defaultRoutingPolicy ?? {
      primaryRegion: 'ap-northeast-2',
      allowedRegions: ['ap-northeast-2'],
      workloadClass: 'c.xlarge-arm',
    };
    const policy: RegionRoutingPolicy = {
      ...base,
      ...overridePolicy,
      allowedRegions: overridePolicy?.allowedRegions ?? base.allowedRegions,
      primaryRegion: overridePolicy?.primaryRegion ?? base.primaryRegion,
      workloadClass: overridePolicy?.workloadClass ?? base.workloadClass,
    };
    const snapshot = this.options.spotFeed ? await this.options.spotFeed.getSnapshot(signal) : null;
    return selectOptimalSpotPlacement(snapshot, policy, this.now());
  }

  async uploadAcceptanceSpec(task: DeliveryTask, signal?: AbortSignal): Promise<{ s3Key: string; sha256: string }> {
    const s3Key = `acceptance/${task.id}.json`;
    const uploaded = await this.options.s3.putObject(
      s3Key,
      Buffer.from(JSON.stringify(task.acceptance), 'utf8'),
      'application/json',
      signal,
    );
    return { s3Key, sha256: uploaded.sha256 };
  }

  async recordWorkerCompletion(
    taskId: string,
    runId: string,
    patchS3Key: string,
    patchSha256: string,
    signal?: AbortSignal,
  ): Promise<{ ecsTaskArn: string }> {
    const expectedKey = `patches/${taskId}/${runId}.patch`;
    if (patchS3Key !== expectedKey) {
      throw new Error('Worker patchS3Key does not match canonical run path');
    }
    if (!/^[a-f0-9]{64}$/i.test(patchSha256)) {
      throw new Error('Invalid worker patchSha256');
    }
    return this.dispatchVerifier(taskId, runId, patchS3Key, signal);
  }

  async dispatchWorker(
    taskId: string,
    signal?: AbortSignal,
    options?: { excludeRegions?: string[] },
  ): Promise<DispatchResult> {
    const current = await this.options.store.get(taskId);
    if (!current.bundle?.s3Key) {
      throw new Error('Delivery task requires an S3 bundle manifest before ECS dispatch');
    }

    let placement: RegionPlacementDecision | undefined;
    const routing = current.routing ?? this.options.defaultRoutingPolicy;
    if (routing && this.options.spotFeed) {
      const snapshot = await this.options.spotFeed.getSnapshot(signal);
      const mergedExcluded = [
        ...(routing.excludeRegions ?? []),
        ...(options?.excludeRegions ?? []),
      ];
      placement = selectOptimalSpotPlacement(
        snapshot,
        {
          ...routing,
          ...(mergedExcluded.length ? { excludeRegions: [...new Set(mergedExcluded)] } : {}),
        },
        this.now(),
      );
      await this.options.store.recordPlacementDecision(taskId, placement);
    }

    const runId = `run-${randomUUID()}`;
    const workerId = `ecs-spot-${placement?.selectedRegion ?? 'primary'}-${runId.slice(4, 12)}`;
    const started = await this.options.store.startIteration(taskId, workerId, runId);

    const launched = await this.options.ecs.launchWorkload(
      {
        kind: 'worker',
        taskId: started.id,
        runId,
        iteration: started.currentIteration,
        bundleS3Key: current.bundle.s3Key,
        bundleSha256: current.bundle.bundleSha256,
        acceptanceDigest: started.acceptance.digest,
        ...(started.latestCheckpointRef ? { checkpointS3Key: started.latestCheckpointRef } : {}),
        ...(placement ? { targetRegion: placement.selectedRegion, targetAzId: placement.selectedAzId } : {}),
      },
      signal,
    );
    await this.options.store.recordActiveEcsTask(started.id, runId, launched.taskArn);
    return { task: started, runId, ecsTaskArn: launched.taskArn, ...(placement ? { placement } : {}) };
  }

  async dispatchVerifier(
    taskId: string,
    runId: string,
    patchS3Key: string,
    signal?: AbortSignal,
  ): Promise<{ ecsTaskArn: string }> {
    const task = await this.options.store.get(taskId);
    if (task.status !== 'running' || task.activeRunId !== runId) {
      throw new Error('Cannot dispatch verifier: task is not running for this runId');
    }
    if (!task.bundle?.s3Key) {
      throw new Error('Delivery task bundle S3 key is missing');
    }
    const launched = await this.options.ecs.launchWorkload(
      {
        kind: 'verifier',
        taskId: task.id,
        runId,
        iteration: task.currentIteration,
        bundleS3Key: task.bundle.s3Key,
        bundleSha256: task.bundle.bundleSha256,
        acceptanceDigest: task.acceptance.digest,
        patchS3Key,
        ...(task.activeRegion ? { targetRegion: task.activeRegion } : {}),
      },
      signal,
    );
    await this.options.store.recordActiveEcsTask(task.id, runId, launched.taskArn);
    return { ecsTaskArn: launched.taskArn };
  }

  async handleSpotInterruption(
    taskId: string,
    runId: string,
    checkpointS3Key: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ task: DeliveryTask; redispatched?: DispatchResult }> {
    const interruptedRegion = (await this.options.store.get(taskId)).activeRegion;
    const updated = await this.options.store.recordSpotInterruption(taskId, runId, checkpointS3Key, reason);
    if (updated.status === 'queued') {
      // Automatically exclude the interrupted region so multi-region failover picks the next best region.
      const redispatched = await this.dispatchWorker(taskId, signal, {
        ...(interruptedRegion ? { excludeRegions: [interruptedRegion] } : {}),
      });
      return { task: redispatched.task, redispatched };
    }
    return { task: updated };
  }

  async handleVerification(
    taskId: string,
    attestation: VerificationAttestation,
    patchS3Key: string,
    signal: AbortSignal,
  ): Promise<{
    task: DeliveryTask;
    publication?: DraftPrPublication;
    retried?: DispatchResult;
  }> {
    const updated = await this.options.store.recordVerification(taskId, attestation);

    if (updated.status === 'queued') {
      // Failed verification within maxIterations -> automatically launch next Ralph loop iteration.
      const retried = await this.dispatchWorker(taskId, signal);
      return { task: retried.task, retried };
    }

    if (updated.status !== 'verified' || !updated.latestAttestation) {
      return { task: updated };
    }
    const verifiedAttestation = updated.latestAttestation;

    if (!updated.bundle?.s3Key) {
      throw new Error('Cannot publish Draft PR: bundle S3 key missing');
    }

    // Download verified bundle and patch with SHA-256 checks; never execute model code here.
    const scratch = await mkdtemp(join(this.workRoot, 'hivemind-pub-'));
    try {
      const bundleBytes = await this.options.s3.getObject(
        updated.bundle.s3Key,
        updated.bundle.bundleSha256,
        signal,
      );
      const patchBytes = await this.options.s3.getObject(patchS3Key, verifiedAttestation.patchSha256, signal);
      const patchText = Buffer.from(patchBytes).toString('utf8');
      const actualPatchSha = createHash('sha256').update(patchText, 'utf8').digest('hex');
      if (actualPatchSha !== verifiedAttestation.patchSha256) {
        throw new Error('Downloaded patch SHA-256 does not match attestation');
      }

      const bundlePath = join(scratch, 'pinned.bundle');
      await writeFile(bundlePath, bundleBytes);

      const resolvedGithub = this.options.githubFactory
        ? await this.options.githubFactory({
            task: updated,
            bundlePath,
            expectedBundleSha256: updated.bundle.bundleSha256,
            workRoot: scratch,
            signal,
          })
        : { port: this.options.github!, redactSecrets: [] };

      const publication = await publishVerifiedDraftPr(
        {
          task: updated,
          attestation: verifiedAttestation,
          bundlePath,
          expectedBundleSha256: updated.bundle.bundleSha256,
          patch: patchText,
          workRoot: scratch,
          github: resolvedGithub.port,
          ...(updated.latestWorkerSummary ? { workerSummary: updated.latestWorkerSummary } : {}),
          redactSecrets: [...(this.options.redactSecrets ?? []), ...(resolvedGithub.redactSecrets ?? [])],
          now: this.now,
        },
        signal,
      );

      const published = await this.options.store.recordDraftPrPublication(taskId, publication);
      if (published.delivery.autoMerge) {
        const merged = await this.autoMerge(published, patchText, resolvedGithub.port, signal);
        return { task: merged, publication };
      }
      return { task: published, publication };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Auto-merge (issue #20): merges a verified Draft PR into the base branch unless the change touches a
   * protected path. A refusal is recorded, reported, and handed to `onAutoMergeRefused` (which stops the
   * periodic trigger) so a change to a safety mechanism never lands without a person.
   */
  private async autoMerge(task: DeliveryTask, patch: string, github: GitHubDraftPrPort, signal: AbortSignal): Promise<DeliveryTask> {
    const refuse = async (reason: string, touched: string[] = []) => {
      const refused = await this.options.store.recordAutoMerge(task.id, { outcome: 'refused', reason, touchedProtectedPaths: touched });
      await this.options.notify?.('auto_merge_refused', `HIVEMIND auto-merge refused: ${task.delivery.repository}`, `Task ${task.id} (${task.publication?.prUrl ?? ''}) was not merged: ${reason}${touched.length ? ` Paths: ${touched.slice(0, 20).join(', ')}` : ''}`);
      await this.options.onAutoMergeRefused?.(refused, reason);
      return refused;
    };
    if (!this.options.store.autoMergeAllowed(task)) return refuse('The repository is not allowed to auto-merge on this Control Plane.');
    const touched = touchedProtectedPaths(pathsInPatch(patch), task.delivery.protectedPaths ?? []);
    if (touched.length) return refuse('The change touches protected paths.', touched);
    if (!github.mergePullRequest || !task.publication) return refuse('This GitHub connection cannot merge pull requests.');
    try {
      const { mergeCommitSha } = await github.mergePullRequest(
        { repository: task.delivery.repository, prNumber: task.publication.prNumber, expectedHeadSha: task.publication.commitSha, title: task.title },
        signal,
      );
      return await this.options.store.recordAutoMerge(task.id, { outcome: 'merged', mergeCommitSha });
    } catch (error) {
      return refuse(`GitHub merge failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    }
  }

  /**
   * Finds `running` tasks whose ECS task (worker or verifier) stopped or is unknown to ECS, and fails them.
   * Without this a task whose worker was killed before it could report stays `running` forever.
   * A task without a recorded ECS task (created before the field existed) is left alone.
   */
  async reconcileRunningTasks(signal?: AbortSignal): Promise<DeliveryReconcileResult> {
    const graceMs = this.options.orphanGraceMs ?? 120_000;
    const running = (await this.options.store.list()).filter((t) => t.status === 'running' && t.activeRunId);
    const result: DeliveryReconcileResult = { checked: running.length, failed: [], untouched: [] };
    const describe = this.options.ecs.describeTask?.bind(this.options.ecs);
    for (const task of running) {
      if (!task.activeEcsTaskArn) {
        result.untouched.push({ taskId: task.id, reason: 'no ECS task recorded; cancel the task if its worker is gone' });
        continue;
      }
      if (!describe) {
        result.untouched.push({ taskId: task.id, reason: 'ECS task status lookup is not configured' });
        continue;
      }
      let status: Awaited<ReturnType<typeof describe>>;
      try {
        status = await describe(task.activeEcsTaskArn, signal);
      } catch (error) {
        result.untouched.push({
          taskId: task.id,
          reason: `ECS task status lookup failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        });
        continue;
      }
      if (status && status.lastStatus !== 'STOPPED') {
        result.untouched.push({ taskId: task.id, reason: `ECS task is ${status.lastStatus}` });
        continue;
      }
      const idleMs = this.now() - Date.parse(task.updatedAt);
      if (idleMs < graceMs) {
        result.untouched.push({ taskId: task.id, reason: `ECS task ended ${Math.round(idleMs / 1000)}s ago; within the hand-off grace period` });
        continue;
      }
      const reason = status
        ? `ECS task stopped without reporting a result (${[status.stopCode, status.exitCode !== null ? `exit ${status.exitCode}` : null, status.stoppedReason].filter(Boolean).join('; ') || 'no stop detail'})`
        : 'ECS task is no longer known to ECS and never reported a result';
      const updated = await this.options.store.failOrphanedRun(task.id, task.activeRunId!, reason);
      if (updated.status === 'failed' && updated.failureReason === reason) {
        result.failed.push({ taskId: task.id, title: task.title, reason });
      }
    }
    return result;
  }

  /** Cancels a task and asks ECS to stop the task that executes it, so no worker keeps running. */
  async cancelTask(taskId: string, reason: string): Promise<{ task: DeliveryTask; stoppedEcsTask: boolean; stopError: string | null }> {
    const before = await this.options.store.get(taskId);
    const cancelled = await this.options.store.cancel(taskId, reason);
    let stoppedEcsTask = false;
    let stopError: string | null = null;
    if (before.status === 'running' && before.activeEcsTaskArn) {
      try {
        await this.options.ecs.stop(before.activeEcsTaskArn);
        stoppedEcsTask = true;
      } catch (error) {
        stopError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
    }
    return { task: cancelled, stoppedEcsTask, stopError };
  }
}

export interface DeliveryReconcileResult {
  checked: number;
  failed: { taskId: string; title: string; reason: string }[];
  untouched: { taskId: string; reason: string }[];
}
