import type { RegionPlacementDecision, RegionRoutingPolicy } from './multi-region.js';

export type DeliveryProvider = 'codex' | 'claude';

export interface AcceptanceTestFile {
  path: string;
  sha256: string;
}

export interface AcceptanceTestSpec {
  baseCommit: string;
  files: AcceptanceTestFile[];
  testCommand: string[];
  digest: string;
}

export interface DeliveryPolicy {
  mode: 'draft_pr';
  repository: string;
  baseBranch: string;
  branchPrefix: string;
  /**
   * true: once the verifier passed and the Draft PR is open, the Control Plane merges it into baseBranch
   * unless the change touches `protectedPaths` (issue #20). Allowed only for operator-listed repositories.
   */
  autoMerge: boolean;
  /** Paths an auto-merged change may not touch: `dir/` prefixes, exact files, or one `*` per segment. */
  protectedPaths?: string[];
}

export interface BundleManifest {
  baseCommit: string;
  bundleSha256: string;
  sizeBytes: number;
  fileCount: number;
  s3Key?: string;
}

export interface SpotInterruptionPolicy {
  maxSpotRetries: number;
  checkpointFlushTimeoutMs: number;
}

export type VerificationKind = 'code' | 'document_format';

export interface WorkerExecutionPolicy {
  /** Explicit allowlist of read-only web hosts the research/coding worker may fetch (e.g. huggingface.co, arxiv.org). */
  allowedWebHosts?: string[];
  /** Allows the primary worker session to invoke subagents (e.g. Claude Agent tool with a secondary model). */
  allowSubagents?: boolean;
  /** Maximum duration for a single worker iteration in milliseconds (60_000..7_200_000; default 600_000). */
  maxIterationDurationMs?: number;
  /** Preserves workspace edits across retries and Spot interruptions via S3 checkpoint patches. */
  preserveWorkspaceOnRetry?: boolean;
  /** Declares whether independent verification tests executable code or document structure/format only. */
  verificationKind?: VerificationKind;
}

export interface DeliveryPreflightReport {
  runId: string;
  ok: boolean;
  cliVersion: string | null;
  authReady: boolean;
  gitReady: boolean;
  allowedWebHosts: string[];
  allowSubagents: boolean;
  reason: string | null;
  checkedAt: string;
}

export interface CreateDeliveryTask {
  title: string;
  instructions: string;
  provider: DeliveryProvider;
  maxIterations: number;
  budgetMicros: number;
  acceptance: AcceptanceTestSpec;
  delivery: DeliveryPolicy;
  bundle?: BundleManifest;
  spot?: SpotInterruptionPolicy;
  routing?: RegionRoutingPolicy;
  executionPolicy?: WorkerExecutionPolicy;
}

export interface VerificationAttestation {
  runId: string;
  iteration: number;
  baseCommit: string;
  acceptanceTestDigest: string;
  verifiedTreeHash: string;
  patchSha256: string;
  checksPassed: boolean;
  acceptancePathsUnmodified: boolean;
  durationMs: number;
  exitCode: number | null;
  summary: string;
  verifiedAt: string;
}

export interface ChangedFileStat {
  path: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface DeliveryChangeSummary {
  files: ChangedFileStat[];
  totalFiles: number;
  totalInsertions: number;
  totalDeletions: number;
  workerSummary: string;
}

export interface DraftPrPublication {
  branchName: string;
  commitSha: string;
  prTreeHash: string;
  prNumber: number;
  prUrl: string;
  verifiedTreeHash: string;
  acceptanceTestDigest: string;
  patchSha256: string;
  changeSummary?: DeliveryChangeSummary;
  publishedAt: string;
}

export interface HumanDeliveryDecision {
  decision: 'approve' | 'reject';
  openedDiff: boolean;
  durationMinutes: number;
  reason: string;
  missingEvidence?: string;
  decidedAt: string;
}

export interface SpotInterruptionRecord {
  runId: string;
  iteration: number;
  checkpointRef: string;
  reason: string;
  at: string;
}

export type DeliveryTaskStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'verified'
  | 'draft_pr_published'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface DeliveryTask {
  id: string;
  title: string;
  instructions: string;
  provider: DeliveryProvider;
  status: DeliveryTaskStatus;
  approvalFingerprint: string;
  maxIterations: number;
  currentIteration: number;
  budgetMicros: number;
  acceptance: AcceptanceTestSpec;
  delivery: DeliveryPolicy;
  bundle?: BundleManifest;
  spot: SpotInterruptionPolicy;
  routing?: RegionRoutingPolicy;
  executionPolicy: WorkerExecutionPolicy;
  activeRegion: string | null;
  lastPlacement: RegionPlacementDecision | null;
  waitReason: string | null;
  lastPreflight: DeliveryPreflightReport | null;
  spotRetriesUsed: number;
  activeRunId: string | null;
  activeWorkerId: string | null;
  /** ECS task (worker or verifier) currently executing `activeRunId`. Absent on tasks created before this field. */
  activeEcsTaskArn?: string | null;
  latestCheckpointRef: string | null;
  latestWorkerSummary: string | null;
  spotInterruptions: SpotInterruptionRecord[];
  attestations: VerificationAttestation[];
  latestAttestation: VerificationAttestation | null;
  publication: DraftPrPublication | null;
  humanDecision: HumanDeliveryDecision | null;
  /** Outcome of the auto-merge policy, when the policy asked for it. */
  autoMerge?: { outcome: 'merged' | 'refused'; reason: string; mergeCommitSha?: string; touchedProtectedPaths?: string[]; at: string } | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvalReason: string | null;
  cancelReason: string | null;
  failureReason: string | null;
}

export interface DeliveryEvent {
  sequence: number;
  taskId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
