import { createHash, randomUUID } from 'node:crypto';
import {
  SqliteModelFactoryRepository,
  type ModelFactoryEventDraft,
  type ModelFactoryRepository,
  type ModelFactoryTxState,
} from './model-factory-repository.js';
import type {
  CreateModelFactoryJob,
  Ec2InstanceLifecycleState,
  ModelArtifactFile,
  ModelArtifactReceipt,
  ModelFactoryEvent,
  ModelFactoryInstanceState,
  ModelFactoryJob,
  ModelFactoryJobStatus,
  ModelFactoryLedgerSummary,
  ModelReleaseAttestation,
  ModelReleaseAttestationSource,
  ModelReleaseDecision,
  ModelReleasePolicy,
  ModelReleasePublication,
  ModelTrainingInputFile,
  ModelTrainingInputSpec,
  SubmitModelReleaseAttestation,
  TrainingComputeSpec,
} from '../../contracts/src/model-factory.js';
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

const TERMINAL_STATUSES = new Set<ModelFactoryJobStatus>(['released', 'failed', 'cancelled', 'rejected']);
const DEFAULT_GLOBAL_BUDGET_CAP_MICROS = 500_000_000; // $500 hard central default
export const OPERATOR_SELF_REPORTED_DISCLAIMER =
  '이 검사 결과는 운영자/호출자가 직접 보고한 값이며, HIVEMIND가 releaseCheckCommand를 독립 격리 환경에서 실행해 검증하지 않았습니다.';

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

/**
 * Order of the file list inside a digest. The training instance computes the artifact digest itself, in
 * whatever language its script uses, so the order must not depend on a locale. Paths are compared by
 * UTF-16 code unit, which for ASCII paths is plain byte order (`sorted()` in Python, `sort` with LC_ALL=C).
 * A locale comparison would put `model/config.json` before `model/README.md`, and a byte-order sort on the
 * instance would then produce a different digest and the receipt would be refused.
 */
/** Cuts a message to a stored field's limit and marks the cut. */
function clip(value: unknown, max: number): string {
  const str = (typeof value === 'string' ? value : String(value ?? '')).trim();
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function byPathCodeUnits(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function computeTrainingInputsDigest(s3Prefix: string, files: ModelTrainingInputFile[]): string {
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

export function validateTrainingInputSpec(
  raw: Omit<ModelTrainingInputSpec, 'digest'> & { digest?: string },
  modelId: string,
): ModelTrainingInputSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('compute.inputs must be an object', 400);
  }
  const s3Prefix = normalizeRelativePath(raw.s3Prefix, 'compute.inputs.s3Prefix');
  const expectedPrefixRoot = `models/${modelId}/inputs/`;
  if (!s3Prefix.startsWith(expectedPrefixRoot) && s3Prefix !== `models/${modelId}/inputs`) {
    throw new DomainError(`compute.inputs.s3Prefix must start with ${expectedPrefixRoot}`, 400);
  }
  const computedDigest = computeTrainingInputsDigest(s3Prefix, raw.files);
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

export function computeModelManifestDigest(files: ModelArtifactFile[]): string {
  if (!Array.isArray(files) || files.length === 0 || files.length > 1000) {
    throw new DomainError('Model artifact receipt requires 1..1000 files', 400);
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

export function validateTrainingComputeSpec(
  spec: CreateModelFactoryJob['compute'],
  modelId?: string,
): TrainingComputeSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new DomainError('Training compute specification is required', 400);
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
  let regionOverrides: TrainingComputeSpec['regionOverrides'];
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
  if (!s3ArtifactPrefix.startsWith('models/') || s3ArtifactPrefix.split('/').includes('inputs')) {
    throw new DomainError('compute.s3ArtifactPrefix must start with models/ and must not overlap inputs/', 400);
  }
  if (modelId && !s3ArtifactPrefix.startsWith(`models/${modelId}/`)) {
    throw new DomainError(`compute.s3ArtifactPrefix must start with models/${modelId}/`, 400);
  }
  const inputs =
    spec.inputs === undefined
      ? undefined
      : validateTrainingInputSpec(spec.inputs, modelId ?? s3ArtifactPrefix.split('/')[1] ?? 'model');
  const workloadClass =
    spec.workloadClass === undefined ? undefined : text(spec.workloadClass, 'compute.workloadClass', 64);

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
    s3ArtifactPrefix,
    ...(inputs ? { inputs } : {}),
  };
}

export function validateModelReleasePolicy(policy: ModelReleasePolicy): ModelReleasePolicy {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new DomainError('Model release policy is required', 400);
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
  return {
    mode: policy.mode,
    ...(hfRepository ? { hfRepository } : {}),
    ...(hfRevision ? { hfRevision } : {}),
    visibility: policy.visibility,
    releaseCheckCommand,
  };
}

export function computeModelFactoryApprovalFingerprint(spec: {
  modelId: string;
  repository: string;
  baseCommit: string;
  compute: TrainingComputeSpec;
  releasePolicy: ModelReleasePolicy;
}): string {
  return sha256Hex(
    JSON.stringify({
      version: 1,
      modelId: spec.modelId,
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
        ...(spec.compute.inputs
          ? { inputsS3Prefix: spec.compute.inputs.s3Prefix, inputsDigest: spec.compute.inputs.digest }
          : {}),
      },
      releasePolicy: spec.releasePolicy,
    }),
  );
}

export interface ModelFactoryStoreOptions {
  now?: () => number;
  globalBudgetCapMicros?: number;
}

export class ModelFactoryStore {
  private readonly repository: ModelFactoryRepository;
  private readonly now: () => number;
  private readonly globalBudgetCapMicros: number;
  /** Set only while the synchronous body of a repository transaction runs. */
  private activeTx: ModelFactoryTxState | null = null;

  /**
   * @param storage A SQLite file path (local default) or any ModelFactoryRepository, for example the
   *   Aurora DSQL repository on AWS.
   */
  constructor(storage: string | ModelFactoryRepository = ':memory:', options: ModelFactoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.globalBudgetCapMicros = options.globalBudgetCapMicros ?? DEFAULT_GLOBAL_BUDGET_CAP_MICROS;
    if (!Number.isSafeInteger(this.globalBudgetCapMicros) || this.globalBudgetCapMicros < 1) {
      throw new DomainError('Invalid globalBudgetCapMicros', 400);
    }
    this.repository = typeof storage === 'string' ? new SqliteModelFactoryRepository(storage) : storage;
  }

  get storageBackend(): ModelFactoryRepository['storageBackend'] {
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

  private txState(): ModelFactoryTxState {
    if (!this.activeTx) throw new Error('ModelFactoryStore state accessed outside a repository transaction');
    return this.activeTx;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private load(id: string): ModelFactoryJob {
    const job = this.txState().docs.get(id);
    if (!job) throw new DomainError('Model factory job not found', 404);
    return structuredClone(job);
  }

  private save(job: ModelFactoryJob): ModelFactoryJob {
    job.updatedAt = this.timestamp();
    const state = this.txState();
    state.docs.set(job.id, structuredClone(job));
    state.dirtyIds.add(job.id);
    return structuredClone(job);
  }

  private emit(jobId: string, type: string, data: Record<string, unknown>): void {
    this.txState().newEvents.push({ jobId, type, at: this.timestamp(), data } as ModelFactoryEventDraft);
  }

  private computeLedgerLocked(): ModelFactoryLedgerSummary {
    const jobs = [...this.txState().docs.values()];

    let totalReservedMicros = 0;
    let totalSettledMicros = 0;
    let activeReservations = 0;
    let settledJobs = 0;

    const entries = jobs.map((job) => {
      if (job.cost.settledMicros !== null) {
        totalSettledMicros += job.cost.settledMicros;
        settledJobs += 1;
      } else if (job.cost.reservedMicros > 0) {
        totalReservedMicros += job.cost.reservedMicros;
        activeReservations += 1;
      }
      return {
        jobId: job.id,
        modelId: job.modelId,
        status: job.status,
        region: job.compute.region,
        instanceType: job.compute.instanceType,
        reservedMicros: job.cost.reservedMicros,
        settledMicros: job.cost.settledMicros,
        createdAt: job.createdAt,
        settledAt: job.cost.settledAt,
      };
    });

    const committed = totalReservedMicros + totalSettledMicros;
    return {
      globalBudgetCapMicros: this.globalBudgetCapMicros,
      totalReservedMicros,
      totalSettledMicros,
      remainingBudgetMicros: Math.max(0, this.globalBudgetCapMicros - committed),
      activeReservations,
      settledJobs,
      jobs: entries,
    };
  }

  async list(): Promise<ModelFactoryJob[]> {
    return this.repository.listDocs();
  }

  async get(id: string): Promise<ModelFactoryJob> {
    const job = await this.repository.getDoc(id);
    if (!job) throw new DomainError('Model factory job not found', 404);
    return job;
  }

  async events(jobId?: string): Promise<ModelFactoryEvent[]> {
    return (await this.repository.listEvents(200)).filter((event) => (jobId ? event.jobId === jobId : true));
  }

  ledger(): Promise<ModelFactoryLedgerSummary> {
    return this.tx(() => this.computeLedgerLocked());
  }

  async listDueWakeJobs(nowMs = this.now()): Promise<ModelFactoryJob[]> {
    return (await this.list()).filter((job) => {
      const needsTrainingWake = job.status === 'training_running';
      const needsCostSettlement = Boolean(job.instance && job.cost.settledMicros === null && !TERMINAL_STATUSES.has(job.status));
      if (!needsTrainingWake && !needsCostSettlement) return false;
      const wakeDue = job.nextWakeAt ? Date.parse(job.nextWakeAt) <= nowMs : true;
      const ttlDue = job.instance?.expiresAt ? Date.parse(job.instance.expiresAt) <= nowMs : false;
      return wakeDue || ttlDue;
    });
  }

  async create(input: CreateModelFactoryJob): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const title = text(input.title, 'title', 160);
      const modelId = text(input.modelId, 'modelId', 120);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(modelId)) {
        throw new DomainError(`Invalid modelId: ${input.modelId}`, 400);
      }
      const repository = text(input.repository, 'repository', 200);
      if (!REPO_PATTERN.test(repository)) {
        throw new DomainError(`Invalid repository: ${input.repository}`, 400);
      }
      const baseCommit = text(input.baseCommit, 'baseCommit', 40).toLowerCase();
      if (!HEX40.test(baseCommit)) {
        throw new DomainError('Invalid baseCommit (40-char hex SHA required)', 400);
      }
      const compute = validateTrainingComputeSpec(input.compute, modelId);
      const releasePolicy = validateModelReleasePolicy(input.releasePolicy);
      const approvalFingerprint = computeModelFactoryApprovalFingerprint({
        modelId,
        repository,
        baseCommit,
        compute,
        releasePolicy,
      });
      const at = this.timestamp();
      const job: ModelFactoryJob = {
        id: `mf-${randomUUID()}`,
        title,
        modelId,
        repository,
        baseCommit,
        status: 'awaiting_training_approval',
        waitReason: 'awaiting_training_approval',
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
      this.emit(saved.id, 'model_factory.created', {
        modelId,
        region: compute.region,
        instanceType: compute.instanceType,
        amiId: compute.amiId,
        maxTotalCostMicros: compute.maxTotalCostMicros,
        approvalFingerprint,
      });
      return saved;
    });
  }

  async approveTraining(id: string, approvalFingerprint: string, reason: string): Promise<ModelFactoryJob> {
    const result = await this.tx((): { ok: true; job: ModelFactoryJob } | { ok: false; error: DomainError } => {
      const job = this.load(id);
      if (job.status !== 'awaiting_training_approval') {
        throw new DomainError(`Cannot approve training in state ${job.status}`, 409);
      }
      const submitted = text(approvalFingerprint, 'approvalFingerprint', 64).toLowerCase();
      if (submitted !== job.approvalFingerprint) {
        throw new DomainError('Training approvalFingerprint does not match job specification', 409);
      }
      const cleanReason = text(reason, 'reason', 1000);

      // Hard central cost reservation check (B4) — persist diagnostic & audit event before returning 409.
      const ledger = this.computeLedgerLocked();
      if (job.compute.maxTotalCostMicros > ledger.remainingBudgetMicros) {
        const message = `Central cost cap exceeded: requested ${job.compute.maxTotalCostMicros} micros, remaining ${ledger.remainingBudgetMicros} micros (global cap ${ledger.globalBudgetCapMicros})`;
        job.diagnostics.push(message);
        this.save(job);
        this.emit(job.id, 'model_factory.cost_cap_rejected', {
          requestedMicros: job.compute.maxTotalCostMicros,
          remainingBudgetMicros: ledger.remainingBudgetMicros,
          globalBudgetCapMicros: ledger.globalBudgetCapMicros,
        });
        return { ok: false, error: new DomainError(message, 409) };
      }

      job.status = 'training_queued';
      job.waitReason = 'spot_capacity_retry';
      job.approvedAt = this.timestamp();
      job.approvalReason = cleanReason;
      job.cost.reservedMicros = job.compute.maxTotalCostMicros;
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.training_approved', {
        approvalFingerprint: submitted,
        reservedMicros: saved.cost.reservedMicros,
        reason: cleanReason,
      });
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
  ): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'training_queued') {
        throw new DomainError(`Cannot record launched instance in state ${job.status}`, 409);
      }
      const instanceId = text(input.instanceId, 'instanceId', 32).toLowerCase();
      if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new DomainError(`Invalid EC2 instanceId: ${input.instanceId}`, 400);
      }
      const launchedAt = this.timestamp();
      const instance: ModelFactoryInstanceState = {
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
      job.status = 'training_running';
      job.waitReason = 'training_in_progress';
      job.nextWakeAt = text(input.nextWakeAt, 'nextWakeAt', 64);
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.instance_launched', {
        region: instance.region,
        availabilityZone: instance.availabilityZone,
        instanceId: instance.instanceId,
        instanceType: instance.instanceType,
        amiId: instance.amiId,
        expiresAt: instance.expiresAt,
      });
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
    },
  ): Promise<ModelFactoryJob> {
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
        job.instance.terminatedAt = job.instance.terminatedAt ?? this.timestamp();
        if (job.status === 'training_running') {
          job.waitReason = job.cost.settledMicros === null ? 'awaiting_cost_settlement' : null;
        }
      }
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.wake_checked', {
        instanceId: job.instance.instanceId,
        state: update.state,
        nextWakeAt: update.nextWakeAt,
        forcedTerminationReason: job.instance.forcedTerminationReason,
      });
      return saved;
    });
  }

  async settleCost(
    id: string,
    input: { actualCostMicros: number; instanceSeconds: number; diagnostic?: string },
  ): Promise<ModelFactoryJob> {
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
      this.emit(saved.id, 'model_factory.cost_settled', {
        reservedMicros: saved.cost.reservedMicros,
        settledMicros: saved.cost.settledMicros,
        instanceSeconds: saved.cost.instanceSeconds,
      });
      return saved;
    });
  }

  async recordArtifactReceipt(id: string, receipt: ModelArtifactReceipt): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'training_running' && job.status !== 'evaluating') {
        throw new DomainError(`Cannot record artifact receipt in state ${job.status}`, 409);
      }
      if (receipt.version !== 1 || receipt.jobId !== job.id) {
        throw new DomainError('Artifact receipt version or jobId mismatch', 409);
      }
      const expectedDigest = computeModelManifestDigest(receipt.files);
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
      if (job.waitReason === 'training_in_progress') {
        job.waitReason = job.cost.settledMicros === null ? 'awaiting_cost_settlement' : null;
      }
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.receipt_recorded', {
        manifestDigest: expectedDigest,
        fileCount: job.receipt.files.length,
        s3Prefix,
      });
      return saved;
    });
  }

  async recordReleaseAttestation(
    id: string,
    attestation: SubmitModelReleaseAttestation,
    source: ModelReleaseAttestationSource = 'operator_self_reported',
  ): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'evaluating' || !job.receipt) {
        throw new DomainError(`Cannot record release attestation without verified artifact receipt (state: ${job.status})`, 409);
      }
      const digest = text(attestation.manifestDigest, 'manifestDigest', 64).toLowerCase();
      if (digest !== job.receipt.manifestDigest) {
        throw new DomainError('Release attestation manifestDigest does not match S3 artifact receipt', 409);
      }
      const normalizedSource: ModelReleaseAttestationSource =
        source === 'independent_verifier' ? 'independent_verifier' : 'operator_self_reported';
      const normalized: ModelReleaseAttestation = {
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
      this.emit(saved.id, 'model_factory.release_attested', {
        manifestDigest: digest,
        releaseCheckPassed: normalized.releaseCheckPassed,
        attestationSource: normalized.attestationSource,
        nextStatus: saved.status,
      });
      return saved;
    });
  }

  /** Records that an independent verifier task was started. Allowed only while the job awaits verification. */
  async recordVerifierDispatched(id: string, ecsTaskArn: string): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (job.status !== 'evaluating' || !job.receipt) {
        throw new DomainError(`Cannot dispatch a release verifier without a verified artifact receipt (state: ${job.status})`, 409);
      }
      job.releaseVerifier = { ecsTaskArn: text(ecsTaskArn, 'ecsTaskArn', 512), dispatchedAt: this.timestamp() };
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.release_verifier_dispatched', { ecsTaskArn: job.releaseVerifier.ecsTaskArn });
      return saved;
    });
  }

  async recordReleaseDecision(id: string, input: Omit<ModelReleaseDecision, 'decidedAt'>): Promise<ModelFactoryJob> {
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
      this.emit(saved.id, 'model_factory.release_decided', {
        decision: input.decision,
        openedRawArtifacts: input.openedRawArtifacts,
        durationMinutes: input.durationMinutes,
      });
      return saved;
    });
  }

  async recordReleasePublication(id: string, publication: ModelReleasePublication): Promise<ModelFactoryJob> {
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
        manifestDigest: digest,
        publishedAt: text(publication.publishedAt, 'publishedAt', 64),
      };
      job.status = 'released';
      job.waitReason = null;
      const saved = this.save(job);
      this.emit(saved.id, 'model_factory.released', {
        mode: publication.mode,
        repository: publication.repository ?? null,
        manifestDigest: digest,
      });
      return saved;
    });
  }

  async fail(id: string, reason: string, diagnostic?: string): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new DomainError(`Cannot fail model factory job in terminal state ${job.status}`, 409);
      }
      // Recording a failure must not fail itself. A reason that is too long is cut, not refused: a refused
      // reason would leave the job in its previous state with its budget still reserved.
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
      this.emit(saved.id, 'model_factory.failed', { reason: cleanReason });
      return saved;
    });
  }

  async cancel(id: string, reason: string): Promise<ModelFactoryJob> {
    return this.tx(() => {
      const job = this.load(id);
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new DomainError(`Cannot cancel model factory job in terminal state ${job.status}`, 409);
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
      this.emit(saved.id, 'model_factory.cancelled', { reason: cleanReason });
      return saved;
    });
  }
}
