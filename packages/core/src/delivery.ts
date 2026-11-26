import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AcceptanceTestFile,
  AcceptanceTestSpec,
  BundleManifest,
  ChangedFileStat,
  CreateDeliveryTask,
  DeliveryChangeSummary,
  DeliveryEvent,
  DeliveryPolicy,
  DeliveryProvider,
  DeliveryTask,
  DraftPrPublication,
  HumanDeliveryDecision,
  SpotInterruptionPolicy,
  VerificationAttestation,
} from '../../contracts/src/delivery.js';
import type { RegionPlacementDecision, RegionRoutingPolicy } from '../../contracts/src/multi-region.js';
import { validateRegionRoutingPolicy } from './multi-region.js';
import { DomainError, text } from './store.js';

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
  if (raw.autoMerge !== false) throw new DomainError('Automatic merge to base branch is forbidden', 400);
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
  return { mode: 'draft_pr', repository, baseBranch, branchPrefix, autoMerge: false };
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

export function computeDeliveryApprovalFingerprint(spec: {
  provider: DeliveryProvider;
  maxIterations: number;
  budgetMicros: number;
  acceptance: AcceptanceTestSpec;
  delivery: DeliveryPolicy;
  bundle?: BundleManifest;
  spot: SpotInterruptionPolicy;
  routing?: RegionRoutingPolicy;
}): string {
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
  private db: DatabaseSync;

  constructor(path = ':memory:', private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS delivery_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private load(id: string): DeliveryTask {
    const row = this.db.prepare('SELECT data FROM delivery_tasks WHERE id=?').get(id);
    if (!row) throw new DomainError('Delivery task not found', 404);
    return JSON.parse(row.data as string) as DeliveryTask;
  }

  private save(task: DeliveryTask): DeliveryTask {
    task.updatedAt = this.timestamp();
    this.db.prepare('INSERT OR REPLACE INTO delivery_tasks (id, data) VALUES (?, ?)').run(task.id, JSON.stringify(task));
    return structuredClone(task);
  }

  private emit(taskId: string, type: string, data: Record<string, unknown>): void {
    const entry = { taskId, type, at: this.timestamp(), data };
    this.db.prepare('INSERT INTO delivery_events (data) VALUES (?)').run(JSON.stringify(entry));
  }

  list(): DeliveryTask[] {
    return this.db
      .prepare('SELECT data FROM delivery_tasks ORDER BY rowid DESC')
      .all()
      .map((row) => structuredClone(JSON.parse(row.data as string) as DeliveryTask));
  }

  get(id: string): DeliveryTask {
    return structuredClone(this.load(id));
  }

  events(taskId?: string): DeliveryEvent[] {
    return this.db
      .prepare('SELECT sequence, data FROM delivery_events ORDER BY sequence DESC LIMIT 200')
      .all()
      .map((row) => ({ sequence: row.sequence as number, ...(JSON.parse(row.data as string) as Omit<DeliveryEvent, 'sequence'>) }))
      .filter((event) => (taskId ? event.taskId === taskId : true));
  }

  create(input: CreateDeliveryTask): DeliveryTask {
    return this.tx(() => {
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
      const bundle = input.bundle === undefined ? undefined : validateBundleManifest(input.bundle, acceptance.baseCommit);
      const spot = validateSpotPolicy(input.spot);
      const routing = input.routing === undefined ? undefined : validateRegionRoutingPolicy(input.routing);
      const approvalFingerprint = computeDeliveryApprovalFingerprint({
        provider,
        maxIterations: input.maxIterations,
        budgetMicros: input.budgetMicros,
        acceptance,
        delivery,
        bundle,
        spot,
        routing,
      });
      const at = this.timestamp();
      const task: DeliveryTask = {
        id: `dlv-${randomUUID()}`,
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
        activeRegion: null,
        lastPlacement: null,
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

  approve(id: string, approvalFingerprint: string, reason: string): DeliveryTask {
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
      task.approvedAt = this.timestamp();
      task.approvalReason = cleanReason;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.approved', { approvalFingerprint: submitted, reason: cleanReason });
      return saved;
    });
  }

  startIteration(id: string, workerId: string, runId: string): DeliveryTask {
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

  recordPlacementDecision(id: string, decision: RegionPlacementDecision): DeliveryTask {
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

  recordWorkerSummary(id: string, runId: string, summary: string): DeliveryTask {
    return this.tx(() => {
      const task = this.load(id);
      if (task.status !== 'running' || task.activeRunId !== runId) {
        throw new DomainError('Active run mismatch for worker summary', 409);
      }
      const cleanSummary = text(summary, 'worker summary', 4000);
      task.latestWorkerSummary = cleanSummary;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.worker_summary_recorded', {
        runId,
        iteration: saved.currentIteration,
        summaryLength: cleanSummary.length,
      });
      return saved;
    });
  }

  recordSpotInterruption(id: string, runId: string, checkpointRef: string, reason: string): DeliveryTask {
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
      } else {
        task.status = 'failed';
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

  recordVerification(id: string, attestation: VerificationAttestation): DeliveryTask {
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
        task.failureReason = 'Worker attempted to modify pinned acceptance test files';
      } else if (normalized.checksPassed) {
        task.status = 'verified';
      } else if (task.currentIteration < task.maxIterations) {
        // Failed verification feeds back into the next Ralph loop iteration.
        task.status = 'queued';
      } else {
        task.status = 'failed';
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

  recordDraftPrPublication(id: string, publication: DraftPrPublication): DeliveryTask {
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

  recordHumanDecision(
    id: string,
    input: Omit<HumanDeliveryDecision, 'decidedAt'>,
  ): DeliveryTask {
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
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.human_decided', {
        decision: input.decision,
        openedDiff: input.openedDiff,
        durationMinutes: input.durationMinutes,
      });
      return saved;
    });
  }

  cancel(id: string, reason: string): DeliveryTask {
    return this.tx(() => {
      const task = this.load(id);
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new DomainError(`Cannot cancel delivery task in terminal state ${task.status}`, 409);
      }
      const cleanReason = text(reason, 'reason', 1000);
      task.status = 'cancelled';
      task.cancelReason = cleanReason;
      task.activeRunId = null;
      task.activeWorkerId = null;
      const saved = this.save(task);
      this.emit(saved.id, 'delivery.cancelled', { reason: cleanReason });
      return saved;
    });
  }
}
