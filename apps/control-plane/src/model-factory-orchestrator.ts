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
  artifactsBucket?: string;
  artifactsRegion?: string;
  defaultInstanceProfileArn?: string;
  allowedInstanceProfileArns?: string[];
  hfPublisher?: TrustedHfReleasePublisherPort;
  spotFeed?: SpotPlacementFeedPort;
  wakeIntervalMs?: number;
  now?: () => number;
}

const MAX_INLINE_INPUT_VERIFY_BYTES = 5 * 1024 * 1024; // 5 MiB full SHA-256 preflight; larger verified via HEAD size + instance-side SHA-256

function shellSingleQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Unsafe control character in bootstrap environment value');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function composeTrainingUserData(
  job: ModelFactoryJob,
  envMeta: { artifactsBucket?: string; artifactsRegion?: string },
): string | undefined {
  if (job.compute.userDataScript === undefined) return undefined;
  const lines = [
    `export HIVEMIND_JOB_ID=${shellSingleQuote(job.id)}`,
    `export HIVEMIND_MODEL_ID=${shellSingleQuote(job.modelId)}`,
    `export HIVEMIND_ARTIFACT_PREFIX=${shellSingleQuote(job.compute.s3ArtifactPrefix)}`,
  ];
  if (envMeta.artifactsBucket) {
    lines.push(`export HIVEMIND_ARTIFACTS_BUCKET=${shellSingleQuote(envMeta.artifactsBucket)}`);
  }
  if (envMeta.artifactsRegion) {
    lines.push(`export HIVEMIND_ARTIFACTS_REGION=${shellSingleQuote(envMeta.artifactsRegion)}`);
  }
  if (job.compute.inputs) {
    const manifestB64 = Buffer.from(JSON.stringify(job.compute.inputs), 'utf8').toString('base64');
    lines.push(`export HIVEMIND_INPUTS_PREFIX=${shellSingleQuote(job.compute.inputs.s3Prefix)}`);
    lines.push(`export HIVEMIND_INPUTS_DIGEST=${shellSingleQuote(job.compute.inputs.digest)}`);
    lines.push(`export HIVEMIND_INPUTS_MANIFEST_B64=${shellSingleQuote(manifestB64)}`);
  }
  const header = ['# --- HIVEMIND pinned job metadata (injected by Control Plane) ---', ...lines, '# --- end HIVEMIND metadata ---'].join('\n');
  const script = job.compute.userDataScript;
  let combined: string;
  if (script.startsWith('#!')) {
    const nl = script.indexOf('\n');
    combined = nl === -1 ? `${script}\n${header}\n` : `${script.slice(0, nl + 1)}${header}\n${script.slice(nl + 1)}`;
  } else {
    combined = `#!/bin/bash\n${header}\n${script}`;
  }
  if (Buffer.byteLength(combined, 'utf8') > 16_384) {
    throw new Error('Composed userDataScript with HIVEMIND metadata exceeds EC2 16384-byte limit');
  }
  return combined;
}

export class ModelFactoryOrchestrator {
  private readonly wakeIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ModelFactoryOrchestratorOptions) {
    this.wakeIntervalMs = options.wakeIntervalMs ?? 300_000; // 5m default long-running wake interval
    this.now = options.now ?? Date.now;
  }

  private resolveApprovedInstanceProfileArn(requested?: string): string | undefined {
    const allowed = new Set<string>([
      ...(this.options.allowedInstanceProfileArns ?? []),
      ...(this.options.defaultInstanceProfileArn ? [this.options.defaultInstanceProfileArn] : []),
    ]);
    if (requested) {
      if (allowed.size === 0 || !allowed.has(requested)) {
        throw new Error(
          `Requested instanceProfileArn is not in Control Plane allowlist: ${requested}`,
        );
      }
      return requested;
    }
    return this.options.defaultInstanceProfileArn;
  }

  private async verifyPinnedInputsInS3(job: ModelFactoryJob, signal?: AbortSignal): Promise<void> {
    if (!job.compute.inputs) return;
    const { s3Prefix, files } = job.compute.inputs;
    for (const file of files) {
      const key = `${s3Prefix}/${file.path}`;
      if (file.sizeBytes <= MAX_INLINE_INPUT_VERIFY_BYTES) {
        const bytes = await this.options.s3.getObject(key, file.sha256, signal);
        if (bytes.byteLength !== file.sizeBytes) {
          throw new Error(`Pinned input size mismatch for ${key}: expected ${file.sizeBytes}, got ${bytes.byteLength}`);
        }
      } else if (this.options.s3.headObject) {
        const head = await this.options.s3.headObject(key, signal);
        if (head.contentLength !== file.sizeBytes) {
          throw new Error(`Pinned input size mismatch for ${key}: expected ${file.sizeBytes}, got ${head.contentLength}`);
        }
      }
    }
  }

  async approveAndLaunchTraining(
    jobId: string,
    approvalFingerprint: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ModelFactoryJob> {
    const approved = this.options.store.approveTraining(jobId, approvalFingerprint, reason);
    const baseCandidates = approved.compute.candidateRegions?.length
      ? approved.compute.candidateRegions
      : [approved.compute.region];

    // Rank candidate regions by 6-hourly Spot Placement Score stability & lowest price (5-region GPU Spot auto-routing).
    const rankedTargets: { region: string; azId?: string }[] = [];
    const snapshot = this.options.spotFeed ? await this.options.spotFeed.getSnapshot(signal).catch(() => null) : null;
    if (snapshot && baseCandidates.length > 1) {
      const remaining = [...baseCandidates];
      while (remaining.length > 0) {
        try {
          const decision = selectOptimalSpotPlacement(
            snapshot,
            {
              primaryRegion: remaining[0]!,
              allowedRegions: remaining,
              workloadClass: approved.compute.workloadClass ?? 'g6e.12xlarge',
              maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
            },
            this.now(),
          );
          rankedTargets.push({
            region: decision.selectedRegion,
            ...(decision.selectedAzId ? { azId: decision.selectedAzId } : {}),
          });
          const idx = remaining.indexOf(decision.selectedRegion);
          remaining.splice(idx >= 0 ? idx : 0, 1);
        } catch (err) {
          if (rankedTargets.length === 0) throw err;
          break;
        }
      }
    } else {
      for (const r of baseCandidates) {
        let azId = r === approved.compute.region ? approved.compute.availabilityZoneId : undefined;
        if (!azId && snapshot && approved.compute.workloadClass) {
          const decision = selectOptimalSpotPlacement(
            snapshot,
            {
              primaryRegion: r,
              allowedRegions: [r],
              workloadClass: approved.compute.workloadClass,
              maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
            },
            this.now(),
          );
          if (decision.selectedAzId) azId = decision.selectedAzId;
        }
        rankedTargets.push({ region: r, ...(azId ? { azId } : {}) });
      }
    }

    const nowMs = this.now();
    const expiresAtIso = new Date(nowMs + approved.compute.maxLifetimeMs).toISOString();
    const nextWakeAt = new Date(nowMs + Math.min(this.wakeIntervalMs, approved.compute.maxLifetimeMs)).toISOString();

    try {
      const instanceProfileArn = this.resolveApprovedInstanceProfileArn(approved.compute.instanceProfileArn);
      await this.verifyPinnedInputsInS3(approved, signal);
      const userDataScript = composeTrainingUserData(approved, {
        artifactsBucket: this.options.artifactsBucket,
        artifactsRegion: this.options.artifactsRegion,
      });

      const extraTags: Record<string, string> = {
        'hivemind:artifact-prefix': approved.compute.s3ArtifactPrefix,
        ...(this.options.artifactsBucket ? { 'hivemind:artifact-bucket': this.options.artifactsBucket } : {}),
        ...(this.options.artifactsRegion ? { 'hivemind:artifact-region': this.options.artifactsRegion } : {}),
        ...(approved.compute.inputs
          ? {
              'hivemind:inputs-prefix': approved.compute.inputs.s3Prefix,
              'hivemind:inputs-digest': approved.compute.inputs.digest,
            }
          : {}),
      };

      const attemptErrors: string[] = [];
      for (const target of rankedTargets) {
        const override = approved.compute.regionOverrides?.[target.region];
        const amiId = override?.amiId ?? approved.compute.amiId;
        const securityGroupIds = override?.securityGroupIds ?? approved.compute.securityGroupIds;
        const candidateSubnets =
          override?.subnetIds?.length
            ? override.subnetIds
            : approved.compute.subnetId
              ? [approved.compute.subnetId]
              : [undefined];

        for (const subnetId of candidateSubnets) {
          try {
            const launched = await this.options.ec2.launchSpotInstance(
              {
                jobId: approved.id,
                modelId: approved.modelId,
                region: target.region,
                ...(!subnetId && target.azId ? { availabilityZoneId: target.azId } : {}),
                instanceType: approved.compute.instanceType,
                amiId,
                maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
                expiresAtIso,
                ...(subnetId ? { subnetId } : {}),
                ...(securityGroupIds ? { securityGroupIds } : {}),
                ...(instanceProfileArn ? { instanceProfileArn } : {}),
                ...(userDataScript !== undefined ? { userDataScript } : {}),
                extraTags,
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
          } catch (attemptError) {
            const msg = attemptError instanceof Error ? attemptError.message : String(attemptError);
            attemptErrors.push(`${target.region}${subnetId ? `/${subnetId}` : ''}: ${msg}`);
            // Only fail over on capacity/spot availability errors; immediately rethrow IAM/parameter/auth errors.
            if (!/InsufficientInstanceCapacity|SpotMaxPriceTooLow|Unsupported|MaxSpotInstanceCountExceeded/i.test(msg)) {
              throw attemptError;
            }
          }
        }
      }

      throw new Error(`All candidate regions/subnets exhausted: ${attemptErrors.join(' | ')}`);
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
      if (this.options.s3.headObject && Array.isArray(parsed.files)) {
        for (const file of parsed.files) {
          const objKey = `${job.compute.s3ArtifactPrefix}/${file.path}`;
          const head = await this.options.s3.headObject(objKey, signal);
          if (head.contentLength !== file.sizeBytes) {
            throw new Error(`Artifact size mismatch for ${objKey}: expected ${file.sizeBytes}, got ${head.contentLength}`);
          }
        }
      }
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
    const needsTrainingWake = job.status === 'training_running';
    const needsSettlementWake = Boolean(job.instance && job.cost.settledMicros === null);
    if (!job.instance || (!needsTrainingWake && !needsSettlementWake)) {
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

    if (!job.receipt) {
      const receipt = await this.tryLoadS3Receipt(job, signal);
      if (receipt) {
        job = this.options.store.recordArtifactReceipt(job.id, receipt);
      }
    }

    if (isEnded && job.cost.settledMicros === null) {
      const settlement = this.calculateActualCostMicros(job, nowMs);
      job = this.options.store.settleCost(job.id, {
        ...settlement,
        ...(forcedReason ? { diagnostic: 'Settled after TTL Guard forced termination' } : {}),
      });
    }

    if (isEnded && !job.receipt && job.status === 'training_running') {
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
