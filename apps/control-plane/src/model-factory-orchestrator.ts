import type {
  ModelArtifactReceipt,
  ModelFactoryJob,
  ModelReleaseAttestation,
  ModelReleaseDecision,
  ModelReleasePublication,
  TrainingPlacementPlan,
} from '../../../packages/contracts/src/model-factory.js';
import type {
  Ec2SpotTrainerPort,
  ExpiredSpotSweepResult,
} from '../../../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import {
  PUBLIC_AMI_SSM_PARAMETER_PATTERN,
  type PublicAmiResolverPort,
} from '../../../packages/adapters/src/aws-ssm-public-ami.js';
import type { SpotPlacementFeedPort } from '../../../packages/adapters/src/spot-placement-feed.js';
import type { ModelFactoryStore } from '../../../packages/core/src/model-factory.js';
import { DomainError } from '../../../packages/core/src/store.js';
import { calculateActualCostMicros } from '../../../packages/core/src/model-factory-guard-settlement.js';
import {
  type LivePlacementScores,
  orderSubnetsByPlannedAzs,
  planTrainingPlacement,
  trainingCandidateRegions,
} from '../../../packages/core/src/model-factory-placement.js';

export interface TrustedHfReleasePublisherPort {
  publish(input: {
    job: ModelFactoryJob;
    receipt: ModelArtifactReceipt;
    attestation: ModelReleaseAttestation;
    signal?: AbortSignal;
  }): Promise<ModelReleasePublication>;
}

/**
 * Operator-configured network and AMI defaults for one region.
 * A job uses these when it names the region in `candidateRegions` but gives no `regionOverrides` entry for it.
 */
export interface RegionNetworkDefaults {
  subnetIds?: string[];
  securityGroupIds?: string[];
  amiId?: string;
  /** AWS-owned public SSM parameter (`/aws/service/...`) that holds the latest AMI ID for this region. */
  amiSsmParameter?: string;
}

const REGISTRY_REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const REGISTRY_SUBNET_PATTERN = /^subnet-[0-9a-f]{8,17}$/;
const REGISTRY_SG_PATTERN = /^sg-[0-9a-f]{8,17}$/;
const REGISTRY_AMI_PATTERN = /^ami-[0-9a-f]{8,17}$/;

function registryIdList(value: unknown, pattern: RegExp, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new Error(`${label} must contain 1..${max} entries`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !pattern.test(item)) throw new Error(`Invalid ${label} entry`);
    return item;
  });
}

/**
 * Parses `HIVEMIND_MF_REGION_NETWORKS_JSON`. Fails closed: an unknown region, an unknown field or a
 * malformed ID rejects the whole registry, so a typo cannot silently send an instance to a wrong network.
 */
export function parseRegionNetworkRegistry(
  raw: string | undefined,
  allowedRegions: string[],
): Record<string, RegionNetworkDefaults> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HIVEMIND_MF_REGION_NETWORKS_JSON is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HIVEMIND_MF_REGION_NETWORKS_JSON must be an object keyed by region');
  }
  const allowed = new Set(allowedRegions);
  const registry: Record<string, RegionNetworkDefaults> = {};
  for (const [region, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!REGISTRY_REGION_PATTERN.test(region) || !allowed.has(region)) {
      throw new Error(`Region network registry names a region outside the allowlist: ${region}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Region network registry entry for ${region} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['subnetIds', 'securityGroupIds', 'amiId', 'amiSsmParameter'].includes(key)) {
        throw new Error(`Region network registry entry for ${region} has unknown field: ${key}`);
      }
    }
    const subnetIds = registryIdList(entry.subnetIds, REGISTRY_SUBNET_PATTERN, `${region}.subnetIds`, 8);
    const securityGroupIds = registryIdList(entry.securityGroupIds, REGISTRY_SG_PATTERN, `${region}.securityGroupIds`, 5);
    if (entry.amiId !== undefined && (typeof entry.amiId !== 'string' || !REGISTRY_AMI_PATTERN.test(entry.amiId))) {
      throw new Error(`Invalid ${region}.amiId`);
    }
    if (
      entry.amiSsmParameter !== undefined &&
      (typeof entry.amiSsmParameter !== 'string' ||
        !PUBLIC_AMI_SSM_PARAMETER_PATTERN.test(entry.amiSsmParameter) ||
        entry.amiSsmParameter.includes('..'))
    ) {
      throw new Error(`Invalid ${region}.amiSsmParameter (must be under /aws/service/)`);
    }
    registry[region] = {
      ...(subnetIds ? { subnetIds } : {}),
      ...(securityGroupIds ? { securityGroupIds } : {}),
      ...(entry.amiId !== undefined ? { amiId: entry.amiId as string } : {}),
      ...(entry.amiSsmParameter !== undefined ? { amiSsmParameter: entry.amiSsmParameter as string } : {}),
    };
  }
  return registry;
}

export interface PlacementAttemptRecord {
  jobId: string;
  region: string;
  subnetId?: string;
  amiId?: string;
  outcome: 'launched' | 'capacity_failover' | 'ami_lookup_failed' | 'fatal';
  detail?: string;
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
  /** Starts the independent verifier task. Without it `dispatchReleaseVerifier` is unavailable. */
  verifierLauncher?: {
    launchModelReleaseVerifier(input: { jobId: string; specBase64: string }, signal?: AbortSignal): Promise<{ taskArn: string }>;
  };
  /** Per-region network and AMI defaults; a job's own `regionOverrides` entry always wins. */
  regionNetworks?: Record<string, RegionNetworkDefaults>;
  /** Resolves `RegionNetworkDefaults.amiSsmParameter`; without it that field is ignored. */
  amiResolver?: PublicAmiResolverPort;
  /**
   * Called once per placement attempt so an operator can audit which regions were tried and why a region
   * was skipped. The detail is the provider error text truncated to 200 characters; it never holds secrets.
   */
  onPlacementAttempt?: (attempt: PlacementAttemptRecord) => void;
  wakeIntervalMs?: number;
  now?: () => number;
  /**
   * Role ID (AROA...) of the training instance role. When set, instances write only to
   * `staging/<role id>:<instance id>/` and the Control Plane copies checked artifacts to the job prefix.
   */
  trainingRoleId?: string;
}

const MAX_INLINE_INPUT_VERIFY_BYTES = 5 * 1024 * 1024; // 5 MiB full SHA-256 preflight; larger verified via HEAD size + instance-side SHA-256

const STAGING_ROLE_ID = /^AROA[A-Z0-9]{12,124}$/;

/** `staging/<role id>:` — followed by the instance ID, this equals `staging/${aws:userid}` for the instance role. */
export function stagingPrefixBase(roleId: string): string {
  return `staging/${roleId}:`;
}

function shellSingleQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Unsafe control character in bootstrap environment value');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function composeTrainingUserData(
  job: ModelFactoryJob,
  envMeta: { artifactsBucket?: string; artifactsRegion?: string; stagingRoleId?: string },
): string | undefined {
  if (job.compute.userDataScript === undefined) return undefined;
  const lines = [
    `export HIVEMIND_JOB_ID=${shellSingleQuote(job.id)}`,
    `export HIVEMIND_MODEL_ID=${shellSingleQuote(job.modelId)}`,
  ];
  if (envMeta.stagingRoleId) {
    // The instance role may write only under staging/<role id>:<instance id>/ (IAM variable aws:userid).
    // The job's own prefix is filled by the Control Plane after it checks the receipt.
    if (!STAGING_ROLE_ID.test(envMeta.stagingRoleId)) throw new Error('Invalid training instance role ID');
    lines.push(
      `export HIVEMIND_JOB_ARTIFACT_PREFIX=${shellSingleQuote(job.compute.s3ArtifactPrefix)}`,
      `HIVEMIND_IMDS_TOKEN=$(curl -sS -m 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)`,
      `HIVEMIND_INSTANCE_ID=$(curl -sS -m 5 -H "X-aws-ec2-metadata-token: $HIVEMIND_IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)`,
      'unset HIVEMIND_IMDS_TOKEN',
      `case "$HIVEMIND_INSTANCE_ID" in i-[0-9a-f]*) ;; *) echo 'hivemind: instance id unavailable; stopping' >&2; shutdown -h now; exit 1 ;; esac`,
      `export HIVEMIND_ARTIFACT_PREFIX="${stagingPrefixBase(envMeta.stagingRoleId)}$HIVEMIND_INSTANCE_ID"`,
    );
  } else {
    lines.push(`export HIVEMIND_ARTIFACT_PREFIX=${shellSingleQuote(job.compute.s3ArtifactPrefix)}`);
  }
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

const PUBLISH_TIMEOUT_MS = 30 * 60_000;

export class ModelFactoryOrchestrator {
  private readonly publishing = new Set<string>();
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

  private reportPlacementAttempt(attempt: PlacementAttemptRecord): void {
    if (!this.options.onPlacementAttempt) return;
    try {
      this.options.onPlacementAttempt({
        ...attempt,
        ...(attempt.detail !== undefined ? { detail: attempt.detail.slice(0, 600) } : {}),
      });
    } catch {
      // An audit sink failure must never change the launch result.
    }
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

  /**
   * Plans the region and AZ order from the Spot placement score feed trend and the live EC2 scores of the
   * job's instance type. Either source may be missing. Never throws.
   */
  async planPlacement(job: ModelFactoryJob, signal?: AbortSignal): Promise<TrainingPlacementPlan> {
    const feed = this.options.spotFeed;
    const [snapshot, live] = await Promise.all([
      feed ? feed.getSnapshot(signal).catch(() => null) : Promise.resolve(null),
      this.liveScores(job, signal),
    ]);
    return planTrainingPlacement(snapshot, job.compute, this.now(), feed?.feedUrl ?? null, live);
  }

  private async liveScores(job: ModelFactoryJob, signal?: AbortSignal): Promise<LivePlacementScores | null> {
    const ec2 = this.options.ec2;
    if (!ec2.getSpotPlacementScores) return null;
    const query = {
      endpointRegion: job.compute.region,
      instanceType: job.compute.instanceType,
      regions: trainingCandidateRegions(job.compute).slice(0, 10),
    };
    const at = new Date(this.now()).toISOString();
    // Regional and per-AZ scores are separate EC2 answers; keep whichever one succeeds.
    const [regional, perAz] = await Promise.all([
      ec2.getSpotPlacementScores({ ...query, singleAvailabilityZone: false }, signal).catch(() => []),
      ec2.getSpotPlacementScores({ ...query, singleAvailabilityZone: true }, signal).catch(() => []),
    ]);
    const scores = [...regional, ...perAz];
    return scores.length ? { at, scores } : null;
  }

  /** Plans the placement for a newly registered job and stores it. Returns the job unchanged when that fails. */
  async planAtRegistration(job: ModelFactoryJob, signal?: AbortSignal): Promise<ModelFactoryJob> {
    try {
      return await this.options.store.recordPlacementPlan(job.id, await this.planPlacement(job, signal));
    } catch {
      return job;
    }
  }

  async approveAndLaunchTraining(
    jobId: string,
    approvalFingerprint: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ModelFactoryJob> {
    const approved = await this.options.store.approveTraining(jobId, approvalFingerprint, reason);
    // Rank the approved regions and their AZs by Spot placement score stability with the newest feed.
    // When the feed cannot rank them now, keep the plan made at registration, if that one was ranked.
    let plan = await this.planPlacement(approved, signal);
    if (plan.status !== 'ranked' && approved.placementPlan?.status === 'ranked') {
      plan = approved.placementPlan;
    } else {
      try {
        await this.options.store.recordPlacementPlan(approved.id, plan);
      } catch {
        // Recording the plan is for audit only; it must not block the launch.
      }
    }
    const rankedTargets: { region: string; azIds: string[] }[] = plan.regions.map((entry) => ({
      region: entry.region,
      azIds:
        entry.region === approved.compute.region && approved.compute.availabilityZoneId
          ? [approved.compute.availabilityZoneId]
          : entry.azs.map((az) => az.azId),
    }));

    const nowMs = this.now();
    const expiresAtIso = new Date(nowMs + approved.compute.maxLifetimeMs).toISOString();
    const nextWakeAt = new Date(nowMs + Math.min(this.wakeIntervalMs, approved.compute.maxLifetimeMs)).toISOString();

    try {
      const instanceProfileArn = this.resolveApprovedInstanceProfileArn(approved.compute.instanceProfileArn);
      await this.verifyPinnedInputsInS3(approved, signal);
      const userDataScript = composeTrainingUserData(approved, {
        artifactsBucket: this.options.artifactsBucket,
        artifactsRegion: this.options.artifactsRegion,
        ...(this.options.trainingRoleId ? { stagingRoleId: this.options.trainingRoleId } : {}),
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
        // Precedence per region: the job's regionOverrides entry, then the job's own top-level values
        // (they describe the job's primary region only), then the operator registry, then the legacy
        // fallback to the job's top-level values.
        const override = approved.compute.regionOverrides?.[target.region];
        const defaults = this.options.regionNetworks?.[target.region];
        const isPrimaryRegion = target.region === approved.compute.region;
        let amiId = override?.amiId ?? (isPrimaryRegion ? approved.compute.amiId : undefined) ?? defaults?.amiId;
        if (!amiId && defaults?.amiSsmParameter && this.options.amiResolver) {
          try {
            amiId = await this.options.amiResolver.resolveAmiId(target.region, defaults.amiSsmParameter, signal);
          } catch (resolveError) {
            const msg = resolveError instanceof Error ? resolveError.message : String(resolveError);
            attemptErrors.push(`${target.region}: AMI lookup failed: ${msg}`);
            this.reportPlacementAttempt({
              jobId: approved.id,
              region: target.region,
              outcome: 'ami_lookup_failed',
              detail: msg,
            });
            continue;
          }
        }
        amiId ??= approved.compute.amiId;
        const securityGroupIds =
          override?.securityGroupIds ??
          (isPrimaryRegion ? approved.compute.securityGroupIds : undefined) ??
          defaults?.securityGroupIds ??
          approved.compute.securityGroupIds;
        const candidateSubnets: (string | undefined)[] =
          override?.subnetIds?.length
            ? override.subnetIds
            : isPrimaryRegion && approved.compute.subnetId
              ? [approved.compute.subnetId]
              : defaults?.subnetIds?.length
                ? defaults.subnetIds
                : approved.compute.subnetId
                  ? [approved.compute.subnetId]
                  : [undefined];

        let orderedSubnets = candidateSubnets;
        const listedSubnets = candidateSubnets.filter((id): id is string => id !== undefined);
        if (listedSubnets.length > 1 && target.azIds.length > 0 && this.options.ec2.describeSubnetAzIds) {
          try {
            const subnetAzIds = await this.options.ec2.describeSubnetAzIds(target.region, listedSubnets, signal);
            orderedSubnets = orderSubnetsByPlannedAzs(listedSubnets, subnetAzIds, target.azIds);
          } catch {
            // Without AZ IDs the subnets keep their listed order; every subnet is still tried.
          }
        }

        for (const subnetId of orderedSubnets) {
          try {
            const launched = await this.options.ec2.launchSpotInstance(
              {
                jobId: approved.id,
                modelId: approved.modelId,
                region: target.region,
                ...(!subnetId && target.azIds[0] ? { availabilityZoneId: target.azIds[0] } : {}),
                instanceType: approved.compute.instanceType,
                amiId,
                maxHourlyPriceUsd: approved.compute.maxHourlyPriceUsd,
                expiresAtIso,
                ...(subnetId ? { subnetId } : {}),
                ...(securityGroupIds ? { securityGroupIds } : {}),
                ...(instanceProfileArn ? { instanceProfileArn } : {}),
                ...(userDataScript !== undefined ? { userDataScript } : {}),
                ...(approved.compute.rootVolumeGb !== undefined ? { rootVolumeGb: approved.compute.rootVolumeGb } : {}),
                extraTags,
              },
              signal,
            );

            this.reportPlacementAttempt({
              jobId: approved.id,
              region: launched.region,
              ...(subnetId ? { subnetId } : {}),
              amiId: launched.amiId,
              outcome: 'launched',
            });
            return await this.options.store.recordInstanceLaunched(approved.id, {
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
            // Short form for the job record: place and AWS error code. The full text goes to the log event below.
            const code = /\(([A-Za-z.]+)\)/.exec(msg)?.[1] ?? msg.slice(0, 80);
            attemptErrors.push(`${target.region}${subnetId ? `/${subnetId}` : ''}: ${code}`);
            // Only fail over on capacity/spot availability errors; immediately rethrow IAM/parameter/auth errors.
            const failover = /InsufficientInstanceCapacity|SpotMaxPriceTooLow|Unsupported|MaxSpotInstanceCountExceeded/i.test(msg);
            this.reportPlacementAttempt({
              jobId: approved.id,
              region: target.region,
              ...(subnetId ? { subnetId } : {}),
              amiId,
              outcome: failover ? 'capacity_failover' : 'fatal',
              detail: msg,
            });
            if (!failover) {
              throw attemptError;
            }
          }
        }
      }

      throw new Error(`No Spot capacity for ${approved.compute.instanceType} in ${attemptErrors.length} placement attempt(s): ${attemptErrors.join(' | ')}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return await this.options.store.fail(approved.id, `EC2 Spot launch failed: ${msg}`);
    }
  }

  /** Reads and size-checks a receipt under one prefix. Null when it is absent or does not match. */
  private async readReceiptAt(prefix: string, signal?: AbortSignal): Promise<ModelArtifactReceipt | null> {
    try {
      const raw = await this.options.s3.getObject(`${prefix}/receipt.json`, undefined, signal);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ModelArtifactReceipt;
      if (this.options.s3.headObject && Array.isArray(parsed.files)) {
        for (const file of parsed.files) {
          const objKey = `${prefix}/${file.path}`;
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

  private async tryLoadS3Receipt(job: ModelFactoryJob, signal?: AbortSignal): Promise<ModelArtifactReceipt | null> {
    // Jobs launched before per-instance staging wrote straight to the job prefix.
    const direct = await this.readReceiptAt(job.compute.s3ArtifactPrefix, signal);
    if (direct) return direct;
    const roleId = this.options.trainingRoleId;
    if (!roleId || !job.instance || !this.options.s3.copyObject) return null;
    // The staging folder is derived from the instance the Control Plane launched, never from the receipt.
    const staging = `${stagingPrefixBase(roleId)}${job.instance.instanceId}`;
    const staged = await this.readReceiptAt(staging, signal);
    if (!staged || staged.s3Prefix !== staging || staged.jobId !== job.id || !Array.isArray(staged.files)) return null;
    try {
      for (const file of staged.files) {
        await this.options.s3.copyObject(`${staging}/${file.path}`, `${job.compute.s3ArtifactPrefix}/${file.path}`, signal);
      }
      const promoted: ModelArtifactReceipt = { ...staged, s3Prefix: job.compute.s3ArtifactPrefix };
      await this.options.s3.putObject(
        `${job.compute.s3ArtifactPrefix}/receipt.json`,
        new TextEncoder().encode(JSON.stringify(promoted, null, 2)),
        'application/json',
        signal,
      );
      return promoted;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'hivemind.mf_staging_copy.error',
        jobId: job.id,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }));
      return null;
    }
  }

  async wakeJob(jobId: string, signal?: AbortSignal): Promise<ModelFactoryJob> {
    let job = await this.options.store.get(jobId);
    const needsTrainingWake = job.status === 'training_running';
    const needsSettlementWake = Boolean(job.instance && job.cost.settledMicros === null);
    if (!job.instance || (!needsTrainingWake && !needsSettlementWake)) {
      return job;
    }

    const nowMs = this.now();
    const expiresAtMs = Date.parse(job.instance.expiresAt);
    // EC2 stops listing a terminated instance after about an hour. An instance that is no longer listed has
    // ended, so it is settled like a terminated one. Any other describe error is rethrown.
    let described: Awaited<ReturnType<Ec2SpotTrainerPort['describeInstance']>>;
    let vanished = false;
    try {
      described = await this.options.ec2.describeInstance(job.instance.region, job.instance.instanceId, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|InvalidInstanceID\.NotFound/i.test(message)) throw error;
      vanished = true;
      described = {
        region: job.instance.region,
        instanceId: job.instance.instanceId,
        state: 'terminated',
        availabilityZone: job.instance.availabilityZone ?? null,
        launchTime: null,
        stateReason: 'EC2 no longer lists the instance',
        tags: {},
      };
    }

    let effectiveState = described.state;
    let forcedReason: string | undefined;

    if (nowMs >= expiresAtMs && (effectiveState === 'pending' || effectiveState === 'running' || effectiveState === 'stopping' || effectiveState === 'stopped')) {
      forcedReason = `TTL Guard forced termination: exceeded maxLifetimeMs (${job.instance.expiresAt})`;
      const terminated = await this.options.ec2.terminateInstance(job.instance.region, job.instance.instanceId, signal);
      effectiveState = terminated.state;
    }

    const isEnded = effectiveState === 'terminated' || effectiveState === 'shutting-down' || effectiveState === 'stopped';
    const nextWakeAt = isEnded ? null : new Date(Math.min(nowMs + this.wakeIntervalMs, expiresAtMs)).toISOString();

    // The instance usually ended some time before this check noticed it. EC2 reports that time; without it
    // the run would be counted up to now, which with a 5-minute check interval can be several times too long.
    // The time is used only when it lies between the launch and now, and never for a forced termination.
    const launchedMs = Date.parse(job.instance.launchedAt);
    const reportedMs = described.stateTransitionTime ? Date.parse(described.stateTransitionTime) : Number.NaN;
    const knownEndMs = isEnded && !forcedReason && !vanished && reportedMs >= launchedMs && reportedMs <= nowMs ? reportedMs : null;

    job = await this.options.store.recordWakeUpdate(job.id, {
      state: effectiveState,
      nextWakeAt,
      ...(knownEndMs !== null ? { endedAt: new Date(knownEndMs).toISOString() } : {}),
      ...(forcedReason ? { forcedTerminationReason: forcedReason, diagnostic: forcedReason } : {}),
    });

    if (!job.receipt) {
      const receipt = await this.tryLoadS3Receipt(job, signal);
      if (receipt) {
        job = await this.options.store.recordArtifactReceipt(job.id, receipt);
      }
    }

    if (isEnded && job.cost.settledMicros === null) {
      // For a vanished instance the real end time is unknown. It cannot have outlived its expiry tag by
      // more than one guard interval, so the expiry time bounds the estimate.
      const endedMs = vanished ? Math.min(nowMs, expiresAtMs) : (knownEndMs ?? nowMs);
      const settlement = calculateActualCostMicros(job, endedMs);
      job = await this.options.store.settleCost(job.id, {
        ...settlement,
        ...(forcedReason
          ? { diagnostic: 'Settled after TTL Guard forced termination' }
          : vanished
            ? { diagnostic: 'Settled for an instance EC2 no longer lists; run time is bounded by the expiry time' }
            : {}),
      });
    }

    if (isEnded && !job.receipt && job.status === 'training_running') {
      const reason =
        forcedReason ??
        `EC2 Spot instance ${job.instance!.instanceId} ended (${effectiveState}) without S3 artifact receipt${described.stateReason ? `: ${described.stateReason}` : ''}`;
      job = await this.options.store.fail(job.id, reason);
    }

    return job;
  }

  async wakeDueJobs(signal?: AbortSignal): Promise<{ woken: ModelFactoryJob[]; sweeps: ExpiredSpotSweepResult[] }> {
    const due = await this.options.store.listDueWakeJobs(this.now());
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
    const current = await this.options.store.get(jobId);
    if (current.instance && current.instance.state !== 'terminated') {
      await this.options.ec2.terminateInstance(current.instance.region, current.instance.instanceId, signal);
    }
    let cancelled = await this.options.store.cancel(jobId, reason);
    if (cancelled.instance && cancelled.cost.settledMicros === null) {
      const settlement = calculateActualCostMicros(cancelled, this.now());
      cancelled = await this.options.store.settleCost(jobId, {
        ...settlement,
        diagnostic: 'Settled on operator cancellation',
      });
    }
    return cancelled;
  }

  /**
   * Starts the independent verifier for a job that has a verified artifact receipt. The verifier task
   * downloads the artifacts and the pinned inputs, checks their hashes, runs the job's approved
   * `releaseCheckCommand`, and reports through the worker-token endpoint, which records the attestation
   * as `independent_verifier`. This method only starts it; the job changes state when the report arrives.
   */
  async dispatchReleaseVerifier(jobId: string, signal?: AbortSignal): Promise<ModelFactoryJob> {
    if (!this.options.verifierLauncher) {
      throw new Error('Independent release verifier is not configured');
    }
    const job = await this.options.store.get(jobId);
    if (job.status !== 'evaluating' || !job.receipt) {
      throw new Error(`Cannot dispatch a release verifier without a verified artifact receipt (state: ${job.status})`);
    }
    const spec = {
      jobId: job.id,
      artifactPrefix: job.compute.s3ArtifactPrefix,
      expectedManifestDigest: job.receipt.manifestDigest,
      releaseCheckCommand: job.releasePolicy.releaseCheckCommand,
      ...(job.compute.inputs ? { inputs: { s3Prefix: job.compute.inputs.s3Prefix, files: job.compute.inputs.files } } : {}),
    };
    const specBase64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
    const launched = await this.options.verifierLauncher.launchModelReleaseVerifier({ jobId: job.id, specBase64 }, signal);
    return this.options.store.recordVerifierDispatched(job.id, launched.taskArn);
  }

  async approveAndPublishRelease(
    jobId: string,
    decision: Omit<ModelReleaseDecision, 'decidedAt'>,
    signal?: AbortSignal,
  ): Promise<ModelFactoryJob> {
    const decided = await this.options.store.recordReleaseDecision(jobId, decision);
    if (decided.status !== 'release_approved') {
      return decided;
    }
    return await this.publishApproved(decided, signal);
  }

  /**
   * Records the release decision and starts a Hugging Face publication in the background. Uploading a
   * model can take minutes, longer than an HTTP client waits; the caller reads the result from the job.
   * An S3-only release is recorded at once.
   */
  async approveAndStartPublishRelease(jobId: string, decision: Omit<ModelReleaseDecision, 'decidedAt'>): Promise<ModelFactoryJob> {
    const decided = await this.options.store.recordReleaseDecision(jobId, decision);
    if (decided.status !== 'release_approved') return decided;
    if (decided.releasePolicy.mode === 's3_artifact_only' || !this.options.hfPublisher) {
      return await this.publishApproved(decided);
    }
    return await this.startBackgroundPublish(decided);
  }

  /** Publishes again a release that was approved but whose publication failed. */
  async startPublishRelease(jobId: string): Promise<ModelFactoryJob> {
    const job = await this.options.store.get(jobId);
    if (job.status !== 'release_approved' || job.publication) {
      throw new DomainError(`Only an approved, unpublished release can be published (state: ${job.status})`, 409);
    }
    if (job.releasePolicy.mode === 's3_artifact_only' || !this.options.hfPublisher) {
      return await this.publishApproved(job);
    }
    return await this.startBackgroundPublish(job);
  }

  /** True while a publication for the job runs in this process. */
  isPublishing(jobId: string): boolean {
    return this.publishing.has(jobId);
  }

  private async startBackgroundPublish(job: ModelFactoryJob): Promise<ModelFactoryJob> {
    if (this.publishing.has(job.id)) {
      throw new DomainError('A publication for this job is already running', 409);
    }
    await this.options.store.recordPublicationStarted(job.id);
    this.publishing.add(job.id);
    void this.publishApproved(job, AbortSignal.timeout(PUBLISH_TIMEOUT_MS), true)
      .catch(() => undefined)
      .finally(() => this.publishing.delete(job.id));
    return job;
  }

  private async publishApproved(decided: ModelFactoryJob, signal?: AbortSignal, alreadyMarked = false): Promise<ModelFactoryJob> {
    if (decided.releasePolicy.mode === 's3_artifact_only') {
      return await this.options.store.recordReleasePublication(decided.id, {
        mode: 's3_artifact_only',
        manifestDigest: decided.receipt!.manifestDigest,
        publishedAt: new Date(this.now()).toISOString(),
      });
    }

    if (!this.options.hfPublisher) {
      return await this.options.store.fail(
        decided.id,
        'Trusted Hugging Face release publisher is not configured on Control Plane (never silently skipped)',
      );
    }

    if (!alreadyMarked) await this.options.store.recordPublicationStarted(decided.id);
    let publication: ModelReleasePublication;
    try {
      publication = await this.options.hfPublisher.publish({
        job: decided,
        receipt: decided.receipt!,
        attestation: decided.releaseAttestation!,
        signal,
      });
    } catch (error) {
      // The job stays release_approved so the same approved release can be published again.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'hivemind.mf_release_publish.error', jobId: decided.id, message: reason.slice(0, 500) }));
      await this.options.store.recordPublicationFailure(decided.id, reason);
      throw new DomainError(`Release publication failed: ${reason.slice(0, 300)}`, 502);
    }
    return await this.options.store.recordReleasePublication(decided.id, publication);
  }
}
