import type { ApprovalDecisionRecord } from '../../contracts/src/approval-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  SqliteDeliveryRepository,
  type DeliveryEventDraft,
  type DeliveryRepository,
  type DeliveryTxState,
} from './delivery-repository.js';
import type {
  AcceptanceTestFile,
  AcceptanceTestSpec,
  BundleManifest,
  ChangedFileStat,
  CreateDeliveryTask,
  DeliveryChangeSummary,
  DeliveryEvent,
  DeliveryModelUsage,
  DeliveryPolicy,
  DeliveryPreflightReport,
  DeliveryProvider,
  DeliveryTask,
  DraftPrPublication,
  HumanDeliveryDecision,
  SpotInterruptionPolicy,
  VerificationAttestation,
  WorkerExecutionPolicy,
} from '../../contracts/src/delivery.js';
import type { RegionPlacementDecision, RegionRoutingPolicy } from '../../contracts/src/multi-region.js';
import { validateRegionRoutingPolicy } from './multi-region.js';
import { DomainError, text } from './store.js';
import { DEFAULT_PROJECT_ID, validateProjectId } from './projects.js';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROTECTED_BRANCHES = new Set(['main', 'master']);
const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'failed', 'cancelled']);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeRepoRelativePath(raw: string): string {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || raw.includes('\0') || raw.includes('\\')) {
    throw new DomainError('Invalid repository relative path', 400);
  }
  if (raw.startsWith('/') || raw.endsWith('/')) {
    throw new DomainError('Repository path must be relative without leading or trailing slash', 400);
  }
  const parts = raw.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part === '.git') {
      throw new DomainError('Unsafe repository path segment', 400);
    }
  }
  return parts.join('/');
}

function validateGitRefPart(raw: string, name: string, allowTrailingSlash = false): string {
  const value = text(raw, name, 120);
  if (
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    /[\s~^:?*[\]\\]/.test(value) ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    (!allowTrailingSlash && value.endsWith('/'))
  ) {
    throw new DomainError(`Invalid ${name}`, 400);
  }
  return value;
}

export function validateAcceptanceTestSpec(input: unknown): AcceptanceTestSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid acceptance test spec', 400);
  }
  const raw = input as Record<string, unknown>;
  const baseCommit = text(raw.baseCommit, 'baseCommit', 40).toLowerCase();
  if (!HEX40.test(baseCommit)) throw new DomainError('Invalid baseCommit', 400);
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > 256) {
    throw new DomainError('Acceptance test spec requires 1 to 256 pinned files', 400);
  }
  const seen = new Set<string>();
  const files: AcceptanceTestFile[] = raw.files.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new DomainError('Invalid acceptance test file entry', 400);
    }
    const entry = item as Record<string, unknown>;
    const path = normalizeRepoRelativePath(String(entry.path ?? ''));
    if (seen.has(path)) throw new DomainError(`Duplicate acceptance test path: ${path}`, 400);
    seen.add(path);
    const sha256 = text(entry.sha256, 'acceptance file sha256', 64).toLowerCase();
    if (!HEX64.test(sha256)) throw new DomainError('Invalid acceptance file sha256', 400);
    return { path, sha256 };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!Array.isArray(raw.testCommand) || raw.testCommand.length < 1 || raw.testCommand.length > 32) {
    throw new DomainError('Invalid acceptance testCommand', 400);
  }
  const testCommand = raw.testCommand.map((arg) => {
    if (typeof arg !== 'string' || !arg.trim() || arg.length > 1000 || arg.includes('\0')) {
      throw new DomainError('Invalid acceptance testCommand argument', 400);
    }
    return arg;
  });
  const computed = computeAcceptanceTestDigest({ baseCommit, files, testCommand });
  const digest = raw.digest === undefined ? computed : text(raw.digest, 'acceptance digest', 64).toLowerCase();
  if (!HEX64.test(digest) || digest !== computed) {
    throw new DomainError('Acceptance test digest mismatch', 400);
  }
  return { baseCommit, files, testCommand, digest };
}

export function computeAcceptanceTestDigest(spec: {
  baseCommit: string;
  files: AcceptanceTestFile[];
  testCommand: string[];
}): string {
  const sorted = [...spec.files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256Hex(
    JSON.stringify({
      version: 1,
      baseCommit: spec.baseCommit.toLowerCase(),
      files: sorted.map((file) => ({ path: file.path, sha256: file.sha256.toLowerCase() })),
      testCommand: spec.testCommand,
    }),
  );
}

export function validateDeliveryPolicy(input: unknown): DeliveryPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid delivery policy', 400);
  }
  const raw = input as Record<string, unknown>;
  if (raw.mode !== 'draft_pr') throw new DomainError('Only draft_pr delivery mode is supported', 400);
  if (raw.autoMerge !== false && raw.autoMerge !== true) throw new DomainError('delivery.autoMerge must be a boolean', 400);
  let protectedPaths: string[] | undefined;
  if (raw.autoMerge === true) {
    if (!Array.isArray(raw.protectedPaths) || raw.protectedPaths.length < 1 || raw.protectedPaths.length > 64) {
      throw new DomainError('delivery.autoMerge requires 1..64 protectedPaths', 400);
    }
    protectedPaths = raw.protectedPaths.map((p) => {
      const path = text(p, 'protectedPaths[]', 300);
      if (path.startsWith('/') || path.includes('..') || path.includes('\\') || /\*\*|\*[^/]*\*/.test(path) || !/^[A-Za-z0-9_.*\/-]+$/.test(path)) {
        throw new DomainError(`Invalid protected path: ${path}`, 400);
      }
      return path;
    });
  } else if (raw.protectedPaths !== undefined) {
    throw new DomainError('delivery.protectedPaths is only for autoMerge', 400);
  }
  const repository = text(raw.repository, 'delivery repository', 200);
  if (!REPO_PATTERN.test(repository)) throw new DomainError('Invalid delivery repository', 400);
  const baseBranch = validateGitRefPart(String(raw.baseBranch ?? ''), 'baseBranch', false);
  const branchPrefix = validateGitRefPart(String(raw.branchPrefix ?? ''), 'branchPrefix', true);
  if (!branchPrefix.endsWith('/')) {
    throw new DomainError('branchPrefix must end with / to isolate agent branches', 400);
  }
  const prefixRoot = branchPrefix.slice(0, -1);
  if (PROTECTED_BRANCHES.has(prefixRoot) || prefixRoot === baseBranch) {
    throw new DomainError('branchPrefix cannot target a protected or base branch', 400);
  }
  return { mode: 'draft_pr', repository, baseBranch, branchPrefix, autoMerge: raw.autoMerge === true, ...(protectedPaths ? { protectedPaths } : {}) };
}

function protectedPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(pattern.endsWith('/') ? `^${escaped}` : `^${escaped}$`);
}

/** The changed paths that an auto-merge must not include (issue #20). */
export function touchedProtectedPaths(changedPaths: readonly string[], protectedPaths: readonly string[]): string[] {
  const patterns = protectedPaths.map(protectedPatternToRegExp);
  return [...new Set(changedPaths.filter((path) => patterns.some((re) => re.test(path))))].sort();
}

/** Old and new paths of every file a unified git diff touches, including renames. */
export function pathsInPatch(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      paths.add(header[1]!);
      paths.add(header[2]!);
      continue;
    }
    const rename = /^rename (?:from|to) (.+)$/.exec(line);
    if (rename) paths.add(rename[1]!);
    const side = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (side) paths.add(side[1]!);
  }
  return [...paths].sort();
}

export function validateBundleManifest(input: unknown, expectedBaseCommit: string): BundleManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid bundle manifest', 400);
  }
  const raw = input as Record<string, unknown>;
  const baseCommit = text(raw.baseCommit, 'bundle baseCommit', 40).toLowerCase();
  if (!HEX40.test(baseCommit) || baseCommit !== expectedBaseCommit.toLowerCase()) {
    throw new DomainError('Bundle baseCommit does not match acceptance baseCommit', 400);
  }
  const bundleSha256 = text(raw.bundleSha256, 'bundleSha256', 64).toLowerCase();
  if (!HEX64.test(bundleSha256)) throw new DomainError('Invalid bundleSha256', 400);
  const sizeBytes = raw.sizeBytes;
  const fileCount = raw.fileCount;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 2_000_000_000) {
    throw new DomainError('Invalid bundle sizeBytes', 400);
  }
  if (typeof fileCount !== 'number' || !Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > 500_000) {
    throw new DomainError('Invalid bundle fileCount', 400);
  }
  const s3Key = raw.s3Key === undefined ? undefined : normalizeRepoRelativePath(String(raw.s3Key));
  return { baseCommit, bundleSha256, sizeBytes, fileCount, ...(s3Key ? { s3Key } : {}) };
}

export function validateSpotPolicy(input: unknown): SpotInterruptionPolicy {
  if (input === undefined) return { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid spot policy', 400);
  }
  const raw = input as Record<string, unknown>;
  const maxSpotRetries = raw.maxSpotRetries;
  const checkpointFlushTimeoutMs = raw.checkpointFlushTimeoutMs;
  if (typeof maxSpotRetries !== 'number' || !Number.isSafeInteger(maxSpotRetries) || maxSpotRetries < 0 || maxSpotRetries > 5) {
    throw new DomainError('Invalid maxSpotRetries (0..5)', 400);
  }
  if (
    typeof checkpointFlushTimeoutMs !== 'number' ||
    !Number.isSafeInteger(checkpointFlushTimeoutMs) ||
    checkpointFlushTimeoutMs < 5_000 ||
    checkpointFlushTimeoutMs > 115_000
  ) {
    throw new DomainError('checkpointFlushTimeoutMs must fit within Fargate Spot 120s SIGTERM window (5000..115000)', 400);
  }
  return { maxSpotRetries, checkpointFlushTimeoutMs };
}

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function validateWorkerExecutionPolicy(input: unknown): WorkerExecutionPolicy {
  if (input === undefined) {
    return {
      allowedWebHosts: [],
      allowSubagents: false,
      maxIterationDurationMs: 600_000,
      preserveWorkspaceOnRetry: false,
      verificationKind: 'code',
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid worker executionPolicy', 400);
  }
  const raw = input as Record<string, unknown>;
  let allowedWebHosts: string[] = [];
  if (raw.allowedWebHosts !== undefined) {
    if (!Array.isArray(raw.allowedWebHosts) || raw.allowedWebHosts.length > 64) {
      throw new DomainError('allowedWebHosts must be an array of up to 64 hostnames', 400);
    }
    const seen = new Set<string>();
    allowedWebHosts = raw.allowedWebHosts.map((entry) => {
      if (typeof entry !== 'string') throw new DomainError('Invalid hostname in allowedWebHosts', 400);
      const host = entry.trim().toLowerCase();
      if (!HOSTNAME_PATTERN.test(host) || host.length > 253) {
        throw new DomainError(`Invalid hostname in allowedWebHosts: ${entry}`, 400);
      }
      if (seen.has(host)) throw new DomainError(`Duplicate hostname in allowedWebHosts: ${host}`, 400);
      seen.add(host);
      return host;
    });
    allowedWebHosts.sort();
  }
  const allowSubagents = raw.allowSubagents === undefined ? false : raw.allowSubagents;
  if (typeof allowSubagents !== 'boolean') {
    throw new DomainError('allowSubagents must be a boolean', 400);
  }
  const maxIterationDurationMs =
    raw.maxIterationDurationMs === undefined ? 600_000 : Number(raw.maxIterationDurationMs);
  if (
    !Number.isSafeInteger(maxIterationDurationMs) ||
    maxIterationDurationMs < 60_000 ||
    maxIterationDurationMs > 7_200_000
  ) {
    throw new DomainError('maxIterationDurationMs must be between 60000 and 7200000 (2 hours)', 400);
  }
  const preserveWorkspaceOnRetry =
    raw.preserveWorkspaceOnRetry === undefined ? false : raw.preserveWorkspaceOnRetry;
  if (typeof preserveWorkspaceOnRetry !== 'boolean') {
    throw new DomainError('preserveWorkspaceOnRetry must be a boolean', 400);
  }
  const verificationKind = raw.verificationKind === undefined ? 'code' : raw.verificationKind;
  if (verificationKind !== 'code' && verificationKind !== 'document_format') {
    throw new DomainError('verificationKind must be code or document_format', 400);
  }
  if (raw.hivemindAgentAccess !== undefined && typeof raw.hivemindAgentAccess !== 'boolean') {
    throw new DomainError('hivemindAgentAccess must be a boolean', 400);
  }
  return {
    allowedWebHosts,
    allowSubagents,
    maxIterationDurationMs,
    preserveWorkspaceOnRetry,
    verificationKind,
    ...(raw.hivemindAgentAccess === true ? { hivemindAgentAccess: true } : {}),
  };
}

export function computeDeliveryApprovalFingerprint(spec: {
  provider: DeliveryProvider;
  maxIterations: number;
  budgetMicros: number;
  acceptance: AcceptanceTestSpec;
  delivery: DeliveryPolicy;
  bundle?: BundleManifest;
  spot: SpotInterruptionPolicy;
  routing?: RegionRoutingPolicy;
  executionPolicy?: WorkerExecutionPolicy;
}): string {
  const isDefaultExec =
    !spec.executionPolicy ||
    ((spec.executionPolicy.allowedWebHosts?.length ?? 0) === 0 &&
      !spec.executionPolicy.allowSubagents &&
      (spec.executionPolicy.maxIterationDurationMs ?? 600_000) === 600_000 &&
      !spec.executionPolicy.preserveWorkspaceOnRetry &&
      !spec.executionPolicy.hivemindAgentAccess &&
      (spec.executionPolicy.verificationKind ?? 'code') === 'code');
  return sha256Hex(
    JSON.stringify({
      version: 1,
      provider: spec.provider,
      maxIterations: spec.maxIterations,
      budgetMicros: spec.budgetMicros,
      acceptanceTestDigest: spec.acceptance.digest,
      baseCommit: spec.acceptance.baseCommit,
      delivery: spec.delivery,
      bundleSha256: spec.bundle?.bundleSha256 ?? null,
      spot: spec.spot,
      ...(spec.routing ? { routing: spec.routing } : {}),
      ...(!isDefaultExec ? { executionPolicy: spec.executionPolicy } : {}),
    }),
  );
}

export function assertPatchDoesNotTouchAcceptancePaths(
  modifiedPaths: string[],
  acceptance: AcceptanceTestSpec,
): { unmodified: true } {
  const protectedPaths = new Set(acceptance.files.map((file) => file.path));
  for (const raw of modifiedPaths) {
    const normalized = normalizeRepoRelativePath(raw);
    if (protectedPaths.has(normalized)) {
      throw new DomainError(`Worker modified pinned acceptance test path: ${normalized}`, 409);
    }
  }
  return { unmodified: true };
}

function validateProvider(value: unknown): DeliveryProvider {
  if (value !== 'codex' && value !== 'claude') {
    throw new DomainError('Only codex and claude providers are supported for AWS SW delivery', 400);
  }
  return value;
}

export class DeliveryStore {
  private readonly repository: DeliveryRepository;
  /** Set only while the synchronous body of a repository transaction runs. */
  private activeTx: DeliveryTxState | null = null;

  /**
   * @param storage A SQLite file path (local default) or any DeliveryRepository, for example the Aurora
   *   DSQL repository on AWS.
   */
  constructor(
    storage: string | DeliveryRepository = ':memory:',
    private now: () => number = Date.now,
    /** Repositories whose tasks may use autoMerge (issue #20). Default: none. */
    private readonly autoMergeRepositories: readonly string[] = [],
  ) {
    this.repository = typeof storage === 'string' ? new SqliteDeliveryRepository(storage) : storage;
  }

  /** True when the task's policy asks for auto-merge and its repository is still allowed. */
  autoMergeAllowed(task: DeliveryTask): boolean {
    return task.delivery.autoMerge === true && this.autoMergeRepositories.includes(task.delivery.repository);
  }

  /** Records the auto-merge outcome. A merge also settles the task as approved, by the policy. */
  async recordAutoMerge(
    id: string,
    outcome: { outcome: 'merged'; mergeCommitSha: string } | { outcome: 'refused'; reason: string; touchedProtectedPaths?: string[] },
  ): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'draft_pr_published' || !task.publication || task.delivery.autoMerge !== true) {
        throw new DomainError(`Cannot record an auto-merge in state ${task.status}`, 409);
      }
      const at = this.timestamp();
      if (outcome.outcome === 'merged') {
        if (!/^[a-f0-9]{40}$/i.test(outcome.mergeCommitSha)) throw new DomainError('Invalid merge commit SHA', 400);
        task.autoMerge = { outcome: 'merged', reason: 'Verifier passed and no protected path changed', mergeCommitSha: outcome.mergeCommitSha.toLowerCase(), at };
        task.humanDecision = { decision: 'approve', openedDiff: false, durationMinutes: 0, reason: 'Auto-merge policy', decidedAt: at };
        task.status = 'approved';
        task.waitReason = null;
      } else {
        task.autoMerge = {
          outcome: 'refused',
          reason: text(outcome.reason, 'reason', 1000),
          ...(outcome.touchedProtectedPaths?.length ? { touchedProtectedPaths: outcome.touchedProtectedPaths.slice(0, 50) } : {}),
          at,
        };
        task.waitReason = 'auto_merge_refused';
      }
      const saved = this.save(task);
      this.emit(saved.id, outcome.outcome === 'merged' ? 'delivery.auto_merged' : 'delivery.auto_merge_refused', {
        ...(outcome.outcome === 'merged' ? { mergeCommitSha: saved.autoMerge!.mergeCommitSha } : { reason: saved.autoMerge!.reason, touchedProtectedPaths: saved.autoMerge!.touchedProtectedPaths ?? [] }),
      });
      return saved;
    });
  }

  get storageBackend(): DeliveryRepository['storageBackend'] {
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

  private txState(): DeliveryTxState {
    if (!this.activeTx) throw new Error('DeliveryStore state accessed outside a repository transaction');
    return this.activeTx;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private load(id: string): DeliveryTask {
    const task = this.txState().docs.get(id);
    if (!task) throw new DomainError('Delivery task not found', 404);
    return structuredClone(task);
  }

  private save(task: DeliveryTask): DeliveryTask {
    task.updatedAt = this.timestamp();
    const state = this.txState();
    state.docs.set(task.id, structuredClone(task));
    state.dirtyIds.add(task.id);
    return structuredClone(task);
  }

  private emit(taskId: string, type: string, data: Record<string, unknown>): void {
    this.txState().newEvents.push({ taskId, type, at: this.timestamp(), data } as DeliveryEventDraft);
  }

  async list(projectId?: string): Promise<DeliveryTask[]> {
    const docs = await this.repository.listDocs();
    return projectId ? docs.filter((t) => (t.projectId ?? DEFAULT_PROJECT_ID) === projectId) : docs;
  }

  async get(id: string): Promise<DeliveryTask> {
    const task = await this.repository.getDoc(id);
    if (!task) throw new DomainError('Delivery task not found', 404);
    return task;
  }

  async events(taskId?: string): Promise<DeliveryEvent[]> {
    return (await this.repository.listEvents(200)).filter((event) => (taskId ? event.taskId === taskId : true));
  }

  async create(
    input: CreateDeliveryTask,
    policyContext: { extraAutoMergeRepositories?: readonly string[]; allowAgentAccess?: boolean } = {},
  ): Promise<DeliveryTask> {
    return this.tx(() => {
      const projectId =
        input.projectId === undefined || input.projectId === DEFAULT_PROJECT_ID
          ? DEFAULT_PROJECT_ID
          : validateProjectId(input.projectId);
      const title = text(input.title, 'title', 160);
      const instructions = text(input.instructions, 'instructions', 12_000);
      const provider = validateProvider(input.provider);
      if (!Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 10) {
        throw new DomainError('Invalid maxIterations (1..10)', 400);
      }
      if (!Number.isSafeInteger(input.budgetMicros) || input.budgetMicros < 0 || input.budgetMicros > 1_000_000_000) {
        throw new DomainError('Invalid budgetMicros', 400);
      }
      const acceptance = validateAcceptanceTestSpec(input.acceptance);
      const delivery = validateDeliveryPolicy(input.delivery);
      const allowedAutoMerge = new Set([
        ...this.autoMergeRepositories,
        ...(policyContext.extraAutoMergeRepositories ?? []),
      ]);
      if (delivery.autoMerge && !allowedAutoMerge.has(delivery.repository)) {
        throw new DomainError('delivery.autoMerge is not allowed for this repository on this Control Plane', 403);
      }
      if (
        (input.executionPolicy as { hivemindAgentAccess?: unknown } | undefined)?.hivemindAgentAccess === true &&
        !allowedAutoMerge.has(delivery.repository) &&
        policyContext.allowAgentAccess !== true
      ) {
        throw new DomainError('executionPolicy.hivemindAgentAccess is not allowed for this repository on this Control Plane', 403);
      }
      const bundle = input.bundle === undefined ? undefined : validateBundleManifest(input.bundle, acceptance.baseCommit);
      const spot = validateSpotPolicy(input.spot);
      const routing = input.routing === undefined ? undefined : validateRegionRoutingPolicy(input.routing);
      const executionPolicy = validateWorkerExecutionPolicy(input.executionPolicy);
      const approvalFingerprint = computeDeliveryApprovalFingerprint({
        provider,
        maxIterations: input.maxIterations,
        budgetMicros: input.budgetMicros,
        acceptance,
        delivery,
        bundle,
        spot,
        routing,
        executionPolicy,
      });
      const at = this.timestamp();
      const task: DeliveryTask = {
        id: `dlv-${randomUUID()}`,
        projectId,
        title,
        instructions,
        provider,
        status: 'awaiting_approval',
        approvalFingerprint,
        maxIterations: input.maxIterations,
        currentIteration: 0,
        budgetMicros: input.budgetMicros,
        acceptance,
        delivery,
        ...(bundle ? { bundle } : {}),
        spot,
        ...(routing ? { routing } : {}),
        executionPolicy,
        activeRegion: null,
        lastPlacement: null,
        waitReason: 'awaiting_operator_approval',
        lastPreflight: null,
        spotRetriesUsed: 0,
        activeRunId: null,
        activeWorkerId: null,
        latestCheckpointRef: null,
        latestWorkerSummary: null,
        spotInterruptions: [],
        attestations: [],
        latestAttestation: null,
        publication: null,
        humanDecision: null,
        createdAt: at,
        updatedAt: at,
        approvedAt: null,
        approvalReason: null,
        cancelReason: null,
        failureReason: null,
      };
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.created', {
        provider,
        repository: delivery.repository,
        baseCommit: acceptance.baseCommit,
        acceptanceTestDigest: acceptance.digest,
        approvalFingerprint,
      });
      return saved;
    });
  }

  async approve(id: string, approvalFingerprint: string, reason: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'awaiting_approval') {
        throw new DomainError(`Cannot approve delivery task in state ${task.status}`, 409);
      }
      const submitted = text(approvalFingerprint, 'approvalFingerprint', 64).toLowerCase();
      if (submitted !== task.approvalFingerprint) {
        throw new DomainError('Approval fingerprint does not match current policy', 409);
      }
      const cleanReason = text(reason, 'reason', 1000);
      task.status = 'queued';
      task.waitReason = 'queued_for_worker_dispatch';
      task.approvedAt = this.timestamp();
      task.approvalReason = cleanReason;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.approved', { approvalFingerprint: submitted, reason: cleanReason });
      return saved;
    });
  }

  async startIteration(id: string, workerId: string, runId: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'queued') {
        throw new DomainError(`Cannot start iteration in state ${task.status}`, 409);
      }
      if (task.currentIteration >= task.maxIterations) {
        throw new DomainError('Iteration limit already reached', 409);
      }
      const cleanWorker = text(workerId, 'workerId', 120);
      const cleanRun = text(runId, 'runId', 120);
      task.currentIteration += 1;
      task.status = 'running';
      task.waitReason = null;
      task.activeWorkerId = cleanWorker;
      task.activeRunId = cleanRun;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.iteration_started', {
        workerId: cleanWorker,
        runId: cleanRun,
        iteration: saved.currentIteration,
        checkpointRef: saved.latestCheckpointRef,
      });
      return saved;
    });
  }

  async recordPlacementDecision(id: string, decision: RegionPlacementDecision): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.routing && !task.routing.allowedRegions.includes(decision.selectedRegion)) {
        throw new DomainError(`Selected region ${decision.selectedRegion} is not in approved allowedRegions`, 409);
      }
      task.activeRegion = decision.selectedRegion;
      task.lastPlacement = structuredClone(decision);
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.region_selected', {
        selectedRegion: decision.selectedRegion,
        selectedAzId: decision.selectedAzId,
        workloadClass: decision.workloadClass,
        latestScore: decision.latestScore,
        latestPriceUsd: decision.latestPriceUsd,
        savingsVsPrimaryPercent: decision.savingsVsPrimaryPercent,
        feedStaleFallback: decision.feedStaleFallback,
      });
      return saved;
    });
  }

  async recordPreflight(id: string, report: Omit<DeliveryPreflightReport, 'checkedAt'>): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== report.runId) {
        throw new DomainError('Active run mismatch for preflight report', 409);
      }
      const checkedAt = this.timestamp();
      const normalized: DeliveryPreflightReport = {
        runId: report.runId,
        ok: Boolean(report.ok),
        cliVersion: report.cliVersion ? text(report.cliVersion, 'cliVersion', 120) : null,
        authReady: Boolean(report.authReady),
        gitReady: Boolean(report.gitReady),
        allowedWebHosts: Array.isArray(report.allowedWebHosts) ? report.allowedWebHosts.slice(0, 64) : [],
        allowSubagents: Boolean(report.allowSubagents),
        reason: report.reason ? text(report.reason, 'preflight reason', 1000) : null,
        checkedAt,
      };
      task.lastPreflight = normalized;
      if (!normalized.ok) {
        task.status = 'failed';
        task.activeRunId = null;
        task.activeWorkerId = null;
        task.waitReason = 'preflight_failed';
        task.failureReason = `Worker preflight failed: ${normalized.reason ?? 'CLI or tool readiness check failed'}`;
      }
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.preflight_recorded', {
        runId: normalized.runId,
        ok: normalized.ok,
        cliVersion: normalized.cliVersion,
        reason: normalized.reason,
      });
      return saved;
    });
  }

  /** Records the model usage of the active run. The worker calls it once per run, whatever the outcome. */
  async recordModelUsage(id: string, input: Omit<DeliveryModelUsage, 'recordedAt'>): Promise<DeliveryTask> {
    const count = (value: unknown, name: string): number | null => {
      if (value === null || value === undefined) return null;
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError(`${name} must be a non-negative integer or null`, 400);
      return value as number;
    };
    if (!['completed', 'failed', 'timed_out', 'aborted'].includes(input.outcome)) throw new DomainError('Invalid usage outcome', 400);
    if (!['codex_session_log', 'unavailable'].includes(input.source)) throw new DomainError('Invalid usage source', 400);
    const iteration = count(input.iteration, 'iteration');
    const durationMs = count(input.durationMs, 'durationMs');
    if (iteration === null || durationMs === null) throw new DomainError('iteration and durationMs are required', 400);
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== input.runId) {
        throw new DomainError('Active run mismatch for model usage', 409);
      }
      const usage: DeliveryModelUsage = {
        runId: input.runId,
        iteration,
        provider: task.provider,
        outcome: input.outcome,
        inputTokens: count(input.inputTokens, 'inputTokens'),
        cachedInputTokens: count(input.cachedInputTokens, 'cachedInputTokens'),
        cacheWriteInputTokens: count(input.cacheWriteInputTokens, 'cacheWriteInputTokens'),
        outputTokens: count(input.outputTokens, 'outputTokens'),
        reasoningOutputTokens: count(input.reasoningOutputTokens, 'reasoningOutputTokens'),
        source: input.source,
        durationMs,
        recordedAt: this.timestamp(),
      };
      task.modelUsage = [...(task.modelUsage ?? []), usage].slice(-100);
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.model_usage_recorded', { ...usage });
      return saved;
    });
  }

  async recordWorkerSummary(id: string, runId: string, summary: string, checkpointRef?: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== runId) {
        throw new DomainError('Active run mismatch for worker summary', 409);
      }
      const cleanSummary = text(summary, 'worker summary', 4000);
      task.latestWorkerSummary = cleanSummary;
      if (checkpointRef?.trim()) {
        task.latestCheckpointRef = normalizeRepoRelativePath(checkpointRef);
      }
      task.waitReason = 'awaiting_independent_verification';
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.worker_summary_recorded', {
        runId,
        iteration: saved.currentIteration,
        summaryLength: cleanSummary.length,
        ...(saved.latestCheckpointRef ? { checkpointRef: saved.latestCheckpointRef } : {}),
      });
      return saved;
    });
  }

  async recordSpotInterruption(id: string, runId: string, checkpointRef: string, reason: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== runId) {
        throw new DomainError('Active run mismatch for Spot interruption', 409);
      }
      const cleanRef = normalizeRepoRelativePath(checkpointRef);
      const cleanReason = text(reason, 'reason', 500);
      const at = this.timestamp();
      task.spotInterruptions.push({
        runId,
        iteration: task.currentIteration,
        checkpointRef: cleanRef,
        reason: cleanReason,
        at,
      });
      task.latestCheckpointRef = cleanRef;
      task.activeRunId = null;
      task.activeWorkerId = null;
      if (task.spotRetriesUsed < task.spot.maxSpotRetries) {
        task.spotRetriesUsed += 1;
        // Rewind iteration counter because the interrupted attempt did not finish verification.
        task.currentIteration = Math.max(0, task.currentIteration - 1);
        task.status = 'queued';
        task.waitReason = 'spot_interrupted_requeued';
      } else {
        task.status = 'failed';
        task.waitReason = null;
        task.failureReason = `Spot retry limit (${task.spot.maxSpotRetries}) exceeded: ${cleanReason}`;
      }
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.spot_interrupted', {
        runId,
        checkpointRef: cleanRef,
        spotRetriesUsed: saved.spotRetriesUsed,
        nextStatus: saved.status,
      });
      return saved;
    });
  }

  async recordVerification(id: string, attestation: VerificationAttestation): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== attestation.runId) {
        throw new DomainError('Verification must match the active running iteration', 409);
      }
      if (attestation.iteration !== task.currentIteration) {
        throw new DomainError('Verification iteration mismatch', 409);
      }
      if (attestation.baseCommit.toLowerCase() !== task.acceptance.baseCommit) {
        throw new DomainError('Verification baseCommit mismatch', 409);
      }
      if (attestation.acceptanceTestDigest.toLowerCase() !== task.acceptance.digest) {
        throw new DomainError('Verification acceptanceTestDigest mismatch', 409);
      }
      if (!HEX40.test(attestation.verifiedTreeHash.toLowerCase())) {
        throw new DomainError('Invalid verifiedTreeHash', 400);
      }
      if (!HEX64.test(attestation.patchSha256.toLowerCase())) {
        throw new DomainError('Invalid patchSha256', 400);
      }
      const normalized: VerificationAttestation = {
        ...attestation,
        baseCommit: attestation.baseCommit.toLowerCase(),
        acceptanceTestDigest: attestation.acceptanceTestDigest.toLowerCase(),
        verifiedTreeHash: attestation.verifiedTreeHash.toLowerCase(),
        patchSha256: attestation.patchSha256.toLowerCase(),
        summary: text(attestation.summary, 'verification summary', 4000),
      };
      task.attestations.push(normalized);
      task.latestAttestation = normalized;
      task.activeRunId = null;
      task.activeWorkerId = null;

      if (!normalized.acceptancePathsUnmodified) {
        task.status = 'failed';
        task.waitReason = null;
        task.failureReason = 'Worker attempted to modify pinned acceptance test files';
      } else if (normalized.checksPassed) {
        task.status = 'verified';
        task.waitReason = 'awaiting_draft_pr_publication';
      } else if (task.currentIteration < task.maxIterations) {
        // Failed verification feeds back into the next Ralph loop iteration.
        task.status = 'queued';
        task.waitReason = 'queued_for_next_iteration';
      } else {
        task.status = 'failed';
        task.waitReason = null;
        task.failureReason = `Verification failed after ${task.maxIterations} iteration(s)`;
      }
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.verified', {
        runId: normalized.runId,
        iteration: normalized.iteration,
        checksPassed: normalized.checksPassed,
        acceptancePathsUnmodified: normalized.acceptancePathsUnmodified,
        verifiedTreeHash: normalized.verifiedTreeHash,
        nextStatus: saved.status,
      });
      return saved;
    });
  }

  async recordDraftPrPublication(id: string, publication: DraftPrPublication): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'verified' || !task.latestAttestation) {
        throw new DomainError(`Cannot publish Draft PR in state ${task.status}`, 409);
      }
      const attestation = task.latestAttestation;
      if (!attestation.checksPassed || !attestation.acceptancePathsUnmodified) {
        throw new DomainError('Cannot publish Draft PR without passing unmodified acceptance verification', 409);
      }
      const branchName = validateGitRefPart(publication.branchName, 'branchName', false);
      if (
        PROTECTED_BRANCHES.has(branchName) ||
        branchName === task.delivery.baseBranch ||
        !branchName.startsWith(task.delivery.branchPrefix)
      ) {
        throw new DomainError('Draft PR branch violates isolated branchPrefix policy', 409);
      }
      const commitSha = text(publication.commitSha, 'commitSha', 40).toLowerCase();
      const prTreeHash = text(publication.prTreeHash, 'prTreeHash', 40).toLowerCase();
      const verifiedTreeHash = text(publication.verifiedTreeHash, 'verifiedTreeHash', 40).toLowerCase();
      const acceptanceTestDigest = text(publication.acceptanceTestDigest, 'acceptanceTestDigest', 64).toLowerCase();
      const patchSha256 = text(publication.patchSha256, 'patchSha256', 64).toLowerCase();
      if (!HEX40.test(commitSha) || !HEX40.test(prTreeHash) || !HEX40.test(verifiedTreeHash)) {
        throw new DomainError('Invalid Git SHA in Draft PR publication', 400);
      }
      if (prTreeHash !== attestation.verifiedTreeHash || verifiedTreeHash !== attestation.verifiedTreeHash) {
        throw new DomainError('Draft PR tree hash does not match verifiedTreeHash', 409);
      }
      if (acceptanceTestDigest !== task.acceptance.digest || patchSha256 !== attestation.patchSha256) {
        throw new DomainError('Draft PR attestation digest mismatch', 409);
      }
      if (!Number.isSafeInteger(publication.prNumber) || publication.prNumber < 1) {
        throw new DomainError('Invalid Draft PR number', 400);
      }
      const prUrl = text(publication.prUrl, 'prUrl', 512);
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(prUrl)) {
        throw new DomainError('Invalid GitHub Draft PR URL', 400);
      }
      let changeSummary: DeliveryChangeSummary | undefined;
      if (publication.changeSummary !== undefined) {
        const rawSummary = publication.changeSummary;
        if (!rawSummary || typeof rawSummary !== 'object' || Array.isArray(rawSummary) || !Array.isArray(rawSummary.files) || rawSummary.files.length > 500) {
          throw new DomainError('Invalid Draft PR changeSummary', 400);
        }
        const files: ChangedFileStat[] = rawSummary.files.map((entry) => {
          const path = normalizeRepoRelativePath(String(entry.path ?? ''));
          const binary = Boolean(entry.binary);
          const insertions =
            entry.insertions === null
              ? null
              : typeof entry.insertions === 'number' && Number.isSafeInteger(entry.insertions) && entry.insertions >= 0
                ? entry.insertions
                : (() => {
                    throw new DomainError('Invalid changeSummary insertions', 400);
                  })();
          const deletions =
            entry.deletions === null
              ? null
              : typeof entry.deletions === 'number' && Number.isSafeInteger(entry.deletions) && entry.deletions >= 0
                ? entry.deletions
                : (() => {
                    throw new DomainError('Invalid changeSummary deletions', 400);
                  })();
          return { path, insertions, deletions, binary };
        });
        if (
          !Number.isSafeInteger(rawSummary.totalFiles) ||
          rawSummary.totalFiles < 0 ||
          !Number.isSafeInteger(rawSummary.totalInsertions) ||
          rawSummary.totalInsertions < 0 ||
          !Number.isSafeInteger(rawSummary.totalDeletions) ||
          rawSummary.totalDeletions < 0
        ) {
          throw new DomainError('Invalid changeSummary totals', 400);
        }
        changeSummary = {
          files,
          totalFiles: rawSummary.totalFiles,
          totalInsertions: rawSummary.totalInsertions,
          totalDeletions: rawSummary.totalDeletions,
          workerSummary: rawSummary.workerSummary?.trim() ? text(rawSummary.workerSummary, 'workerSummary', 4000) : '',
        };
      }
      task.publication = {
        branchName,
        commitSha,
        prTreeHash,
        prNumber: publication.prNumber,
        prUrl,
        verifiedTreeHash,
        acceptanceTestDigest,
        patchSha256,
        ...(changeSummary ? { changeSummary } : {}),
        publishedAt: text(publication.publishedAt, 'publishedAt', 64),
      };
      task.status = 'draft_pr_published';
      task.waitReason = 'awaiting_human_review';
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.draft_pr_published', {
        branchName,
        prNumber: publication.prNumber,
        prTreeHash,
        verifiedTreeHash,
      });
      return saved;
    });
  }

  async recordHumanDecision(
    id: string,
    input: Omit<HumanDeliveryDecision, 'decidedAt'>,
  ): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'draft_pr_published' || !task.publication) {
        throw new DomainError(`Cannot record human delivery decision in state ${task.status}`, 409);
      }
      if (input.decision !== 'approve' && input.decision !== 'reject') {
        throw new DomainError('Decision must be approve or reject', 400);
      }
      if (typeof input.openedDiff !== 'boolean') {
        throw new DomainError('openedDiff boolean is required for no-diff-review evaluation', 400);
      }
      if (typeof input.durationMinutes !== 'number' || !Number.isFinite(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 10_080) {
        throw new DomainError('Invalid durationMinutes', 400);
      }
      const reason = text(input.reason, 'reason', 2000);
      const missingEvidence =
        input.missingEvidence === undefined ? undefined : text(input.missingEvidence, 'missingEvidence', 2000);
      const decidedAt = this.timestamp();
      task.humanDecision = {
        decision: input.decision,
        openedDiff: input.openedDiff,
        durationMinutes: input.durationMinutes,
        reason,
        ...(missingEvidence ? { missingEvidence } : {}),
        decidedAt,
      };
      task.status = input.decision === 'approve' ? 'approved' : 'rejected';
      task.waitReason = null;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.human_decided', {
        decision: input.decision,
        openedDiff: input.openedDiff,
        durationMinutes: input.durationMinutes,
      });
      return saved;
    });
  }

  /** Remembers which ECS task executes the active run, so a vanished worker or verifier can be detected. */
  async recordActiveEcsTask(id: string, runId: string, ecsTaskArn: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== runId) return task;
      task.activeEcsTaskArn = text(ecsTaskArn, 'ecsTaskArn', 512);
      return this.save(task);
    });
  }

  /**
   * Fails a `running` task whose worker or verifier stopped or disappeared without reporting. It changes
   * nothing unless the task still runs the given `runId`, so it cannot overwrite a result that arrived in
   * the meantime or a newer run.
   */
  async failOrphanedRun(id: string, runId: string, reason: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== runId) return task;
      const cleanReason = text(reason, 'reason', 1000);
      task.status = 'failed';
      task.waitReason = null;
      task.failureReason = cleanReason;
      task.activeRunId = null;
      task.activeWorkerId = null;
      task.activeEcsTaskArn = null;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.orphaned_run_failed', { runId, reason: cleanReason });
      return saved;
    });
  }

  async cancel(id: string, reason: string): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new DomainError(`Cannot cancel delivery task in terminal state ${task.status}`, 409);
      }
      const cleanReason = text(reason, 'reason', 1000);
      task.status = 'cancelled';
      task.waitReason = null;
      task.cancelReason = cleanReason;
      task.activeRunId = null;
      task.activeWorkerId = null;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.cancelled', { reason: cleanReason });
      return saved;
    });
  }

  /** Appends an immutable approval policy evaluation or operator decision record to the delivery task. */
  async recordApprovalDecision(id: string, record: ApprovalDecisionRecord): Promise<DeliveryTask> {
    return this.tx(() => {
      const task = this.load(id);
      const list = Array.isArray(task.approvalDecisions) ? [...task.approvalDecisions] : [];
      list.push(structuredClone(record));
      task.approvalDecisions = list.slice(-50);
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.approval_evaluated', {
        decisionId: record.id,
        gate: record.gate,
        outcome: record.outcome,
        actorKind: record.actorKind,
        policyVersion: record.policyVersion,
        policyMode: record.policyMode,
        summary: record.summary,
      });
      return saved;
    });
  }
}
