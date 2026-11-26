export type SpotTimeSeriesPoint = readonly [timestampIso: string, value: number];

export interface SpotTypeMeta {
  family: string;
  arch: 'x86' | 'arm' | string;
  spec: string;
  gpu?: string;
  members: string[];
}

export interface SpotAzMeta {
  region: string;
  azname: string;
}

export interface SpotMarketSnapshot {
  generated: string;
  generatedAtMs: number;
  types: string[];
  regions: string[];
  typeMeta: Record<string, SpotTypeMeta>;
  noPool: Record<string, string[]>;
  azMeta: Record<string, SpotAzMeta>;
  scores: Record<string, Record<string, SpotTimeSeriesPoint[]>>;
  azScores: Record<string, Record<string, SpotTimeSeriesPoint[]>>;
  prices: Record<string, Record<string, SpotTimeSeriesPoint[]>>;
  azPrice: Record<string, Record<string, number>>;
}

export type SpotWorkloadPreset =
  | 'cpu-arm-worker'
  | 'cpu-x86-worker'
  | 'cpu-arm-memory'
  | 'nvme-arm-build'
  | 'nvme-x86-build'
  | 'gpu-l40s-4x'
  | 'gpu-l40s-8x'
  | 'gpu-h100-8x';

export interface RegionRoutingPolicy {
  primaryRegion: string;
  allowedRegions: string[];
  /** Concrete feed pool key (e.g. 'c.xlarge-arm', 'g6e.12xlarge', 'p5.48xlarge') or preset name. */
  workloadClass: string;
  /** Minimum latest Spot Placement Score (1..10). Defaults to 7. */
  minPlacementScore?: number;
  /** Trend evaluation lookback window in hours. Defaults to 48 (8 samples at 6h cadence). */
  trendWindowHours?: number;
  /** Percentage discount advantage given to primaryRegion to avoid cross-region transfer for tiny savings. Defaults to 5. */
  primaryRegionBonusPercent?: number;
  /** Optional hard upper bound on Spot USD/hr price. */
  maxHourlyPriceUsd?: number;
  /** Maximum age of feed snapshot in hours before falling back to primaryRegion. Defaults to 24. */
  maxFeedAgeHours?: number;
  /** Regions temporarily excluded (e.g. after a recent Spot interruption). */
  excludeRegions?: string[];
}

export type ScoreTrendDirection = 'improving' | 'stable' | 'declining';

export interface RegionCandidateEvaluation {
  region: string;
  azId: string | null;
  azName: string | null;
  eligible: boolean;
  rejectionReason: string | null;
  latestScore: number | null;
  windowAvgScore: number | null;
  windowMinScore: number | null;
  scoreSlope: number | null;
  trendDirection: ScoreTrendDirection;
  latestPriceUsd: number | null;
  windowAvgPriceUsd: number | null;
  effectiveCostUsd: number | null;
}

export interface RegionPlacementDecision {
  selectedRegion: string;
  selectedAzId: string | null;
  selectedAzName: string | null;
  primaryRegion: string;
  workloadClass: string;
  instanceMembers: string[];
  latestScore: number | null;
  windowAvgScore: number | null;
  trendDirection: ScoreTrendDirection;
  latestPriceUsd: number | null;
  primaryPriceUsd: number | null;
  savingsVsPrimaryPercent: number | null;
  fallbackChain: { region: string; azId: string | null; azName: string | null }[];
  candidates: RegionCandidateEvaluation[];
  feedGeneratedAt: string | null;
  feedStaleFallback: boolean;
  reason: string;
  decidedAt: string;
}

export interface AwsSpokeRegionConfig {
  region: string;
  clusterArn: string;
  workerTaskDefinition: string;
  verifierTaskDefinition: string;
  workerContainerName?: string;
  verifierContainerName?: string;
  subnets: string[];
  /** Optional physical AZ ID -> subnetId map so AZ-level Spot selection targets the exact subnet. */
  subnetByAzId?: Record<string, string>;
  securityGroups: string[];
  assignPublicIp?: 'ENABLED' | 'DISABLED';
  controlApiUrl: string;
  allowVpcInternalHttp?: boolean;
  artifactsBucket: string;
  allowOnDemandFallback?: boolean;
}
