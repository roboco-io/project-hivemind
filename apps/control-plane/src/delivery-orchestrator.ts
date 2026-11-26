import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveryTask, DraftPrPublication, VerificationAttestation } from '../../../packages/contracts/src/delivery.js';
import type { AwsEcsFargateSpotDriver } from '../../../packages/adapters/src/aws-ecs-driver.js';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { publishVerifiedDraftPr, type GitHubDraftPrPort } from '../../../packages/adapters/src/draft-pr-publisher.js';
import type { DeliveryStore } from '../../../packages/core/src/delivery.js';

export interface DeliveryOrchestratorOptions {
  store: DeliveryStore;
  s3: S3ObjectPort;
  ecs: Pick<AwsEcsFargateSpotDriver, 'launchWorkload' | 'stop'>;
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

  async dispatchWorker(taskId: string, signal?: AbortSignal): Promise<DispatchResult> {
    const current = this.options.store.get(taskId);
    if (!current.bundle?.s3Key) {
      throw new Error('Delivery task requires an S3 bundle manifest before ECS dispatch');
    }
    const runId = `run-${randomUUID()}`;
    const workerId = `ecs-spot-${runId.slice(4, 12)}`;
    const started = this.options.store.startIteration(taskId, workerId, runId);

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
      },
      signal,
    );
    return { task: started, runId, ecsTaskArn: launched.taskArn };
  }

  async dispatchVerifier(
    taskId: string,
    runId: string,
    patchS3Key: string,
    signal?: AbortSignal,
  ): Promise<{ ecsTaskArn: string }> {
    const task = this.options.store.get(taskId);
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
      },
      signal,
    );
    return { ecsTaskArn: launched.taskArn };
  }

  async handleSpotInterruption(
    taskId: string,
    runId: string,
    checkpointS3Key: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<{ task: DeliveryTask; redispatched?: DispatchResult }> {
    const updated = this.options.store.recordSpotInterruption(taskId, runId, checkpointS3Key, reason);
    if (updated.status === 'queued') {
      const redispatched = await this.dispatchWorker(taskId, signal);
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
    const updated = this.options.store.recordVerification(taskId, attestation);

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

      const published = this.options.store.recordDraftPrPublication(taskId, publication);
      return { task: published, publication };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
