export type ModelFactoryJobStatus =
  | 'awaiting_training_approval'
  | 'training_queued'
  | 'training_running'
  | 'evaluating'
  | 'awaiting_release_approval'
  | 'release_approved'
  | 'released'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type ModelFactoryWaitReason =
  | 'awaiting_training_approval'
  | 'training_in_progress'
  | 'awaiting_cost_settlement'
  | 'awaiting_release_approval'
  | 'credential_busy'
  | 'spot_capacity_retry'
  | null;

export interface ModelTrainingInputFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ModelTrainingInputSpec {
  s3Prefix: string;
  files: ModelTrainingInputFile[];
  digest: string;
}

export interface RegionComputeOverride {
  amiId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
}

export interface TrainingComputeSpec {
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
  inputs?: ModelTrainingInputSpec;
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
export interface TrainingPlacementPlan {
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

export interface ModelArtifactFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ModelArtifactReceipt {
  version: 1;
  jobId: string;
  s3Bucket: string;
  s3Prefix: string;
  manifestDigest: string;
  files: ModelArtifactFile[];
  recordedAt: string;
}

export interface ModelReleasePolicy {
  mode: 'hf_release' | 's3_artifact_only';
  hfRepository?: string;
  hfRevision?: string;
  visibility: 'private' | 'public';
  releaseCheckCommand: string[];
}

export type ModelReleaseAttestationSource = 'independent_verifier' | 'operator_self_reported';

export interface ModelReleaseAttestation {
  manifestDigest: string;
  releaseCheckPassed: boolean;
  metrics: Record<string, number | string | boolean>;
  summary: string;
  verifiedAt: string;
  attestationSource: ModelReleaseAttestationSource;
  verificationDisclaimer: string | null;
}

export type SubmitModelReleaseAttestation = Omit<
  ModelReleaseAttestation,
  'attestationSource' | 'verificationDisclaimer'
>;

export interface ModelReleaseDecision {
  decision: 'approve' | 'reject';
  openedRawArtifacts: boolean;
  durationMinutes: number;
  reason: string;
  decidedAt: string;
}

export interface ModelReleasePublication {
  mode: 'hf_release' | 's3_artifact_only';
  repository?: string;
  revision?: string;
  commitSha?: string;
  url?: string;
  manifestDigest: string;
  publishedAt: string;
}

export interface ModelFactoryCostRecord {
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

export interface ModelFactoryInstanceState {
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

export interface ModelFactoryJob {
  id: string;
  title: string;
  modelId: string;
  repository: string;
  baseCommit: string;
  status: ModelFactoryJobStatus;
  waitReason: ModelFactoryWaitReason;
  diagnostics: string[];
  approvalFingerprint: string;
  compute: TrainingComputeSpec;
  releasePolicy: ModelReleasePolicy;
  cost: ModelFactoryCostRecord;
  instance: ModelFactoryInstanceState | null;
  nextWakeAt: string | null;
  receipt: ModelArtifactReceipt | null;
  releaseAttestation: ModelReleaseAttestation | null;
  /** Last independent verifier task the Control Plane started for this job. Absent when none was started. */
  releaseVerifier?: { ecsTaskArn: string; dispatchedAt: string } | null;
  /** Last region and AZ order planned from the Spot Placement Score feed, at registration and again at launch. */
  placementPlan?: TrainingPlacementPlan | null;
  releaseDecision: ModelReleaseDecision | null;
  publication: ModelReleasePublication | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvalReason: string | null;
  cancelReason: string | null;
  failureReason: string | null;
}

export interface CreateModelFactoryJob {
  title: string;
  modelId: string;
  repository: string;
  baseCommit: string;
  compute: Omit<TrainingComputeSpec, 'inputs'> & {
    inputs?: Omit<ModelTrainingInputSpec, 'digest'> & { digest?: string };
  };
  releasePolicy: ModelReleasePolicy;
}

export interface ModelFactoryLedgerEntry {
  jobId: string;
  modelId: string;
  status: ModelFactoryJobStatus;
  region: string;
  instanceType: string;
  reservedMicros: number;
  settledMicros: number | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ModelFactoryLedgerSummary {
  globalBudgetCapMicros: number;
  totalReservedMicros: number;
  totalSettledMicros: number;
  remainingBudgetMicros: number;
  activeReservations: number;
  settledJobs: number;
  jobs: ModelFactoryLedgerEntry[];
}

export interface ModelFactoryEvent {
  sequence: number;
  jobId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
