import type {
  ModelArtifactReceipt,
  ModelFactoryJob,
  ModelReleaseAttestation,
  ModelReleaseDecision,
  ModelReleasePublication,
} from '../../../packages/contracts/src/model-factory.js';
import type {
  Ec2SpotTrainerPort,
  ExpiredSpotSweepResult,
} from '../../../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import type { SpotPlacementFeedPort } from '../../../packages/adapters/src/spot-placement-feed.js';
import type { ModelFactoryStore } from '../../../packages/core/src/model-factory.js';
import { selectOptimalSpotPlacement } from '../../../packages/core/src/multi-region.js';

export interface TrustedHfReleasePublisherPort {
  publish(input: {
    job: ModelFactoryJob;
    receipt: ModelArtifactReceipt;
    attestation: ModelReleaseAttestation;
    signal?: AbortSignal;
  }): Promise<ModelReleasePublication>;
}

export interface ModelFactoryOrchestratorOptions {
  store: ModelFactoryStore;
  ec2: Ec2SpotTrainerPort;
  s3: S3ObjectPort;
  hfPublisher?: TrustedHfReleasePublisherPort;
  spotFeed?: SpotPlacementFeedPort;
  wakeIntervalMs?: number;
  now?: () => number;
}

export class ModelFactoryOrchestrator {
  private readonly wakeIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ModelFactoryOrchestratorOptions) {
    this.wakeIntervalMs = options.wakeIntervalMs ?? 300_000; // 5m default long-running wake interval
    this.now = options.now ?? Date.now;
  }

  async approveAndLaunchTraining(
    jobId: string,
    approvalFingerprint: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ModelFactoryJob> {
    const approved = this.options.store.approveTraining(jobId, approvalFingerprint, reason);
    let availabilityZoneId = approved.compute.availabilityZoneId;

    if (!availabilityZoneId && approved.compute.workloadClass && this.options.spotFeed) {
      const snapshot = await this.options.spotFeed.getSnapshot(signal).catch(() => null);
      if (snapshot) {
        const decision = selectOptimalSpotPlacement(
          snapshot,
          {
            primaryRegion: approved.compute.region,
            allowedRegions: [approved.compute.region],
            workloadClass: approved.compute.workloadClass,
            maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
          },
          this.now(),
        );
        if (decision.selectedAzId) {
          availabilityZoneId = decision.selectedAzId;
        }
      }
    }

    const nowMs = this.now();
    const expiresAtIso = new Date(nowMs + approved.compute.maxLifetimeMs).toISOString();
    const nextWakeAt = new Date(nowMs + Math.min(this.wakeIntervalMs, approved.compute.maxLifetimeMs)).toISOString();

    try {
      const launched = await this.options.ec2.launchSpotInstance(
        {
          jobId: approved.id,
          modelId: approved.modelId,
          region: approved.compute.region,
          ...(availabilityZoneId ? { availabilityZoneId } : {}),
          instanceType: approved.compute.instanceType,
          amiId: approved.compute.amiId,
          maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
          expiresAtIso,
          ...(approved.compute.subnetId ? { subnetId: approved.compute.subnetId } : {}),
          ...(approved.compute.securityGroupIds ? { securityGroupIds: approved.compute.securityGroupIds } : {}),
          ...(approved.compute.instanceProfileArn ? { instanceProfileArn: approved.compute.instanceProfileArn } : {}),
          ...(approved.compute.userDataScript !== undefined ? { userDataScript: approved.compute.userDataScript } : {}),
        },
        signal,
      );

      return this.options.store.recordInstanceLaunched(approved.id, {
        region: launched.region,
        availabilityZone: launched.availabilityZone,
        instanceId: launched.instanceId,
        instanceType: launched.instanceType,
        amiId: launched.amiId,
        expiresAt: expiresAtIso,
        nextWakeAt,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.options.store.fail(approved.id, `EC2 Spot launch failed: ${msg}`);
    }
  }

  private async tryLoadS3Receipt(job: ModelFactoryJob, signal?: AbortSignal): Promise<ModelArtifactReceipt | null> {
    const receiptKey = `${job.compute.s3ArtifactPrefix}/receipt.json`;
    try {
      const raw = await this.options.s3.getObject(receiptKey, undefined, signal);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ModelArtifactReceipt;
      return parsed;
    } catch {
      return null;
    }
  }

  private calculateActualCostMicros(job: ModelFactoryJob, endedMs: number): { actualCostMicros: number; instanceSeconds: number } {
    const launchedMs = job.instance?.launchedAt ? Date.parse(job.instance.launchedAt) : endedMs;
    const elapsedSeconds = Math.max(1, Math.ceil(Math.max(0, endedMs - launchedMs) / 1000));
    const billedSeconds = Math.max(60, elapsedSeconds); // AWS EC2 Linux per-second billing (60s minimum)
    const rawMicros = Math.ceil((billedSeconds / 3600) * job.compute.maxHourlyPriceUsd * 1_000_000);
    return {
      actualCostMicros: Math.min(rawMicros, job.cost.reservedMicros || rawMicros),
      instanceSeconds: billedSeconds,
    };
  }

  async wakeJob(jobId: string, signal?: AbortSignal): Promise<ModelFactoryJob> {
    let job = this.options.store.get(jobId);
    if (job.status !== 'training_running' || !job.instance) {
      return job;
    }

    const nowMs = this.now();
    const expiresAtMs = Date.parse(job.instance.expiresAt);
    const described = await this.options.ec2.describeInstance(job.instance.region, job.instance.instanceId, signal);

    let effectiveState = described.state;
    let forcedReason: string | undefined;

    if (nowMs >= expiresAtMs && (effectiveState === 'pending' || effectiveState === 'running' || effectiveState === 'stopping' || effectiveState === 'stopped')) {
      forcedReason = `TTL Guard forced termination: exceeded maxLifetimeMs (${job.instance.expiresAt})`;
      const terminated = await this.options.ec2.terminateInstance(job.instance.region, job.instance.instanceId, signal);
      effectiveState = terminated.state;
    }

    const isEnded = effectiveState === 'terminated' || effectiveState === 'shutting-down' || effectiveState === 'stopped';
    const nextWakeAt = isEnded ? null : new Date(Math.min(nowMs + this.wakeIntervalMs, expiresAtMs)).toISOString();

    job = this.options.store.recordWakeUpdate(job.id, {
      state: effectiveState,
      nextWakeAt,
      ...(forcedReason ? { forcedTerminationReason: forcedReason, diagnostic: forcedReason } : {}),
    });

    const receipt = await this.tryLoadS3Receipt(job, signal);
    if (receipt) {
      job = this.options.store.recordArtifactReceipt(job.id, receipt);
    }

    if (isEnded && job.cost.settledMicros === null) {
      const settlement = this.calculateActualCostMicros(job, nowMs);
      job = this.options.store.settleCost(job.id, {
        ...settlement,
        ...(forcedReason ? { diagnostic: 'Settled after TTL Guard forced termination' } : {}),
      });
    }

    if (isEnded && !job.receipt) {
      const reason =
        forcedReason ??
        `EC2 Spot instance ${job.instance!.instanceId} ended (${effectiveState}) without S3 artifact receipt${described.stateReason ? `: ${described.stateReason}` : ''}`;
      job = this.options.store.fail(job.id, reason);
    }

    return job;
  }

  async wakeDueJobs(signal?: AbortSignal): Promise<{ woken: ModelFactoryJob[]; sweeps: ExpiredSpotSweepResult[] }> {
    const due = this.options.store.listDueWakeJobs(this.now());
    const woken: ModelFactoryJob[] = [];
    const activeRegions = new Set<string>();
    for (const job of due) {
      if (job.instance?.region) activeRegions.add(job.instance.region);
      woken.push(await this.wakeJob(job.id, signal));
    }
    const sweeps: ExpiredSpotSweepResult[] = [];
    for (const region of activeRegions) {
      sweeps.push(await this.options.ec2.sweepExpiredSpotInstances(region, this.now(), signal));
    }
    return { woken, sweeps };
  }

  async sweepExpired(region: string, signal?: AbortSignal): Promise<ExpiredSpotSweepResult> {
    return this.options.ec2.sweepExpiredSpotInstances(region, this.now(), signal);
  }

  async cancelJob(jobId: string, reason: string, signal?: AbortSignal): Promise<ModelFactoryJob> {
    const current = this.options.store.get(jobId);
    if (current.instance && current.instance.state !== 'terminated') {
      await this.options.ec2.terminateInstance(current.instance.region, current.instance.instanceId, signal);
    }
    let cancelled = this.options.store.cancel(jobId, reason);
    if (cancelled.instance && cancelled.cost.settledMicros === null) {
      const settlement = this.calculateActualCostMicros(cancelled, this.now());
      cancelled = this.options.store.settleCost(jobId, {
        ...settlement,
        diagnostic: 'Settled on operator cancellation',
      });
    }
    return cancelled;
  }

  async approveAndPublishRelease(
    jobId: string,
    decision: Omit<ModelReleaseDecision, 'decidedAt'>,
    signal?: AbortSignal,
  ): Promise<ModelFactoryJob> {
    const decided = this.options.store.recordReleaseDecision(jobId, decision);
    if (decided.status !== 'release_approved') {
      return decided;
    }

    if (decided.releasePolicy.mode === 's3_artifact_only') {
      return this.options.store.recordReleasePublication(decided.id, {
        mode: 's3_artifact_only',
        manifestDigest: decided.receipt!.manifestDigest,
        publishedAt: new Date(this.now()).toISOString(),
      });
    }

    if (!this.options.hfPublisher) {
      return this.options.store.fail(
        decided.id,
        'Trusted Hugging Face release publisher is not configured on Control Plane (never silently skipped)',
      );
    }

    const publication = await this.options.hfPublisher.publish({
      job: decided,
      receipt: decided.receipt!,
      attestation: decided.releaseAttestation!,
      signal,
    });
    return this.options.store.recordReleasePublication(decided.id, publication);
  }
}
