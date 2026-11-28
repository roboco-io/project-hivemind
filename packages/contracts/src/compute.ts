import type { ApprovalDecisionRecord } from './approval-policy.js';

export const COMPUTE_WORKLOAD_KINDS = ['batch', 'training', 'data_build', 'evaluation', 'custom'] as const;
export type ComputeWorkloadKind = (typeof COMPUTE_WORKLOAD_KINDS)[number];

export type ComputeJobStatus =
  | 'awaiting_launch_approval'
  | 'queued'
  | 'running'
  | 'evaluating'
  | 'awaiting_release_approval'
  | 'release_approved'
  | 'released'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ComputeWaitReason =
  | 'awaiting_launch_approval'
  | 'running_in_progress'
  | 'awaiting_cost_settlement'
  | 'awaiting_release_approval'
  | 'credential_busy'
  | 'spot_capacity_retry'
  | null;

export interface ComputeInputFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ComputeInputSpec {
  s3Prefix: string;
  files: ComputeInputFile[];
  digest: string;
}

export interface RegionComputeOverride {
  amiId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
}

export interface ComputeSpec {
  region: string;
  candidateRegions?: string[];
  regionOverrides?: Record<string, RegionComputeOverride>;
  availabilityZoneId?: string;
  instanceType: string;
  amiId: string;
  maxLifetimeMs: number;
  maxHourlyPriceUsd: number;
  maxTotalCostMicros: number;
  workloadClass?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  instanceProfileArn?: string;
  userDataScript?: string;
  /** Root volume size in GiB. Omitted: the AMI's own size. */
  rootVolumeGb?: number;
  s3ArtifactPrefix: string;
  inputs?: ComputeInputSpec;
}

/**
 * Spot Placement Score summary of one region or AZ: the feed samples in the trend window plus the live score.
 * Scores are 1 (low) to 10 (high).
 */
export interface PlacementScoreTrend {
  latest: number;
  min: number;
  avg: number;
  /** Recent half average minus earlier half average. */
  slope: number;
  samples: number;
}

export interface PlannedPlacementRegion {
  region: string;
  /** Null when the feed has no score for this region. */
  trend: PlacementScoreTrend | null;
  /** Latest regional Spot price for the feed pool, USD per hour. Null when unknown. */
  priceUsd: number | null;
  /** AZ IDs (for example `use2-az1`) in try order, most stable first. AZ IDs are the same in every account. */
  azs: { azId: string; trend: PlacementScoreTrend }[];
}

/**
 * The order in which the Control Plane tries regions and AZs, ranked by Spot Placement Score stability.
 * It only reorders the regions the job already lists; it never adds or removes one.
 */
export interface ComputePlacementPlan {
  status: 'ranked' | 'feed_unavailable' | 'feed_stale' | 'type_not_in_feed';
  /** Human-readable reason, in English, for the order. */
  note: string;
  feedUrl: string | null;
  feedGeneratedAt: string | null;
  /** Feed pool whose scores were used (for example `g6e.12xlarge` or `m.xlarge`). */
  feedPool: string | null;
  /** Instance types the feed pool covers. */
  feedPoolMembers: string[];
  /** When live EC2 GetSpotPlacementScores results were added as the newest sample. Null when none were. */
  liveScoredAt: string | null;
  trendWindowHours: number;
  regions: PlannedPlacementRegion[];
  plannedAt: string;
}

export interface ComputeArtifactFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ComputeArtifactReceipt {
  version: 1;
  jobId: string;
  s3Bucket: string;
  s3Prefix: string;
  manifestDigest: string;
  files: ComputeArtifactFile[];
  recordedAt: string;
}

export interface ComputeReleasePolicy {
  mode: 'hf_release' | 's3_artifact_only';
  hfRepository?: string;
  hfRevision?: string;
  visibility: 'private' | 'public';
  releaseCheckCommand: string[];
  /**
   * Publish without an operator approval once the independent verifier passed the release check.
   * Allowed only for repositories under the host/project's auto-publish prefixes.
   */
  autoPublish?: true;
}

export type ComputeReleaseAttestationSource = 'independent_verifier' | 'operator_self_reported';

export interface ComputeReleaseAttestation {
  manifestDigest: string;
  releaseCheckPassed: boolean;
  metrics: Record<string, number | string | boolean>;
  summary: string;
  verifiedAt: string;
  attestationSource: ComputeReleaseAttestationSource;
  verificationDisclaimer: string | null;
}

export type SubmitComputeReleaseAttestation = Omit<
  ComputeReleaseAttestation,
  'attestationSource' | 'verificationDisclaimer'
>;

export interface ComputeReleaseDecision {
  decision: 'approve' | 'reject';
  openedRawArtifacts: boolean;
  durationMinutes: number;
  reason: string;
  decidedAt: string;
}

export interface ComputeReleasePublication {
  mode: 'hf_release' | 's3_artifact_only';
  repository?: string;
  revision?: string;
  commitSha?: string;
  url?: string;
  manifestDigest: string;
  publishedAt: string;
  /** Files whose hash Hugging Face reported back equal to the receipt after the commit. */
  verifiedFiles?: number;
  /** Who approved the release: an operator, or the auto-publish policy after the independent verifier. */
  approvedBy?: 'operator' | 'auto_publish_policy';
}

export interface ComputeCostRecord {
  reservedMicros: number;
  settledMicros: number | null;
  hourlyRateUsd: number;
  instanceSeconds: number | null;
  settledAt: string | null;
}

export type Ec2InstanceLifecycleState =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'shutting-down'
  | 'terminated'
  | 'unknown';

export interface ComputeInstanceState {
  region: string;
  availabilityZone: string | null;
  instanceId: string;
  instanceType: string;
  amiId: string;
  launchedAt: string;
  expiresAt: string;
  state: Ec2InstanceLifecycleState;
  terminatedAt: string | null;
  forcedTerminationReason: string | null;
}

export interface ComputeJob {
  id: string;
  projectId: string;
  title: string;
  workloadId: string;
  workloadKind: ComputeWorkloadKind;
  repository: string;
  baseCommit: string;
  status: ComputeJobStatus;
  waitReason: ComputeWaitReason;
  diagnostics: string[];
  approvalFingerprint: string;
  compute: ComputeSpec;
  releasePolicy: ComputeReleasePolicy;
  cost: ComputeCostRecord;
  instance: ComputeInstanceState | null;
  nextWakeAt: string | null;
  receipt: ComputeArtifactReceipt | null;
  releaseAttestation: ComputeReleaseAttestation | null;
  /** Last independent verifier task the Control Plane started for this job. Absent when none was started. */
  releaseVerifier?: { ecsTaskArn: string; dispatchedAt: string } | null;
  /** Last region and AZ order planned from the Spot Placement Score feed, at registration and again at launch. */
  placementPlan?: ComputePlacementPlan | null;
  releaseDecision: ComputeReleaseDecision | null;
  publication: ComputeReleasePublication | null;
  /** Chronological audit trail of approval policy evaluations and operator decisions for this job. */
  approvalDecisions?: ApprovalDecisionRecord[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvalReason: string | null;
  cancelReason: string | null;
  failureReason: string | null;
}

export interface CreateComputeJob {
  projectId?: string;
  title: string;
  workloadId: string;
  workloadKind?: ComputeWorkloadKind;
  repository: string;
  baseCommit: string;
  compute: Omit<ComputeSpec, 'inputs'> & {
    inputs?: Omit<ComputeInputSpec, 'digest'> & { digest?: string };
  };
  releasePolicy: ComputeReleasePolicy;
}

export interface ComputeLedgerEntry {
  jobId: string;
  projectId: string;
  workloadId: string;
  workloadKind: ComputeWorkloadKind;
  status: ComputeJobStatus;
  region: string;
  instanceType: string;
  reservedMicros: number;
  settledMicros: number | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ProjectComputeLedgerSummary {
  projectId: string;
  budgetCapMicros: number | null;
  totalReservedMicros: number;
  totalSettledMicros: number;
  remainingBudgetMicros: number;
  activeReservations: number;
  settledJobs: number;
}

export interface ComputeLedgerSummary {
  globalBudgetCapMicros: number;
  totalReservedMicros: number;
  totalSettledMicros: number;
  remainingBudgetMicros: number;
  activeReservations: number;
  settledJobs: number;
  byProject: Record<string, ProjectComputeLedgerSummary>;
  jobs: ComputeLedgerEntry[];
}

export interface ComputeEvent {
  sequence: number;
  jobId: string;
  projectId?: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
