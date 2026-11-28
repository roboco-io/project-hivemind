import type { ApprovalDecisionRecord } from '../../contracts/src/approval-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  COMPUTE_WORKLOAD_KINDS,
  type ComputeArtifactFile,
  type ComputeArtifactReceipt,
  type ComputeEvent,
  type ComputeInputFile,
  type ComputeInputSpec,
  type ComputeInstanceState,
  type ComputeJob,
  type ComputeJobStatus,
  type ComputeLedgerSummary,
  type ComputePlacementPlan,
  type ComputeReleaseAttestation,
  type ComputeReleaseAttestationSource,
  type ComputeReleaseDecision,
  type ComputeReleasePolicy,
  type ComputeReleasePublication,
  type ComputeSpec,
  type ComputeWaitReason,
  type ComputeWorkloadKind,
  type CreateComputeJob,
  type Ec2InstanceLifecycleState,
  type ProjectComputeLedgerSummary,
  type SubmitComputeReleaseAttestation,
} from '../../contracts/src/compute.js';
import {
  SqliteComputeRepository,
  type ComputeEventDraft,
  type ComputeRepository,
  type ComputeTxState,
} from './compute-repository.js';
import { DEFAULT_PROJECT_ID, validateProjectId } from './projects.js';
import { DomainError, text } from './store.js';

const HEX40 = /^[a-f0-9]{40}$/i;
const HEX64 = /^[a-f0-9]{64}$/i;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const AZ_ID_PATTERN = /^[a-z]{2,4}\d-az\d+$/;
const AMI_PATTERN = /^ami-[a-f0-9]{8,17}$/;
const INSTANCE_TYPE_PATTERN = /^[a-z][a-z0-9]{1,15}\.[a-z0-9]{1,16}$/;
const INSTANCE_ID_PATTERN = /^i-[a-f0-9]{8,17}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SUBNET_PATTERN = /^subnet-[a-f0-9]{8,17}$/;
const SG_PATTERN = /^sg-[a-f0-9]{8,17}$/;
const IAM_PROFILE_PATTERN = /^arn:aws:iam::\d{12}:instance-profile\/[A-Za-z0-9+=,.@_/ -]{1,128}$/;

const TERMINAL_STATUSES = new Set<ComputeJobStatus>(['released', 'failed', 'cancelled', 'rejected']);
const DEFAULT_GLOBAL_BUDGET_CAP_MICROS = 500_000_000; // $500 hard central default
export const OPERATOR_SELF_REPORTED_DISCLAIMER =
  '이 검사 결과는 운영자/호출자가 직접 보고한 값이며, HIVEMIND가 releaseCheckCommand를 독립 격리 환경에서 실행해 검증하지 않았습니다.';

const LEGACY_STATUS_MAP: Record<string, ComputeJobStatus> = {
  awaiting_training_approval: 'awaiting_launch_approval',
  training_queued: 'queued',
  training_running: 'running',
};

const LEGACY_WAIT_REASON_MAP: Record<string, ComputeWaitReason> = {
  awaiting_training_approval: 'awaiting_launch_approval',
  training_in_progress: 'running_in_progress',
};

/**
 * Transparently normalizes persisted pre-refactor Model Factory job records loaded from SQLite/Aurora DSQL
 * into the universal ComputeJob shape so live history is preserved without downtime.
 */
export function normalizeComputeJob(raw: ComputeJob): ComputeJob {
  const rec = structuredClone(raw) as unknown as Record<string, unknown>;
  const rawStatus = String(rec.status ?? '');
  const status = (LEGACY_STATUS_MAP[rawStatus] ?? rawStatus) as ComputeJobStatus;
  const rawWait = rec.waitReason === null || rec.waitReason === undefined ? null : String(rec.waitReason);
  const waitReason = rawWait ? ((LEGACY_WAIT_REASON_MAP[rawWait] ?? rawWait) as ComputeWaitReason) : null;
  const workloadId =
    typeof rec.workloadId === 'string' && rec.workloadId
      ? rec.workloadId
      : typeof rec.modelId === 'string' && rec.modelId
        ? rec.modelId
        : 'unknown-workload';
  const projectId = typeof rec.projectId === 'string' && rec.projectId ? rec.projectId : DEFAULT_PROJECT_ID;
  const workloadKind: ComputeWorkloadKind =
    typeof rec.workloadKind === 'string' && (COMPUTE_WORKLOAD_KINDS as readonly string[]).includes(rec.workloadKind)
      ? (rec.workloadKind as ComputeWorkloadKind)
      : 'training';
  delete rec.modelId;
  return {
    ...(rec as unknown as ComputeJob),
    projectId,
    workloadId,
    workloadKind,
    status,
    waitReason,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeRelativePath(raw: string, label: string): string {
  const cleaned = text(raw, label, 512).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new DomainError(`Invalid ${label}: ${raw}`, 400);
  }
  return cleaned;
}

function clip(value: unknown, max: number): string {
  const str = (typeof value === 'string' ? value : String(value ?? '')).trim();
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function byPathCodeUnits(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function computeInputsDigest(s3Prefix: string, files: ComputeInputFile[]): string {
  const cleanPrefix = normalizeRelativePath(s3Prefix, 'compute.inputs.s3Prefix');
  if (!Array.isArray(files) || files.length === 0 || files.length > 1000) {
    throw new DomainError('compute.inputs.files requires 1..1000 files', 400);
  }
  const seen = new Set<string>();
  const normalized = files
    .map((f) => {
      const path = normalizeRelativePath(f.path, 'input file path');
      if (seen.has(path)) throw new DomainError(`Duplicate input file path: ${path}`, 400);
      seen.add(path);
      const sha256 = text(f.sha256, 'input sha256', 64).toLowerCase();
      if (!HEX64.test(sha256)) throw new DomainError(`Invalid input sha256 for ${path}`, 400);
      if (!Number.isSafeInteger(f.sizeBytes) || f.sizeBytes < 1 || f.sizeBytes > 50_000_000_000) {
        throw new DomainError(`Invalid input sizeBytes for ${path}`, 400);
      }
      return { path, sha256, sizeBytes: f.sizeBytes };
    })
    .sort(byPathCodeUnits);
  return sha256Hex(JSON.stringify({ version: 1, s3Prefix: cleanPrefix, files: normalized }));
}

function allowedInputRoots(projectId: string, workloadId: string, allowedPrefixes?: readonly string[]): string[] {
  const roots: string[] = [];
  const candidates =
    allowedPrefixes && allowedPrefixes.length > 0
      ? allowedPrefixes
      : projectId === DEFAULT_PROJECT_ID
        ? [`projects/${DEFAULT_PROJECT_ID}/`, 'models/']
        : [`projects/${projectId}/`, 'models/'];
  for (const prefix of candidates) {
    const clean = prefix.replace(/^\/+|\/+$/g, '');
    roots.push(`${clean}/${workloadId}/inputs`);
  }
  return [...new Set(roots)];
}

export function validateComputeInputSpec(
  raw: Omit<ComputeInputSpec, 'digest'> & { digest?: string },
  workloadId: string,
  options: { projectId?: string; allowedPrefixes?: readonly string[] } = {},
): ComputeInputSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('compute.inputs must be an object', 400);
  }
  const s3Prefix = normalizeRelativePath(raw.s3Prefix, 'compute.inputs.s3Prefix');
  const roots = allowedInputRoots(options.projectId ?? DEFAULT_PROJECT_ID, workloadId, options.allowedPrefixes);
  const matchesRoot = roots.some((root) => s3Prefix === root || s3Prefix.startsWith(`${root}/`));
  if (!matchesRoot) {
    throw new DomainError(`compute.inputs.s3Prefix must start with one of: ${roots.map((r) => `${r}/`).join(', ')}`, 400);
  }
  const computedDigest = computeInputsDigest(s3Prefix, raw.files);
  if (raw.digest !== undefined) {
    const provided = text(raw.digest, 'compute.inputs.digest', 64).toLowerCase();
    if (provided !== computedDigest) {
      throw new DomainError('compute.inputs.digest does not match input files SHA-256 manifest', 400);
    }
  }
  const files = [...raw.files]
    .map((f) => ({
      path: normalizeRelativePath(f.path, 'input file path'),
      sha256: f.sha256.toLowerCase(),
      sizeBytes: f.sizeBytes,
    }))
    .sort(byPathCodeUnits);
  return { s3Prefix, files, digest: computedDigest };
}

export function computeArtifactManifestDigest(files: ComputeArtifactFile[]): string {
  if (!Array.isArray(files) || files.length === 0 || files.length > 1000) {
    throw new DomainError('Artifact receipt requires 1..1000 files', 400);
  }
  const seen = new Set<string>();
  const normalized = files
    .map((f) => {
      const path = normalizeRelativePath(f.path, 'artifact file path');
      if (seen.has(path)) throw new DomainError(`Duplicate artifact file path: ${path}`, 400);
      seen.add(path);
      const sha256 = text(f.sha256, 'artifact sha256', 64).toLowerCase();
      if (!HEX64.test(sha256)) throw new DomainError(`Invalid artifact sha256 for ${path}`, 400);
      if (!Number.isSafeInteger(f.sizeBytes) || f.sizeBytes < 1 || f.sizeBytes > 50_000_000_000) {
        throw new DomainError(`Invalid artifact sizeBytes for ${path}`, 400);
      }
      return { path, sha256, sizeBytes: f.sizeBytes };
    })
    .sort(byPathCodeUnits);
  return sha256Hex(JSON.stringify({ version: 1, files: normalized }));
}

export function validateComputeSpec(
  spec: CreateComputeJob['compute'],
  workloadId?: string,
  options: { projectId?: string; allowedS3Prefixes?: readonly string[] } = {},
): ComputeSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new DomainError('Compute specification is required', 400);
  }
  const region = text(spec.region, 'compute.region', 32).toLowerCase();
  if (!REGION_PATTERN.test(region)) {
    throw new DomainError(`Invalid AWS region: ${spec.region}`, 400);
  }
  let candidateRegions: string[] | undefined;
  if (spec.candidateRegions !== undefined) {
    if (!Array.isArray(spec.candidateRegions) || spec.candidateRegions.length === 0 || spec.candidateRegions.length > 10) {
      throw new DomainError('compute.candidateRegions must contain 1..10 AWS regions', 400);
    }
    candidateRegions = [...new Set(spec.candidateRegions.map((r) => {
      const clean = text(r, 'compute.candidateRegions[]', 32).toLowerCase();
      if (!REGION_PATTERN.test(clean)) throw new DomainError(`Invalid candidate region: ${r}`, 400);
      return clean;
    }))];
  }
  let regionOverrides: ComputeSpec['regionOverrides'];
  if (spec.regionOverrides !== undefined) {
    if (!spec.regionOverrides || typeof spec.regionOverrides !== 'object' || Array.isArray(spec.regionOverrides)) {
      throw new DomainError('compute.regionOverrides must be an object', 400);
    }
    regionOverrides = {};
    for (const [r, ov] of Object.entries(spec.regionOverrides)) {
      const cleanRegion = text(r, 'regionOverrides key', 32).toLowerCase();
      if (!REGION_PATTERN.test(cleanRegion)) throw new DomainError(`Invalid regionOverrides region: ${r}`, 400);
      if (!ov || typeof ov !== 'object' || Array.isArray(ov)) throw new DomainError('Invalid region override entry', 400);
      const entry: { amiId?: string; subnetIds?: string[]; securityGroupIds?: string[] } = {};
      if (ov.amiId !== undefined) {
        const cleanAmi = text(ov.amiId, 'regionOverrides.amiId', 32).toLowerCase();
        if (!AMI_PATTERN.test(cleanAmi)) throw new DomainError(`Invalid regionOverrides amiId: ${ov.amiId}`, 400);
        entry.amiId = cleanAmi;
      }
      if (ov.subnetIds !== undefined) {
        if (!Array.isArray(ov.subnetIds) || ov.subnetIds.length === 0 || ov.subnetIds.length > 8) {
          throw new DomainError('regionOverrides.subnetIds must contain 1..8 subnets', 400);
        }
        entry.subnetIds = ov.subnetIds.map((s) => {
          const clean = text(s, 'regionOverrides.subnetId', 32).toLowerCase();
          if (!SUBNET_PATTERN.test(clean)) throw new DomainError(`Invalid regionOverrides subnetId: ${s}`, 400);
          return clean;
        });
      }
      if (ov.securityGroupIds !== undefined) {
        if (!Array.isArray(ov.securityGroupIds) || ov.securityGroupIds.length === 0 || ov.securityGroupIds.length > 5) {
          throw new DomainError('regionOverrides.securityGroupIds must contain 1..5 security groups', 400);
        }
        entry.securityGroupIds = ov.securityGroupIds.map((sg) => {
          const clean = text(sg, 'regionOverrides.securityGroupId', 32).toLowerCase();
          if (!SG_PATTERN.test(clean)) throw new DomainError(`Invalid regionOverrides securityGroupId: ${sg}`, 400);
          return clean;
        });
      }
      regionOverrides[cleanRegion] = entry;
    }
  }
  let availabilityZoneId: string | undefined;
  if (spec.availabilityZoneId !== undefined) {
    availabilityZoneId = text(spec.availabilityZoneId, 'compute.availabilityZoneId', 24).toLowerCase();
    if (!AZ_ID_PATTERN.test(availabilityZoneId)) {
      throw new DomainError(`Invalid AWS availabilityZoneId: ${spec.availabilityZoneId}`, 400);
    }
  }
  const instanceType = text(spec.instanceType, 'compute.instanceType', 40).toLowerCase();
  if (!INSTANCE_TYPE_PATTERN.test(instanceType)) {
    throw new DomainError(`Invalid EC2 instanceType: ${spec.instanceType}`, 400);
  }
  const amiId = text(spec.amiId, 'compute.amiId', 32).toLowerCase();
  if (!AMI_PATTERN.test(amiId)) {
    throw new DomainError(`Invalid EC2 amiId: ${spec.amiId}`, 400);
  }
  if (!Number.isSafeInteger(spec.maxLifetimeMs) || spec.maxLifetimeMs < 60_000 || spec.maxLifetimeMs > 604_800_000) {
    throw new DomainError('compute.maxLifetimeMs must be between 60000 (1m) and 604800000 (7d)', 400);
  }
  if (typeof spec.maxHourlyPriceUsd !== 'number' || !Number.isFinite(spec.maxHourlyPriceUsd) || spec.maxHourlyPriceUsd <= 0 || spec.maxHourlyPriceUsd > 200) {
    throw new DomainError('compute.maxHourlyPriceUsd must be between 0 and 200 USD', 400);
  }
  if (!Number.isSafeInteger(spec.maxTotalCostMicros) || spec.maxTotalCostMicros < 1 || spec.maxTotalCostMicros > 10_000_000_000) {
    throw new DomainError('compute.maxTotalCostMicros must be between 1 and 10000000000', 400);
  }
  let subnetId: string | undefined;
  if (spec.subnetId !== undefined) {
    subnetId = text(spec.subnetId, 'compute.subnetId', 32).toLowerCase();
    if (!SUBNET_PATTERN.test(subnetId)) throw new DomainError(`Invalid subnetId: ${spec.subnetId}`, 400);
  }
  let securityGroupIds: string[] | undefined;
  if (spec.securityGroupIds !== undefined) {
    if (!Array.isArray(spec.securityGroupIds) || spec.securityGroupIds.length === 0 || spec.securityGroupIds.length > 5) {
      throw new DomainError('compute.securityGroupIds must contain 1..5 security group IDs', 400);
    }
    securityGroupIds = spec.securityGroupIds.map((sg) => {
      const clean = text(sg, 'securityGroupId', 32).toLowerCase();
      if (!SG_PATTERN.test(clean)) throw new DomainError(`Invalid securityGroupId: ${sg}`, 400);
      return clean;
    });
  }
  let instanceProfileArn: string | undefined;
  if (spec.instanceProfileArn !== undefined) {
    instanceProfileArn = text(spec.instanceProfileArn, 'compute.instanceProfileArn', 256);
    if (!IAM_PROFILE_PATTERN.test(instanceProfileArn)) {
      throw new DomainError('Invalid compute.instanceProfileArn', 400);
    }
  }
  let userDataScript: string | undefined;
  if (spec.userDataScript !== undefined) {
    if (typeof spec.userDataScript !== 'string' || Buffer.byteLength(spec.userDataScript, 'utf8') > 16_384) {
      throw new DomainError('compute.userDataScript must be <= 16384 bytes', 400);
    }
    userDataScript = spec.userDataScript;
  }
  const s3ArtifactPrefix = normalizeRelativePath(spec.s3ArtifactPrefix, 'compute.s3ArtifactPrefix');
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  if (s3ArtifactPrefix.split('/').includes('inputs') || s3ArtifactPrefix.startsWith('staging/')) {
    throw new DomainError('compute.s3ArtifactPrefix must not overlap inputs/ or staging/', 400);
  }
  const allowedPrefixes =
    options.allowedS3Prefixes && options.allowedS3Prefixes.length > 0
      ? options.allowedS3Prefixes
      : projectId === DEFAULT_PROJECT_ID
        ? [`projects/${DEFAULT_PROJECT_ID}/`, 'models/']
        : [`projects/${projectId}/`, 'models/'];
  const matchesAllowedPrefix = allowedPrefixes.some((p) => {
    const clean = p.replace(/^\/+/, '');
    const withSlash = clean.endsWith('/') ? clean : `${clean}/`;
    if (workloadId) {
      return s3ArtifactPrefix.startsWith(`${withSlash}${workloadId}/`);
    }
    return s3ArtifactPrefix.startsWith(withSlash);
  });
  if (!matchesAllowedPrefix) {
    const expected = workloadId
      ? allowedPrefixes.map((p) => `${p.replace(/\/+$/, '')}/${workloadId}/`).join(', ')
      : allowedPrefixes.join(', ');
    throw new DomainError(`compute.s3ArtifactPrefix must start with one of: ${expected}`, 400);
  }

  const inputs =
    spec.inputs === undefined
      ? undefined
      : validateComputeInputSpec(spec.inputs, workloadId ?? s3ArtifactPrefix.split('/')[1] ?? 'workload', {
          projectId,
          allowedPrefixes: options.allowedS3Prefixes,
        });
  const workloadClass =
    spec.workloadClass === undefined ? undefined : text(spec.workloadClass, 'compute.workloadClass', 64);
  if (spec.rootVolumeGb !== undefined && (!Number.isSafeInteger(spec.rootVolumeGb) || spec.rootVolumeGb < 8 || spec.rootVolumeGb > 2000)) {
    throw new DomainError('compute.rootVolumeGb must be an integer between 8 and 2000', 400);
  }

  return {
    region,
    ...(candidateRegions ? { candidateRegions } : {}),
    ...(regionOverrides ? { regionOverrides } : {}),
    ...(availabilityZoneId ? { availabilityZoneId } : {}),
    instanceType,
    amiId,
    maxLifetimeMs: spec.maxLifetimeMs,
    maxHourlyPriceUsd: spec.maxHourlyPriceUsd,
    maxTotalCostMicros: spec.maxTotalCostMicros,
    ...(workloadClass ? { workloadClass } : {}),
    ...(subnetId ? { subnetId } : {}),
    ...(securityGroupIds ? { securityGroupIds } : {}),
    ...(instanceProfileArn ? { instanceProfileArn } : {}),
    ...(userDataScript !== undefined ? { userDataScript } : {}),
    ...(spec.rootVolumeGb !== undefined ? { rootVolumeGb: spec.rootVolumeGb } : {}),
    s3ArtifactPrefix,
    ...(inputs ? { inputs } : {}),
  };
}

export function validateComputeReleasePolicy(policy: ComputeReleasePolicy): ComputeReleasePolicy {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new DomainError('Release policy is required', 400);
  }
  if (policy.mode !== 'hf_release' && policy.mode !== 's3_artifact_only') {
    throw new DomainError('releasePolicy.mode must be hf_release or s3_artifact_only', 400);
  }
  if (policy.visibility !== 'private' && policy.visibility !== 'public') {
    throw new DomainError('releasePolicy.visibility must be private or public', 400);
  }
  let hfRepository: string | undefined;
  let hfRevision: string | undefined;
  if (policy.mode === 'hf_release') {
    hfRepository = text(policy.hfRepository, 'releasePolicy.hfRepository', 200);
    if (!REPO_PATTERN.test(hfRepository)) {
      throw new DomainError(`Invalid releasePolicy.hfRepository: ${policy.hfRepository}`, 400);
    }
    hfRevision = policy.hfRevision ? text(policy.hfRevision, 'releasePolicy.hfRevision', 120) : 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,119}$/.test(hfRevision) || hfRevision.includes('..')) {
      throw new DomainError(`Invalid releasePolicy.hfRevision: ${hfRevision}`, 400);
    }
  }
  if (!Array.isArray(policy.releaseCheckCommand) || policy.releaseCheckCommand.length < 1 || policy.releaseCheckCommand.length > 32) {
    throw new DomainError('releasePolicy.releaseCheckCommand requires 1..32 arguments', 400);
  }
  const releaseCheckCommand = policy.releaseCheckCommand.map((arg) => text(arg, 'releaseCheckCommand arg', 1000));
  const raw = policy as unknown as Record<string, unknown>;
  if (raw.autoPublish !== undefined && raw.autoPublish !== true && raw.autoPublish !== false) {
    throw new DomainError('releasePolicy.autoPublish must be a boolean', 400);
  }
  return {
    mode: policy.mode,
    ...(hfRepository ? { hfRepository } : {}),
    ...(hfRevision ? { hfRevision } : {}),
    visibility: policy.visibility,
    releaseCheckCommand,
    ...(raw.autoPublish === true ? { autoPublish: true as const } : {}),
  };
}

export function autoPublishAllowed(policy: ComputeReleasePolicy, repoPrefixes: readonly string[]): boolean {
  if (policy.autoPublish !== true) return false;
  if (policy.mode === 's3_artifact_only') return true;
  const repo = policy.hfRepository ?? '';
  return repoPrefixes.some((prefix) => /^[A-Za-z0-9][A-Za-z0-9_.-]*\/$/.test(prefix) && repo.startsWith(prefix));
}

export function computeJobApprovalFingerprint(spec: {
  projectId: string;
  workloadId: string;
  workloadKind: ComputeWorkloadKind;
  repository: string;
  baseCommit: string;
  compute: ComputeSpec;
  releasePolicy: ComputeReleasePolicy;
}): string {
  return sha256Hex(
    JSON.stringify({
      version: 2,
      projectId: spec.projectId,
      workloadId: spec.workloadId,
      workloadKind: spec.workloadKind,
      repository: spec.repository,
      baseCommit: spec.baseCommit,
      compute: {
        region: spec.compute.region,
        ...(spec.compute.candidateRegions ? { candidateRegions: spec.compute.candidateRegions } : {}),
        ...(spec.compute.regionOverrides ? { regionOverrides: spec.compute.regionOverrides } : {}),
        availabilityZoneId: spec.compute.availabilityZoneId ?? null,
        instanceType: spec.compute.instanceType,
        amiId: spec.compute.amiId,
        maxLifetimeMs: spec.compute.maxLifetimeMs,
        maxHourlyPriceUsd: spec.compute.maxHourlyPriceUsd,
        maxTotalCostMicros: spec.compute.maxTotalCostMicros,
        s3ArtifactPrefix: spec.compute.s3ArtifactPrefix,
        userDataSha256: spec.compute.userDataScript ? sha256Hex(spec.compute.userDataScript) : null,
        ...(spec.compute.rootVolumeGb !== undefined ? { rootVolumeGb: spec.compute.rootVolumeGb } : {}),
        ...(spec.compute.inputs
          ? { inputsS3Prefix: spec.compute.inputs.s3Prefix, inputsDigest: spec.compute.inputs.digest }
          : {}),
      },
      releasePolicy: spec.releasePolicy,
    }),
  );
}

export interface ComputeCreatePolicyContext {
  allowedS3Prefixes?: readonly string[];
  autoPublishRepoPrefixes?: readonly string[];
  maxLifetimeMs?: number;
  maxSingleJobCostMicros?: number | null;
}

export interface ComputeApprovalBudgetContext {
  /** Per-project hard compute budget ceiling in USD micros. */
  projectBudgetCapMicros?: number;
  /** Optional per-job ceiling in USD micros. */
  maxSingleJobCostMicros?: number | null;
}

export interface ComputeStoreOptions {
  now?: () => number;
  globalBudgetCapMicros?: number;
  /** Host-level Hugging Face repository prefixes where `autoPublish` is allowed. Default: none. */
  autoPublishRepoPrefixes?: readonly string[];
}

export class ComputeStore {
  private readonly repository: ComputeRepository;
  private readonly now: () => number;
  private readonly globalBudgetCapMicros: number;
  private readonly autoPublishRepoPrefixes: readonly string[];
  private activeTx: ComputeTxState | null = null;

  constructor(storage: string | ComputeRepository = ':memory:', options: ComputeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.globalBudgetCapMicros = options.globalBudgetCapMicros ?? DEFAULT_GLOBAL_BUDGET_CAP_MICROS;
    this.autoPublishRepoPrefixes = [...(options.autoPublishRepoPrefixes ?? [])];
    if (!Number.isSafeInteger(this.globalBudgetCapMicros) || this.globalBudgetCapMicros < 1) {
      throw new DomainError('Invalid globalBudgetCapMicros', 400);
    }
    this.repository = typeof storage === 'string' ? new SqliteComputeRepository(storage) : storage;
  }

  get storageBackend(): ComputeRepository['storageBackend'] {
    return this.repository.storageBackend;
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  private tx<T>(fn: () => T): Promise<T> {
    return this.repository.transaction((state) => {
      this.activeTx = state;
      try {
        return fn();
      } finally {
        this.activeTx = null;
      }
    });
  }

  private txState(): ComputeTxState {
    if (!this.activeTx) throw new Error('ComputeStore state accessed outside a repository transaction');
    return this.activeTx;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private load(id: string): ComputeJob {
    const job = this.txState().docs.get(id);
    if (!job) throw new DomainError('Compute job not found', 404);
    return normalizeComputeJob(job);
  }

  private save(job: ComputeJob): ComputeJob {
    job.updatedAt = this.timestamp();
    const state = this.txState();
    state.docs.set(job.id, structuredClone(job));
    state.dirtyIds.add(job.id);
    return structuredClone(job);
  }

  private emit(jobId: string, type: string, data: Record<string, unknown>, projectId?: string): void {
    this.txState().newEvents.push({
      jobId,
      ...(projectId ? { projectId } : {}),
      type,
      at: this.timestamp(),
      data,
    } as ComputeEventDraft);
  }

  private computeLedgerLocked(options: { projectId?: string; projectBudgetCaps?: Readonly<Record<string, number>> } = {}): ComputeLedgerSummary {
    const allJobs = [...this.txState().docs.values()].map(normalizeComputeJob);
    let globalReservedMicros = 0;
    let globalSettledMicros = 0;
    let globalActiveReservations = 0;
    let globalSettledJobs = 0;

    const projectBuckets = new Map<
      string,
      { reserved: number; settled: number; active: number; settledCount: number }
    >();

    for (const job of allJobs) {
      const bucket = projectBuckets.get(job.projectId) ?? { reserved: 0, settled: 0, active: 0, settledCount: 0 };
      if (job.cost.settledMicros !== null) {
        globalSettledMicros += job.cost.settledMicros;
        globalSettledJobs += 1;
        bucket.settled += job.cost.settledMicros;
        bucket.settledCount += 1;
      } else if (job.cost.reservedMicros > 0) {
        globalReservedMicros += job.cost.reservedMicros;
        globalActiveReservations += 1;
        bucket.reserved += job.cost.reservedMicros;
        bucket.active += 1;
      }
      projectBuckets.set(job.projectId, bucket);
    }

    const globalRemaining = Math.max(0, this.globalBudgetCapMicros - (globalReservedMicros + globalSettledMicros));
    const byProject: Record<string, ProjectComputeLedgerSummary> = {};
    const projectIds = new Set([...projectBuckets.keys(), ...Object.keys(options.projectBudgetCaps ?? {})]);
    for (const pid of projectIds) {
      const bucket = projectBuckets.get(pid) ?? { reserved: 0, settled: 0, active: 0, settledCount: 0 };
      const cap = options.projectBudgetCaps?.[pid] ?? null;
      const projectCommitted = bucket.reserved + bucket.settled;
      const projectRemaining = cap === null ? globalRemaining : Math.min(globalRemaining, Math.max(0, cap - projectCommitted));
      byProject[pid] = {
        projectId: pid,
        budgetCapMicros: cap,
        totalReservedMicros: bucket.reserved,
        totalSettledMicros: bucket.settled,
        remainingBudgetMicros: projectRemaining,
        activeReservations: bucket.active,
        settledJobs: bucket.settledCount,
      };
    }

    const filteredJobs = options.projectId ? allJobs.filter((j) => j.projectId === options.projectId) : allJobs;
    const entries = filteredJobs.map((job) => ({
      jobId: job.id,
      projectId: job.projectId,
      workloadId: job.workloadId,
      workloadKind: job.workloadKind,
      status: job.status,
      region: job.compute.region,
      instanceType: job.compute.instanceType,
      reservedMicros: job.cost.reservedMicros,
      settledMicros: job.cost.settledMicros,
      createdAt: job.createdAt,
      settledAt: job.cost.settledAt,
    }));

    if (options.projectId) {
      const summary = byProject[options.projectId] ?? {
        projectId: options.projectId,
        budgetCapMicros: options.projectBudgetCaps?.[options.projectId] ?? null,
        totalReservedMicros: 0,
        totalSettledMicros: 0,
        remainingBudgetMicros:
          options.projectBudgetCaps?.[options.projectId] !== undefined
            ? Math.min(globalRemaining, options.projectBudgetCaps[options.projectId]!)
            : globalRemaining,
        activeReservations: 0,
        settledJobs: 0,
      };
      return {
        globalBudgetCapMicros: summary.budgetCapMicros ?? this.globalBudgetCapMicros,
        totalReservedMicros: summary.totalReservedMicros,
        totalSettledMicros: summary.totalSettledMicros,
        remainingBudgetMicros: summary.remainingBudgetMicros,
        activeReservations: summary.activeReservations,
        settledJobs: summary.settledJobs,
        byProject: { [options.projectId]: summary },
        jobs: entries,
      };
    }

    return {
      globalBudgetCapMicros: this.globalBudgetCapMicros,
      totalReservedMicros: globalReservedMicros,
      totalSettledMicros: globalSettledMicros,
      remainingBudgetMicros: globalRemaining,
      activeReservations: globalActiveReservations,
      settledJobs: globalSettledJobs,
      byProject,
      jobs: entries,
    };
  }

  async list(projectId?: string): Promise<ComputeJob[]> {
    const docs = (await this.repository.listDocs()).map(normalizeComputeJob);
    return projectId ? docs.filter((j) => j.projectId === projectId) : docs;
  }

  async get(id: string): Promise<ComputeJob> {
    const job = await this.repository.getDoc(id);
    if (!job) throw new DomainError('Compute job not found', 404);
    return normalizeComputeJob(job);
  }

  async events(jobId?: string, projectId?: string): Promise<ComputeEvent[]> {
    const all = await this.repository.listEvents(200);
    return all.filter((event) => {
      if (jobId && event.jobId !== jobId) return false;
      if (projectId && event.projectId && event.projectId !== projectId) return false;
      return true;
    });
  }

  ledger(options?: { projectId?: string; projectBudgetCaps?: Readonly<Record<string, number>> }): Promise<ComputeLedgerSummary> {
    return this.tx(() => this.computeLedgerLocked(options));
  }

  async listDueWakeJobs(nowMs = this.now()): Promise<ComputeJob[]> {
    return (await this.list()).filter((job) => {
      const needsWake = job.status === 'running';
      const needsCostSettlement = Boolean(job.instance && job.cost.settledMicros === null && !TERMINAL_STATUSES.has(job.status));
      if (!needsWake && !needsCostSettlement) return false;
      const wakeDue = job.nextWakeAt ? Date.parse(job.nextWakeAt) <= nowMs : true;
      const ttlDue = job.instance?.expiresAt ? Date.parse(job.instance.expiresAt) <= nowMs : false;
      return wakeDue || ttlDue;
    });
  }

  async create(input: CreateComputeJob, policyContext: ComputeCreatePolicyContext = {}): Promise<ComputeJob> {
    return this.tx(() => {
      const projectId =
        input.projectId === undefined || input.projectId === DEFAULT_PROJECT_ID
          ? DEFAULT_PROJECT_ID
          : validateProjectId(input.projectId);
      const title = text(input.title, 'title', 160);
      const workloadId = text(input.workloadId, 'workloadId', 120);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(workloadId)) {
        throw new DomainError(`Invalid workloadId: ${input.workloadId}`, 400);
      }
      const workloadKind: ComputeWorkloadKind = input.workloadKind ?? 'batch';
      if (!(COMPUTE_WORKLOAD_KINDS as readonly string[]).includes(workloadKind)) {
        throw new DomainError(`Invalid workloadKind: ${String(input.workloadKind)}`, 400);
      }
      const repository = text(input.repository, 'repository', 200);
      if (!REPO_PATTERN.test(repository)) {
        throw new DomainError(`Invalid repository: ${input.repository}`, 400);
      }
      const baseCommit = text(input.baseCommit, 'baseCommit', 40).toLowerCase();
      if (!HEX40.test(baseCommit)) {
        throw new DomainError('Invalid baseCommit (40-char hex SHA required)', 400);
      }
      const compute = validateComputeSpec(input.compute, workloadId, {
        projectId,
        allowedS3Prefixes: policyContext.allowedS3Prefixes,
      });
      if (policyContext.maxLifetimeMs !== undefined && compute.maxLifetimeMs > policyContext.maxLifetimeMs) {
        throw new DomainError(
          `compute.maxLifetimeMs (${compute.maxLifetimeMs}) exceeds project limit (${policyContext.maxLifetimeMs})`,
          403,
        );
      }
      if (
        policyContext.maxSingleJobCostMicros !== undefined &&
        policyContext.maxSingleJobCostMicros !== null &&
        compute.maxTotalCostMicros > policyContext.maxSingleJobCostMicros
      ) {
        throw new DomainError(
          `compute.maxTotalCostMicros (${compute.maxTotalCostMicros}) exceeds project single-job limit (${policyContext.maxSingleJobCostMicros})`,
          403,
        );
      }
      const releasePolicy = validateComputeReleasePolicy(input.releasePolicy);
      const effectiveAutoPublishPrefixes = [
        ...new Set([...this.autoPublishRepoPrefixes, ...(policyContext.autoPublishRepoPrefixes ?? [])]),
      ];
      if (releasePolicy.autoPublish && !autoPublishAllowed(releasePolicy, effectiveAutoPublishPrefixes)) {
        throw new DomainError('releasePolicy.autoPublish is not allowed for this repository on this Control Plane', 403);
      }
      const approvalFingerprint = computeJobApprovalFingerprint({
        projectId,
        workloadId,
        workloadKind,
        repository,
        baseCommit,
        compute,
        releasePolicy,
      });
      const at = this.timestamp();
      const job: ComputeJob = {
        id: `cmp-${randomUUID()}`,
        projectId,
        title,
        workloadId,
        workloadKind,
        repository,
        baseCommit,
        status: 'awaiting_launch_approval',
        waitReason: 'awaiting_launch_approval',
        diagnostics: [],
        approvalFingerprint,
        compute,
        releasePolicy,
        cost: {
          reservedMicros: 0,
          settledMicros: null,
          hourlyRateUsd: compute.maxHourlyPriceUsd,
          instanceSeconds: null,
          settledAt: null,
        },
        instance: null,
        nextWakeAt: null,
        receipt: null,
        releaseAttestation: null,
        releaseDecision: null,
        publication: null,
        createdAt: at,
        updatedAt: at,
        approvedAt: null,
        approvalReason: null,
        cancelReason: null,
        failureReason: null,
      };
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.created',
        {
          projectId,
          workloadId,
          workloadKind,
          region: compute.region,
          instanceType: compute.instanceType,
          amiId: compute.amiId,
          maxTotalCostMicros: compute.maxTotalCostMicros,
          approvalFingerprint,
        },
        projectId,
      );
      return saved;
    });
  }

  async approveLaunch(
    id: string,
    approvalFingerprint: string,
    reason: string,
    budgetContext: ComputeApprovalBudgetContext = {},
  ): Promise<ComputeJob> {
    const result = await this.tx((): { ok: true; job: ComputeJob } | { ok: false; error: DomainError } => {
      const job = this.load(id);
      if (job.status !== 'awaiting_launch_approval') {
        throw new DomainError(`Cannot approve launch in state ${job.status}`, 409);
      }
      const submitted = text(approvalFingerprint, 'approvalFingerprint', 64).toLowerCase();
      if (submitted !== job.approvalFingerprint) {
        throw new DomainError('Launch approvalFingerprint does not match job specification', 409);
      }
      const cleanReason = text(reason, 'reason', 1000);

      // Single-job cap check
      if (
        budgetContext.maxSingleJobCostMicros !== undefined &&
        budgetContext.maxSingleJobCostMicros !== null &&
        job.compute.maxTotalCostMicros > budgetContext.maxSingleJobCostMicros
      ) {
        const message = `Project single-job cost cap exceeded: requested ${job.compute.maxTotalCostMicros} micros, limit ${budgetContext.maxSingleJobCostMicros} micros (project ${job.projectId})`;
        job.diagnostics.push(message);
        this.save(job);
        this.emit(
          job.id,
          'compute.cost_cap_rejected',
          {
            scope: 'single_job',
            projectId: job.projectId,
            requestedMicros: job.compute.maxTotalCostMicros,
            maxSingleJobCostMicros: budgetContext.maxSingleJobCostMicros,
          },
          job.projectId,
        );
        return { ok: false, error: new DomainError(message, 409) };
      }

      // Hard two-tier budget reservation check (host global ceiling + per-project ceiling)
      const caps =
        budgetContext.projectBudgetCapMicros !== undefined
          ? { [job.projectId]: budgetContext.projectBudgetCapMicros }
          : undefined;
      const globalLedger = this.computeLedgerLocked({ projectBudgetCaps: caps });
      if (job.compute.maxTotalCostMicros > globalLedger.remainingBudgetMicros) {
        const message = `Central cost cap exceeded: requested ${job.compute.maxTotalCostMicros} micros, remaining ${globalLedger.remainingBudgetMicros} micros (global cap ${globalLedger.globalBudgetCapMicros})`;
        job.diagnostics.push(message);
        this.save(job);
        this.emit(
          job.id,
          'compute.cost_cap_rejected',
          {
            scope: 'global',
            projectId: job.projectId,
            requestedMicros: job.compute.maxTotalCostMicros,
            remainingBudgetMicros: globalLedger.remainingBudgetMicros,
            globalBudgetCapMicros: globalLedger.globalBudgetCapMicros,
          },
          job.projectId,
        );
        return { ok: false, error: new DomainError(message, 409) };
      }

      if (budgetContext.projectBudgetCapMicros !== undefined) {
        const projectLedger = globalLedger.byProject[job.projectId];
        const projectCommitted = (projectLedger?.totalReservedMicros ?? 0) + (projectLedger?.totalSettledMicros ?? 0);
        const projectRemaining = Math.max(0, budgetContext.projectBudgetCapMicros - projectCommitted);
        if (job.compute.maxTotalCostMicros > projectRemaining) {
          const message = `Project '${job.projectId}' budget cap exceeded: requested ${job.compute.maxTotalCostMicros} micros, remaining ${projectRemaining} micros (project cap ${budgetContext.projectBudgetCapMicros})`;
          job.diagnostics.push(message);
          this.save(job);
          this.emit(
            job.id,
            'compute.cost_cap_rejected',
            {
              scope: 'project',
              projectId: job.projectId,
              requestedMicros: job.compute.maxTotalCostMicros,
              remainingProjectBudgetMicros: projectRemaining,
              projectBudgetCapMicros: budgetContext.projectBudgetCapMicros,
            },
            job.projectId,
          );
          return { ok: false, error: new DomainError(message, 409) };
        }
      }

      job.status = 'queued';
      job.waitReason = 'spot_capacity_retry';
      job.approvedAt = this.timestamp();
      job.approvalReason = cleanReason;
      job.cost.reservedMicros = job.compute.maxTotalCostMicros;
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.launch_approved',
        {
          projectId: saved.projectId,
          approvalFingerprint: submitted,
          reservedMicros: saved.cost.reservedMicros,
          reason: cleanReason,
        },
        saved.projectId,
      );
      return { ok: true, job: saved };
    });
    if (!result.ok) throw result.error;
    return result.job;
  }

  async recordInstanceLaunched(
    id: string,
    input: {
      region: string;
      availabilityZone: string | null;
      instanceId: string;
      instanceType: string;
      amiId: string;
      expiresAt: string;
      nextWakeAt: string;
    },
  ): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'queued') {
        throw new DomainError(`Cannot record launched instance in state ${job.status}`, 409);
      }
      const instanceId = text(input.instanceId, 'instanceId', 32).toLowerCase();
      if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new DomainError(`Invalid EC2 instanceId: ${input.instanceId}`, 400);
      }
      const launchedAt = this.timestamp();
      const instance: ComputeInstanceState = {
        region: text(input.region, 'region', 32).toLowerCase(),
        availabilityZone: input.availabilityZone ? text(input.availabilityZone, 'availabilityZone', 32) : null,
        instanceId,
        instanceType: text(input.instanceType, 'instanceType', 40).toLowerCase(),
        amiId: text(input.amiId, 'amiId', 32).toLowerCase(),
        launchedAt,
        expiresAt: text(input.expiresAt, 'expiresAt', 64),
        state: 'pending',
        terminatedAt: null,
        forcedTerminationReason: null,
      };
      job.instance = instance;
      job.status = 'running';
      job.waitReason = 'running_in_progress';
      job.nextWakeAt = text(input.nextWakeAt, 'nextWakeAt', 64);
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.instance_launched',
        {
          projectId: saved.projectId,
          region: instance.region,
          availabilityZone: instance.availabilityZone,
          instanceId: instance.instanceId,
          instanceType: instance.instanceType,
          amiId: instance.amiId,
          expiresAt: instance.expiresAt,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordWakeUpdate(
    id: string,
    update: {
      state: Ec2InstanceLifecycleState;
      nextWakeAt: string | null;
      forcedTerminationReason?: string;
      diagnostic?: string;
      endedAt?: string;
    },
  ): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (!job.instance) {
        throw new DomainError('Cannot record wake update without an active EC2 instance', 409);
      }
      job.instance.state = update.state;
      job.nextWakeAt = update.nextWakeAt;
      if (update.forcedTerminationReason) {
        job.instance.forcedTerminationReason = text(update.forcedTerminationReason, 'forcedTerminationReason', 500);
      }
      if (update.diagnostic) {
        job.diagnostics.push(text(update.diagnostic, 'diagnostic', 1000));
      }
      if (update.state === 'terminated' || update.state === 'shutting-down' || update.state === 'stopped') {
        job.instance.terminatedAt = job.instance.terminatedAt ?? update.endedAt ?? this.timestamp();
        if (job.status === 'running') {
          job.waitReason = job.cost.settledMicros === null ? 'awaiting_cost_settlement' : null;
        }
      }
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.wake_checked',
        {
          instanceId: job.instance.instanceId,
          state: update.state,
          nextWakeAt: update.nextWakeAt,
          forcedTerminationReason: job.instance.forcedTerminationReason,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async settleCost(
    id: string,
    input: { actualCostMicros: number; instanceSeconds: number; diagnostic?: string },
  ): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (!Number.isSafeInteger(input.actualCostMicros) || input.actualCostMicros < 0 || input.actualCostMicros > 10_000_000_000) {
        throw new DomainError('Invalid actualCostMicros', 400);
      }
      if (!Number.isSafeInteger(input.instanceSeconds) || input.instanceSeconds < 0 || input.instanceSeconds > 604_800 * 2) {
        throw new DomainError('Invalid instanceSeconds', 400);
      }
      job.cost.settledMicros = input.actualCostMicros;
      job.cost.instanceSeconds = input.instanceSeconds;
      job.cost.settledAt = this.timestamp();
      if (input.diagnostic) {
        job.diagnostics.push(text(input.diagnostic, 'diagnostic', 1000));
      }
      if (job.waitReason === 'awaiting_cost_settlement') {
        job.waitReason = null;
      }
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.cost_settled',
        {
          projectId: saved.projectId,
          reservedMicros: saved.cost.reservedMicros,
          settledMicros: saved.cost.settledMicros,
          instanceSeconds: saved.cost.instanceSeconds,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordArtifactReceipt(id: string, receipt: ComputeArtifactReceipt): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'running' && job.status !== 'evaluating') {
        throw new DomainError(`Cannot record artifact receipt in state ${job.status}`, 409);
      }
      if (receipt.version !== 1 || receipt.jobId !== job.id) {
        throw new DomainError('Artifact receipt version or jobId mismatch', 409);
      }
      const expectedDigest = computeArtifactManifestDigest(receipt.files);
      const submittedDigest = text(receipt.manifestDigest, 'manifestDigest', 64).toLowerCase();
      if (submittedDigest !== expectedDigest) {
        throw new DomainError('Artifact receipt manifestDigest does not match file SHA-256 hashes', 409);
      }
      const s3Bucket = text(receipt.s3Bucket, 's3Bucket', 128);
      const s3Prefix = normalizeRelativePath(receipt.s3Prefix, 's3Prefix');
      if (s3Prefix !== job.compute.s3ArtifactPrefix) {
        throw new DomainError('Artifact receipt s3Prefix does not match approved job prefix', 409);
      }
      job.receipt = {
        version: 1,
        jobId: job.id,
        s3Bucket,
        s3Prefix,
        manifestDigest: expectedDigest,
        files: receipt.files.map((f) => ({
          path: normalizeRelativePath(f.path, 'artifact path'),
          sha256: f.sha256.toLowerCase(),
          sizeBytes: f.sizeBytes,
        })),
        recordedAt: text(receipt.recordedAt, 'recordedAt', 64),
      };
      job.status = 'evaluating';
      job.nextWakeAt = null;
      if (job.waitReason === 'running_in_progress') {
        job.waitReason = job.cost.settledMicros === null ? 'awaiting_cost_settlement' : null;
      }
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.receipt_recorded',
        {
          manifestDigest: expectedDigest,
          fileCount: job.receipt.files.length,
          s3Prefix,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordReleaseAttestation(
    id: string,
    attestation: SubmitComputeReleaseAttestation,
    source: ComputeReleaseAttestationSource = 'operator_self_reported',
  ): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'evaluating' || !job.receipt) {
        throw new DomainError(`Cannot record release attestation without verified artifact receipt (state: ${job.status})`, 409);
      }
      const digest = text(attestation.manifestDigest, 'manifestDigest', 64).toLowerCase();
      if (digest !== job.receipt.manifestDigest) {
        throw new DomainError('Release attestation manifestDigest does not match S3 artifact receipt', 409);
      }
      const normalizedSource: ComputeReleaseAttestationSource =
        source === 'independent_verifier' ? 'independent_verifier' : 'operator_self_reported';
      const normalized: ComputeReleaseAttestation = {
        manifestDigest: digest,
        releaseCheckPassed: Boolean(attestation.releaseCheckPassed),
        metrics: attestation.metrics && typeof attestation.metrics === 'object' ? { ...attestation.metrics } : {},
        summary: text(attestation.summary, 'attestation summary', 4000),
        verifiedAt: text(attestation.verifiedAt, 'verifiedAt', 64),
        attestationSource: normalizedSource,
        verificationDisclaimer:
          normalizedSource === 'independent_verifier' ? null : OPERATOR_SELF_REPORTED_DISCLAIMER,
      };
      job.releaseAttestation = normalized;
      if (normalized.releaseCheckPassed) {
        job.status = 'awaiting_release_approval';
        job.waitReason = 'awaiting_release_approval';
      } else {
        job.status = 'failed';
        job.waitReason = null;
        job.failureReason = `Release check failed: ${normalized.summary}`;
        job.diagnostics.push(job.failureReason);
      }
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.release_attested',
        {
          manifestDigest: digest,
          releaseCheckPassed: normalized.releaseCheckPassed,
          attestationSource: normalized.attestationSource,
          nextStatus: saved.status,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordVerifierDispatched(id: string, ecsTaskArn: string): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'evaluating' || !job.receipt) {
        throw new DomainError(`Cannot dispatch a release verifier without a verified artifact receipt (state: ${job.status})`, 409);
      }
      job.releaseVerifier = { ecsTaskArn: text(ecsTaskArn, 'ecsTaskArn', 512), dispatchedAt: this.timestamp() };
      const saved = this.save(job);
      this.emit(saved.id, 'compute.release_verifier_dispatched', { ecsTaskArn: job.releaseVerifier.ecsTaskArn }, saved.projectId);
      return saved;
    });
  }

  async recordPlacementPlan(id: string, plan: ComputePlacementPlan): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new DomainError(`Cannot record a placement plan in state ${job.status}`, 409);
      }
      const allowed = new Set([job.compute.region, ...(job.compute.candidateRegions ?? [])]);
      if (plan.regions.some((entry) => !allowed.has(entry.region))) {
        throw new DomainError('Placement plan names a region the job does not list', 400);
      }
      job.placementPlan = structuredClone(plan);
      const saved = this.save(job);
      const first = plan.regions[0];
      this.emit(
        saved.id,
        'compute.placement_planned',
        {
          status: plan.status,
          feedPool: plan.feedPool,
          feedGeneratedAt: plan.feedGeneratedAt,
          regionOrder: plan.regions.map((entry) => entry.region),
          firstAzId: first?.azs[0]?.azId ?? null,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  isAutoPublishEligible(job: ComputeJob, projectAutoPublishPrefixes?: readonly string[]): boolean {
    const prefixes = [
      ...new Set([...this.autoPublishRepoPrefixes, ...(projectAutoPublishPrefixes ?? [])]),
    ];
    return (
      job.status === 'awaiting_release_approval' &&
      autoPublishAllowed(job.releasePolicy, prefixes) &&
      job.releaseAttestation?.attestationSource === 'independent_verifier' &&
      job.releaseAttestation.releaseCheckPassed === true &&
      Boolean(job.receipt) &&
      job.releaseAttestation.manifestDigest === job.receipt!.manifestDigest
    );
  }

  async recordAutoReleaseDecision(id: string, projectAutoPublishPrefixes?: readonly string[]): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (!this.isAutoPublishEligible(job, projectAutoPublishPrefixes)) {
        throw new DomainError(`Job ${id} is not eligible for automatic publication`, 409);
      }
      job.releaseDecision = {
        decision: 'approve',
        openedRawArtifacts: false,
        durationMinutes: 0,
        reason: 'Auto-publish policy: the independent verifier passed the release check',
        decidedAt: this.timestamp(),
      };
      job.status = 'release_approved';
      job.waitReason = null;
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.release_auto_approved',
        {
          repository: job.releasePolicy.hfRepository ?? null,
          manifestDigest: job.receipt!.manifestDigest,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordReleaseDecision(id: string, input: Omit<ComputeReleaseDecision, 'decidedAt'>): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'awaiting_release_approval' || !job.releaseAttestation?.releaseCheckPassed) {
        throw new DomainError(`Cannot decide release in state ${job.status}`, 409);
      }
      if (input.decision !== 'approve' && input.decision !== 'reject') {
        throw new DomainError('Release decision must be approve or reject', 400);
      }
      if (typeof input.openedRawArtifacts !== 'boolean') {
        throw new DomainError('openedRawArtifacts boolean is required', 400);
      }
      if (typeof input.durationMinutes !== 'number' || !Number.isFinite(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 10_080) {
        throw new DomainError('Invalid durationMinutes', 400);
      }
      const reason = text(input.reason, 'reason', 2000);
      job.releaseDecision = {
        decision: input.decision,
        openedRawArtifacts: input.openedRawArtifacts,
        durationMinutes: input.durationMinutes,
        reason,
        decidedAt: this.timestamp(),
      };
      job.status = input.decision === 'approve' ? 'release_approved' : 'rejected';
      job.waitReason = null;
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.release_decided',
        {
          decision: input.decision,
          openedRawArtifacts: input.openedRawArtifacts,
          durationMinutes: input.durationMinutes,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async recordPublicationFailure(id: string, reason: string): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'release_approved' || job.publication) {
        throw new DomainError(`Cannot record a publication failure in state ${job.status}`, 409);
      }
      const clipped = reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
      job.diagnostics = [...job.diagnostics, `Release publication failed: ${clipped}`].slice(-20);
      const saved = this.save(job);
      this.emit(saved.id, 'compute.release_publish_failed', { reason: clipped }, saved.projectId);
      return saved;
    });
  }

  async recordPublicationStarted(id: string): Promise<void> {
    await this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'release_approved' || job.publication) {
        throw new DomainError(`Cannot publish in state ${job.status}`, 409);
      }
      this.emit(job.id, 'compute.release_publish_started', { mode: job.releasePolicy.mode }, job.projectId);
    });
  }

  async recordReleasePublication(id: string, publication: ComputeReleasePublication): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'release_approved' || !job.receipt || !job.releaseAttestation) {
        throw new DomainError(`Cannot record release publication in state ${job.status}`, 409);
      }
      const digest = text(publication.manifestDigest, 'manifestDigest', 64).toLowerCase();
      if (digest !== job.receipt.manifestDigest || digest !== job.releaseAttestation.manifestDigest) {
        throw new DomainError('Published manifestDigest does not match verified receipt & attestation', 409);
      }
      if (publication.mode !== job.releasePolicy.mode) {
        throw new DomainError('Published mode does not match approved releasePolicy', 409);
      }
      if (publication.mode === 'hf_release') {
        if (publication.repository !== job.releasePolicy.hfRepository) {
          throw new DomainError('Published HF repository does not match approved releasePolicy', 409);
        }
      }
      job.publication = {
        mode: publication.mode,
        ...(publication.repository ? { repository: text(publication.repository, 'repository', 200) } : {}),
        ...(publication.revision ? { revision: text(publication.revision, 'revision', 120) } : {}),
        ...(publication.commitSha ? { commitSha: text(publication.commitSha, 'commitSha', 64) } : {}),
        ...(publication.url ? { url: text(publication.url, 'url', 512) } : {}),
        ...(Number.isSafeInteger(publication.verifiedFiles) && publication.verifiedFiles! >= 0 ? { verifiedFiles: publication.verifiedFiles } : {}),
        ...(publication.approvedBy === 'operator' || publication.approvedBy === 'auto_publish_policy' ? { approvedBy: publication.approvedBy } : {}),
        manifestDigest: digest,
        publishedAt: text(publication.publishedAt, 'publishedAt', 64),
      };
      job.status = 'released';
      job.waitReason = null;
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.released',
        {
          mode: publication.mode,
          repository: publication.repository ?? null,
          manifestDigest: digest,
        },
        saved.projectId,
      );
      return saved;
    });
  }

  async fail(id: string, reason: string, diagnostic?: string): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new DomainError(`Cannot fail compute job in terminal state ${job.status}`, 409);
      }
      const cleanReason = text(clip(reason, 1000) || 'Failed without a reason', 'reason', 1000);
      job.status = 'failed';
      job.waitReason = null;
      job.nextWakeAt = null;
      job.failureReason = cleanReason;
      const cleanDiagnostic = diagnostic ? clip(diagnostic, 1000) : '';
      job.diagnostics.push(cleanDiagnostic ? text(cleanDiagnostic, 'diagnostic', 1000) : cleanReason);
      if (!job.instance && job.cost.settledMicros === null) {
        job.cost.settledMicros = 0;
        job.cost.instanceSeconds = 0;
        job.cost.settledAt = this.timestamp();
      }
      const saved = this.save(job);
      this.emit(saved.id, 'compute.failed', { reason: cleanReason }, saved.projectId);
      return saved;
    });
  }

  async cancel(id: string, reason: string): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new DomainError(`Cannot cancel compute job in terminal state ${job.status}`, 409);
      }
      const cleanReason = text(reason, 'reason', 1000);
      job.status = 'cancelled';
      job.waitReason = job.instance && job.cost.settledMicros === null ? 'awaiting_cost_settlement' : null;
      job.nextWakeAt = null;
      job.cancelReason = cleanReason;
      if (!job.instance && job.cost.settledMicros === null) {
        job.cost.settledMicros = 0;
        job.cost.instanceSeconds = 0;
        job.cost.settledAt = this.timestamp();
      }
      const saved = this.save(job);
      this.emit(saved.id, 'compute.cancelled', { reason: cleanReason }, saved.projectId);
      return saved;
    });
  }

  /** Appends an immutable approval policy evaluation or operator decision record to the job audit trail. */
  async recordApprovalDecision(id: string, record: ApprovalDecisionRecord): Promise<ComputeJob> {
    return this.tx(() => {
      const job = this.load(id);
      const list = Array.isArray(job.approvalDecisions) ? [...job.approvalDecisions] : [];
      list.push(structuredClone(record));
      job.approvalDecisions = list.slice(-50);
      const saved = this.save(job);
      this.emit(
        saved.id,
        'compute.approval_evaluated',
        {
          decisionId: record.id,
          gate: record.gate,
          outcome: record.outcome,
          actorKind: record.actorKind,
          policyVersion: record.policyVersion,
          policyMode: record.policyMode,
          summary: record.summary,
        },
        saved.projectId,
      );
      return saved;
    });
  }
}
