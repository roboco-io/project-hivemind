import type {
  ComputeArtifactReceipt,
  ComputeJob,
  ComputePlacementPlan,
  ComputeReleaseAttestation,
  ComputeReleaseDecision,
  ComputeReleasePublication,
} from '../../../packages/contracts/src/compute.js';
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
import type { ComputeApprovalBudgetContext, ComputeStore } from '../../../packages/core/src/compute.js';
import { calculateActualCostMicros } from '../../../packages/core/src/compute-guard-settlement.js';
import {
  computeCandidateRegions,
  type LivePlacementScores,
  orderSubnetsByPlannedAzs,
  planComputePlacement,
} from '../../../packages/core/src/compute-placement.js';
import { DEFAULT_PROJECT_ID, type ProjectStore } from '../../../packages/core/src/projects.js';
import { DomainError } from '../../../packages/core/src/store.js';

export interface TrustedHfReleasePublisherPort {
  publish(input: {
    job: ComputeJob;
    receipt: ComputeArtifactReceipt;
    attestation: ComputeReleaseAttestation;
    signal?: AbortSignal;
  }): Promise<ComputeReleasePublication>;
  ensureRepository?(repository: string, visibility: 'private' | 'public', signal?: AbortSignal): Promise<'exists' | 'created'>;
}

export interface RegionNetworkDefaults {
  subnetIds?: string[];
  securityGroupIds?: string[];
  amiId?: string;
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

export interface ComputeOrchestratorOptions {
  store: ComputeStore;
  projects?: ProjectStore;
  ec2: Ec2SpotTrainerPort;
  s3: S3ObjectPort;
  artifactsBucket?: string;
  artifactsRegion?: string;
  defaultInstanceProfileArn?: string;
  allowedInstanceProfileArns?: string[];
  hfPublisher?: TrustedHfReleasePublisherPort;
  spotFeed?: SpotPlacementFeedPort;
  verifierLauncher?: {
    launchModelReleaseVerifier(input: { jobId: string; specBase64: string }, signal?: AbortSignal): Promise<{ taskArn: string }>;
  };
  regionNetworks?: Record<string, RegionNetworkDefaults>;
  amiResolver?: PublicAmiResolverPort;
  onPlacementAttempt?: (attempt: PlacementAttemptRecord) => void;
  wakeIntervalMs?: number;
  now?: () => number;
  trainingRoleId?: string;
  notify?: (kind: 'release_published' | 'release_failed' | 'budget_exhausted', subject: string, message: string) => Promise<void>;
}

const MAX_INLINE_INPUT_VERIFY_BYTES = 5 * 1024 * 1024;
const STAGING_ROLE_ID = /^AROA[A-Z0-9]{12,124}$/;

export function stagingPrefixBase(roleId: string): string {
  return `staging/${roleId}:`;
}

function shellSingleQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Unsafe control character in bootstrap environment value');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function composeComputeUserData(
  job: ComputeJob,
  envMeta: { artifactsBucket?: string; artifactsRegion?: string; stagingRoleId?: string },
): string | undefined {
  if (job.compute.userDataScript === undefined) return undefined;
  const lines = [
    `export HIVEMIND_JOB_ID=${shellSingleQuote(job.id)}`,
    `export HIVEMIND_PROJECT_ID=${shellSingleQuote(job.projectId)}`,
    `export HIVEMIND_WORKLOAD_ID=${shellSingleQuote(job.workloadId)}`,
    `export HIVEMIND_WORKLOAD_KIND=${shellSingleQuote(job.workloadKind)}`,
    // Kept for training scripts migrated from Model Factory
    `export HIVEMIND_MODEL_ID=${shellSingleQuote(job.workloadId)}`,
  ];
  if (envMeta.stagingRoleId) {
    if (!STAGING_ROLE_ID.test(envMeta.stagingRoleId)) throw new Error('Invalid compute instance role ID');
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

export class ComputeOrchestrator {
  private readonly publishing = new Set<string>();
  private readonly wakeIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ComputeOrchestratorOptions) {
    this.wakeIntervalMs = options.wakeIntervalMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  private resolveApprovedInstanceProfileArn(requested?: string): string | undefined {
    const allowed = new Set<string>([
      ...(this.options.allowedInstanceProfileArns ?? []),
      ...(this.options.defaultInstanceProfileArn ? [this.options.defaultInstanceProfileArn] : []),
    ]);
    if (requested) {
      if (allowed.size === 0 || !allowed.has(requested)) {
        throw new Error(`Requested instanceProfileArn is not in Control Plane allowlist: ${requested}`);
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
      // Audit sink failure never changes launch result.
    }
  }

  private async verifyPinnedInputsInS3(job: ComputeJob, signal?: AbortSignal): Promise<void> {
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

  async planPlacement(job: ComputeJob, signal?: AbortSignal): Promise<ComputePlacementPlan> {
    const feed = this.options.spotFeed;
    const [snapshot, live] = await Promise.all([
      feed ? feed.getSnapshot(signal).catch(() => null) : Promise.resolve(null),
      this.liveScores(job, signal),
    ]);
    return planComputePlacement(snapshot, job.compute, this.now(), feed?.feedUrl ?? null, live);
  }

  private async liveScores(job: ComputeJob, signal?: AbortSignal): Promise<LivePlacementScores | null> {
    const ec2 = this.options.ec2;
    if (!ec2.getSpotPlacementScores) return null;
    const query = {
      endpointRegion: job.compute.region,
      instanceType: job.compute.instanceType,
      regions: computeCandidateRegions(job.compute).slice(0, 10),
    };
    const at = new Date(this.now()).toISOString();
    const [regional, perAz] = await Promise.all([
      ec2.getSpotPlacementScores({ ...query, singleAvailabilityZone: false }, signal).catch(() => []),
      ec2.getSpotPlacementScores({ ...query, singleAvailabilityZone: true }, signal).catch(() => []),
    ]);
    const scores = [...regional, ...perAz];
    return scores.length ? { at, scores } : null;
  }

  async planAtRegistration(job: ComputeJob, signal?: AbortSignal): Promise<ComputeJob> {
    try {
      return await this.options.store.recordPlacementPlan(job.id, await this.planPlacement(job, signal));
    } catch {
      return job;
    }
  }

  private async resolveProjectBudget(jobId: string): Promise<ComputeApprovalBudgetContext> {
    if (!this.options.projects) return {};
    const job = await this.options.store.get(jobId);
    if (!job.projectId || job.projectId === DEFAULT_PROJECT_ID) return {};
    const project = await this.options.projects.find(job.projectId);
    if (!project) return {};
    return {
      projectBudgetCapMicros: project.budget.computeBudgetCapMicros,
      maxSingleJobCostMicros: project.budget.maxSingleJobCostMicros,
    };
  }

  private async resolveAutoPublishPrefixes(job: ComputeJob): Promise<string[] | undefined> {
    if (!this.options.projects || job.projectId === DEFAULT_PROJECT_ID) return undefined;
    return this.options.projects.autoPublishPrefixesFor(job.projectId);
  }

  async approveAndLaunch(
    jobId: string,
    approvalFingerprint: string,
    reason: string,
    signal?: AbortSignal,
    budgetContext?: ComputeApprovalBudgetContext,
  ): Promise<ComputeJob> {
    const effectiveBudget = budgetContext ?? (await this.resolveProjectBudget(jobId));
    let approved: ComputeJob;
    try {
      approved = await this.options.store.approveLaunch(jobId, approvalFingerprint, reason, effectiveBudget);
    } catch (error) {
      if (error instanceof Error && /cost cap exceeded|budget cap exceeded/i.test(error.message)) {
        await this.options.notify?.(
          'budget_exhausted',
          'HIVEMIND Compute budget cap reached',
          `Launch approval for ${jobId} was refused: ${error.message.slice(0, 500)}`,
        );
      }
      throw error;
    }

    let plan = await this.planPlacement(approved, signal);
    if (plan.status !== 'ranked' && approved.placementPlan?.status === 'ranked') {
      plan = approved.placementPlan;
    } else {
      try {
        await this.options.store.recordPlacementPlan(approved.id, plan);
      } catch {
        // Audit only.
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
      const userDataScript = composeComputeUserData(approved, {
        artifactsBucket: this.options.artifactsBucket,
        artifactsRegion: this.options.artifactsRegion,
        ...(this.options.trainingRoleId ? { stagingRoleId: this.options.trainingRoleId } : {}),
      });

      const extraTags: Record<string, string> = {
        'hivemind:artifact-prefix': approved.compute.s3ArtifactPrefix,
        'hivemind:workload-kind': approved.workloadKind,
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
            // Keep listed order.
          }
        }

        for (const subnetId of orderedSubnets) {
          try {
            const launched = await this.options.ec2.launchSpotInstance(
              {
                jobId: approved.id,
                projectId: approved.projectId,
                workloadId: approved.workloadId,
                modelId: approved.workloadId,
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
            const code = /\(([A-Za-z.]+)\)/.exec(msg)?.[1] ?? msg.slice(0, 80);
            attemptErrors.push(`${target.region}${subnetId ? `/${subnetId}` : ''}: ${code}`);
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

  private async readReceiptAt(prefix: string, signal?: AbortSignal): Promise<ComputeArtifactReceipt | null> {
    try {
      const raw = await this.options.s3.getObject(`${prefix}/receipt.json`, undefined, signal);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ComputeArtifactReceipt;
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

  private async tryLoadS3Receipt(job: ComputeJob, signal?: AbortSignal): Promise<ComputeArtifactReceipt | null> {
    const direct = await this.readReceiptAt(job.compute.s3ArtifactPrefix, signal);
    if (direct) return direct;
    const roleId = this.options.trainingRoleId;
    if (!roleId || !job.instance || !this.options.s3.copyObject) return null;
    const staging = `${stagingPrefixBase(roleId)}${job.instance.instanceId}`;
    const staged = await this.readReceiptAt(staging, signal);
    if (!staged || staged.s3Prefix !== staging || staged.jobId !== job.id || !Array.isArray(staged.files)) return null;
    try {
      for (const file of staged.files) {
        await this.options.s3.copyObject(`${staging}/${file.path}`, `${job.compute.s3ArtifactPrefix}/${file.path}`, signal);
      }
      const promoted: ComputeArtifactReceipt = { ...staged, s3Prefix: job.compute.s3ArtifactPrefix };
      await this.options.s3.putObject(
        `${job.compute.s3ArtifactPrefix}/receipt.json`,
        new TextEncoder().encode(JSON.stringify(promoted, null, 2)),
        'application/json',
        signal,
      );
      return promoted;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'hivemind.compute_staging_copy.error',
        jobId: job.id,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }));
      return null;
    }
  }

  async wakeJob(jobId: string, signal?: AbortSignal): Promise<ComputeJob> {
    let job = await this.options.store.get(jobId);
    const needsWake = job.status === 'running';
    const needsSettlementWake = Boolean(job.instance && job.cost.settledMicros === null);
    if (!job.instance || (!needsWake && !needsSettlementWake)) {
      return job;
    }

    const nowMs = this.now();
    const expiresAtMs = Date.parse(job.instance.expiresAt);
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

    if (isEnded && !job.receipt && job.status === 'running') {
      const reason =
        forcedReason ??
        `EC2 Spot instance ${job.instance!.instanceId} ended (${effectiveState}) without S3 artifact receipt${described.stateReason ? `: ${described.stateReason}` : ''}`;
      job = await this.options.store.fail(job.id, reason);
    }

    return job;
  }

  async wakeDueJobs(signal?: AbortSignal): Promise<{ woken: ComputeJob[]; sweeps: ExpiredSpotSweepResult[] }> {
    const due = await this.options.store.listDueWakeJobs(this.now());
    const woken: ComputeJob[] = [];
    const activeRegions = new Set<string>();
    for (const job of due) {
      if (job.instance?.region) activeRegions.add(job.instance.region);
      woken.push(await this.wakeJob(job.id, signal));
    }
    for (const job of await this.options.store.list()) {
      const projectPrefixes = await this.resolveAutoPublishPrefixes(job);
      if (this.options.store.isAutoPublishEligible(job, projectPrefixes)) {
        await this.autoReleaseIfEligible(job.id, signal).catch(() => undefined);
      } else if (
        job.status === 'release_approved' &&
        !job.publication &&
        job.publication === null &&
        job.releasePolicy.autoPublish &&
        !this.publishing.has(job.id) &&
        job.diagnostics.filter((d) => d.startsWith('Release publication failed')).length < 3
      ) {
        await this.startPublishRelease(job.id).catch(() => undefined);
      }
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

  async cancelJob(jobId: string, reason: string, signal?: AbortSignal): Promise<ComputeJob> {
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

  async dispatchReleaseVerifier(jobId: string, signal?: AbortSignal): Promise<ComputeJob> {
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
    decision: Omit<ComputeReleaseDecision, 'decidedAt'>,
    signal?: AbortSignal,
  ): Promise<ComputeJob> {
    const decided = await this.options.store.recordReleaseDecision(jobId, decision);
    if (decided.status !== 'release_approved') {
      return decided;
    }
    return await this.publishApproved(decided, signal);
  }

  async approveAndStartPublishRelease(jobId: string, decision: Omit<ComputeReleaseDecision, 'decidedAt'>): Promise<ComputeJob> {
    const decided = await this.options.store.recordReleaseDecision(jobId, decision);
    if (decided.status !== 'release_approved') return decided;
    if (decided.releasePolicy.mode === 's3_artifact_only' || !this.options.hfPublisher) {
      return await this.publishApproved(decided);
    }
    return await this.startBackgroundPublish(decided);
  }

  async startPublishRelease(jobId: string): Promise<ComputeJob> {
    const job = await this.options.store.get(jobId);
    if (job.status !== 'release_approved' || job.publication) {
      throw new DomainError(`Only an approved, unpublished release can be published (state: ${job.status})`, 409);
    }
    if (job.releasePolicy.mode === 's3_artifact_only' || !this.options.hfPublisher) {
      return await this.publishApproved(job);
    }
    return await this.startBackgroundPublish(job);
  }

  async autoReleaseIfEligible(jobId: string, signal?: AbortSignal): Promise<ComputeJob | null> {
    const job = await this.options.store.get(jobId);
    const projectPrefixes = await this.resolveAutoPublishPrefixes(job);
    if (!this.options.store.isAutoPublishEligible(job, projectPrefixes)) return null;
    if (job.releasePolicy.mode === 'hf_release') {
      const publisher = this.options.hfPublisher;
      if (!publisher) return null;
      if (publisher.ensureRepository) {
        try {
          const outcome = await publisher.ensureRepository(job.releasePolicy.hfRepository!, job.releasePolicy.visibility, signal);
          console.log(JSON.stringify({ event: 'hivemind.compute_auto_publish.repository', jobId, projectId: job.projectId, repository: job.releasePolicy.hfRepository, outcome }));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.options.notify?.('release_failed', `HIVEMIND release failed [${job.projectId}]: ${job.workloadId}`, `Repository ${job.releasePolicy.hfRepository} could not be prepared for job ${job.id}: ${reason.slice(0, 300)}`);
          throw error;
        }
      }
    }
    const approved = await this.options.store.recordAutoReleaseDecision(jobId, projectPrefixes);
    if (approved.releasePolicy.mode === 's3_artifact_only') return this.publishApproved(approved);
    return this.startBackgroundPublish(approved);
  }

  isPublishing(jobId: string): boolean {
    return this.publishing.has(jobId);
  }

  private async startBackgroundPublish(job: ComputeJob): Promise<ComputeJob> {
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

  private async publishApproved(decided: ComputeJob, signal?: AbortSignal, alreadyMarked = false): Promise<ComputeJob> {
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
    let publication: ComputeReleasePublication;
    try {
      publication = await this.options.hfPublisher.publish({
        job: decided,
        receipt: decided.receipt!,
        attestation: decided.releaseAttestation!,
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'hivemind.compute_release_publish.error', jobId: decided.id, projectId: decided.projectId, message: reason.slice(0, 500) }));
      await this.options.store.recordPublicationFailure(decided.id, reason);
      await this.options.notify?.('release_failed', `HIVEMIND release failed [${decided.projectId}]: ${decided.workloadId}`, `Job ${decided.id} (${decided.releasePolicy.hfRepository ?? 's3'}) could not be published: ${reason.slice(0, 500)}`);
      throw new DomainError(`Release publication failed: ${reason.slice(0, 300)}`, 502);
    }
    const approvedBy = decided.releaseDecision?.reason.startsWith('Auto-publish policy') ? 'auto_publish_policy' : 'operator';
    const released = await this.options.store.recordReleasePublication(decided.id, { ...publication, approvedBy });
    await this.options.notify?.(
      'release_published',
      `HIVEMIND released [${decided.projectId}] ${decided.workloadId}`,
      `Job ${decided.id} was published to ${publication.url ?? publication.repository ?? 'S3'} (manifest ${publication.manifestDigest.slice(0, 12)}).`,
    );
    return released;
  }
}
