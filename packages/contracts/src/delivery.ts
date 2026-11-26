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
  autoMerge: false;
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
  activeRegion: string | null;
  lastPlacement: RegionPlacementDecision | null;
  spotRetriesUsed: number;
  activeRunId: string | null;
  activeWorkerId: string | null;
  latestCheckpointRef: string | null;
  latestWorkerSummary: string | null;
  spotInterruptions: SpotInterruptionRecord[];
  attestations: VerificationAttestation[];
  latestAttestation: VerificationAttestation | null;
  publication: DraftPrPublication | null;
  humanDecision: HumanDeliveryDecision | null;
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
