import type {
  RegionCandidateEvaluation,
  RegionPlacementDecision,
  RegionRoutingPolicy,
  ScoreTrendDirection,
  SpotMarketSnapshot,
  SpotTimeSeriesPoint,
  SpotWorkloadPreset,
} from '../../contracts/src/multi-region.js';
import { DomainError } from './store.js';

export const DEFAULT_PRIMARY_REGION = 'ap-northeast-2';
export const DEFAULT_ALLOWED_REGIONS = [
  'ap-northeast-2',
  'ap-northeast-1',
  'us-east-2',
  'us-east-1',
  'us-west-2',
] as const;

const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/;
const WORKLOAD_PATTERN = /^[a-z0-9][a-z0-9.-]{1,40}$/;

const WORKLOAD_PRESETS: Record<SpotWorkloadPreset, string> = {
  'cpu-arm-worker': 'c.xlarge-arm',
  'cpu-x86-worker': 'c.xlarge',
  'cpu-arm-memory': 'r.xlarge-arm',
  'nvme-arm-build': 'i8g.mixed',
  'nvme-x86-build': 'i.xlarge',
  'gpu-l40s-4x': 'g6e.12xlarge',
  'gpu-l40s-8x': 'g6e.48xlarge',
  'gpu-h100-8x': 'p5.48xlarge',
};

export function resolveWorkloadPreset(input: string): string {
  const trimmed = input.trim();
  if (Object.hasOwn(WORKLOAD_PRESETS, trimmed)) {
    return WORKLOAD_PRESETS[trimmed as SpotWorkloadPreset];
  }
  if (!WORKLOAD_PATTERN.test(trimmed)) {
    throw new DomainError('Invalid workloadClass', 400);
  }
  return trimmed;
}

export function validateRegionRoutingPolicy(input: unknown): RegionRoutingPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('Invalid region routing policy', 400);
  }
  const raw = input as Record<string, unknown>;
  const primaryRegion = typeof raw.primaryRegion === 'string' ? raw.primaryRegion.trim() : DEFAULT_PRIMARY_REGION;
  if (!REGION_PATTERN.test(primaryRegion) || primaryRegion.length > 32) {
    throw new DomainError('Invalid primaryRegion', 400);
  }
  const allowedInput = Array.isArray(raw.allowedRegions) ? raw.allowedRegions : [primaryRegion];
  if (allowedInput.length < 1 || allowedInput.length > 16) {
    throw new DomainError('allowedRegions must contain 1 to 16 regions', 400);
  }
  const allowedRegions: string[] = [];
  const seen = new Set<string>();
  for (const item of allowedInput) {
    if (typeof item !== 'string' || !REGION_PATTERN.test(item.trim()) || item.trim().length > 32) {
      throw new DomainError('Invalid region in allowedRegions', 400);
    }
    const clean = item.trim();
    if (seen.has(clean)) throw new DomainError(`Duplicate region in allowedRegions: ${clean}`, 400);
    seen.add(clean);
    allowedRegions.push(clean);
  }
  if (!seen.has(primaryRegion)) {
    throw new DomainError('primaryRegion must be included in allowedRegions', 400);
  }

  const workloadClass = resolveWorkloadPreset(String(raw.workloadClass ?? 'c.xlarge-arm'));

  const minPlacementScore = raw.minPlacementScore === undefined ? 7 : Number(raw.minPlacementScore);
  if (!Number.isInteger(minPlacementScore) || minPlacementScore < 1 || minPlacementScore > 10) {
    throw new DomainError('minPlacementScore must be an integer between 1 and 10', 400);
  }

  const trendWindowHours = raw.trendWindowHours === undefined ? 48 : Number(raw.trendWindowHours);
  if (!Number.isSafeInteger(trendWindowHours) || trendWindowHours < 6 || trendWindowHours > 720) {
    throw new DomainError('trendWindowHours must be between 6 and 720', 400);
  }

  const primaryRegionBonusPercent =
    raw.primaryRegionBonusPercent === undefined ? 5 : Number(raw.primaryRegionBonusPercent);
  if (!Number.isFinite(primaryRegionBonusPercent) || primaryRegionBonusPercent < 0 || primaryRegionBonusPercent > 50) {
    throw new DomainError('primaryRegionBonusPercent must be between 0 and 50', 400);
  }

  let maxHourlyPriceUsd: number | undefined;
  if (raw.maxHourlyPriceUsd !== undefined) {
    const val = Number(raw.maxHourlyPriceUsd);
    if (!Number.isFinite(val) || val <= 0 || val > 500) {
      throw new DomainError('maxHourlyPriceUsd must be between 0 and 500', 400);
    }
    maxHourlyPriceUsd = val;
  }

  const maxFeedAgeHours = raw.maxFeedAgeHours === undefined ? 24 : Number(raw.maxFeedAgeHours);
  if (!Number.isFinite(maxFeedAgeHours) || maxFeedAgeHours < 1 || maxFeedAgeHours > 168) {
    throw new DomainError('maxFeedAgeHours must be between 1 and 168', 400);
  }

  let excludeRegions: string[] | undefined;
  if (raw.excludeRegions !== undefined) {
    if (!Array.isArray(raw.excludeRegions) || raw.excludeRegions.length > 16) {
      throw new DomainError('Invalid excludeRegions', 400);
    }
    excludeRegions = raw.excludeRegions.map((item) => {
      if (typeof item !== 'string' || !REGION_PATTERN.test(item.trim())) {
        throw new DomainError('Invalid region in excludeRegions', 400);
      }
      return item.trim();
    });
  }

  return {
    primaryRegion,
    allowedRegions,
    workloadClass,
    minPlacementScore,
    trendWindowHours,
    primaryRegionBonusPercent,
    ...(maxHourlyPriceUsd !== undefined ? { maxHourlyPriceUsd } : {}),
    maxFeedAgeHours,
    ...(excludeRegions ? { excludeRegions } : {}),
  };
}

function sliceWindow(series: SpotTimeSeriesPoint[] | undefined, cutoffMs: number): SpotTimeSeriesPoint[] {
  if (!series?.length) return [];
  const filtered = series.filter(([ts]) => {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= cutoffMs;
  });
  return filtered.length > 0 ? filtered : series.slice(-1);
}

function analyzeTrend(points: SpotTimeSeriesPoint[]): {
  latest: number | null;
  avg: number | null;
  min: number | null;
  slope: number | null;
  direction: ScoreTrendDirection;
} {
  if (!points.length) {
    return { latest: null, avg: null, min: null, slope: null, direction: 'stable' };
  }
  const values = points.map((p) => p[1]).filter((v) => Number.isFinite(v));
  if (!values.length) {
    return { latest: null, avg: null, min: null, slope: null, direction: 'stable' };
  }
  const latest = values.at(-1)!;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  let slope = 0;
  if (values.length >= 2) {
    const mid = Math.floor(values.length / 2);
    const earlier = values.slice(0, mid);
    const recent = values.slice(mid);
    const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    slope = Number((recentAvg - earlierAvg).toFixed(2));
  }
  const direction: ScoreTrendDirection = slope >= 0.5 ? 'improving' : slope <= -0.5 ? 'declining' : 'stable';
  return {
    latest,
    avg: Number(avg.toFixed(2)),
    min,
    slope,
    direction,
  };
}

function selectBestAzInRegion(
  snapshot: SpotMarketSnapshot,
  workloadClass: string,
  region: string,
  minPlacementScore: number,
  cutoffMs: number,
): { azId: string | null; azName: string | null; azPriceUsd: number | null } {
  const azScoresMap = snapshot.azScores[workloadClass] ?? {};
  const azPricesMap = snapshot.azPrice[workloadClass] ?? {};
  const azCandidates: { azId: string; azName: string; score: number; avgScore: number; priceUsd: number }[] = [];

  for (const [azId, meta] of Object.entries(snapshot.azMeta)) {
    if (meta.region !== region) continue;
    const azSeries = sliceWindow(azScoresMap[azId], cutoffMs);
    const trend = analyzeTrend(azSeries);
    const price = azPricesMap[meta.azname];
    if (trend.latest === null) continue;
    azCandidates.push({
      azId,
      azName: meta.azname,
      score: trend.latest,
      avgScore: trend.avg ?? trend.latest,
      priceUsd: typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : Number.POSITIVE_INFINITY,
    });
  }

  if (!azCandidates.length) return { azId: null, azName: null, azPriceUsd: null };

  const passing = azCandidates.filter((c) => c.score >= minPlacementScore);
  const pool = passing.length > 0 ? passing : azCandidates;
  pool.sort((a, b) => {
    // Prefer higher placement score tier (9-10 vs 7-8), then lowest AZ Spot price.
    if (b.score !== a.score && Math.abs(b.score - a.score) >= 2) return b.score - a.score;
    if (a.priceUsd !== b.priceUsd) return a.priceUsd - b.priceUsd;
    return b.avgScore - a.avgScore;
  });
  const best = pool[0]!;
  return {
    azId: best.azId,
    azName: best.azName,
    azPriceUsd: Number.isFinite(best.priceUsd) ? best.priceUsd : null,
  };
}

/**
 * Pure, deterministic multi-region Spot placement selector.
 * Balances Spot Placement Score + trend stability + hourly Spot price while keeping primaryRegion (Seoul)
 * as the preferred default when cost difference is within primaryRegionBonusPercent.
 */
export function selectOptimalSpotPlacement(
  snapshot: SpotMarketSnapshot | null,
  rawPolicy: RegionRoutingPolicy,
  nowMs: number = Date.now(),
): RegionPlacementDecision {
  const policy = validateRegionRoutingPolicy(rawPolicy);
  const decidedAt = new Date(nowMs).toISOString();
  const minScore = policy.minPlacementScore ?? 7;
  const windowHours = policy.trendWindowHours ?? 48;
  const primaryBonus = (policy.primaryRegionBonusPercent ?? 5) / 100;
  const maxFeedAgeMs = (policy.maxFeedAgeHours ?? 24) * 3_600_000;
  const excluded = new Set(policy.excludeRegions ?? []);

  const fallbackToPrimary = (reason: string, feedStaleFallback: boolean): RegionPlacementDecision => ({
    selectedRegion: policy.primaryRegion,
    selectedAzId: null,
    selectedAzName: null,
    primaryRegion: policy.primaryRegion,
    workloadClass: policy.workloadClass,
    instanceMembers: snapshot?.typeMeta[policy.workloadClass]?.members ?? [],
    latestScore: null,
    windowAvgScore: null,
    trendDirection: 'stable',
    latestPriceUsd: null,
    primaryPriceUsd: null,
    savingsVsPrimaryPercent: null,
    fallbackChain: policy.allowedRegions
      .filter((r) => r !== policy.primaryRegion && !excluded.has(r))
      .map((region) => ({ region, azId: null, azName: null })),
    candidates: [],
    feedGeneratedAt: snapshot?.generated ?? null,
    feedStaleFallback,
    reason,
    decidedAt,
  });

  if (!snapshot) {
    return fallbackToPrimary(`Spot feed unavailable; falling back safely to primary region ${policy.primaryRegion}`, true);
  }
  if (!Number.isFinite(snapshot.generatedAtMs) || nowMs - snapshot.generatedAtMs > maxFeedAgeMs) {
    return fallbackToPrimary(
      `Spot feed (${snapshot.generated}) exceeds maxFeedAgeHours (${policy.maxFeedAgeHours ?? 24}h); falling back to ${policy.primaryRegion}`,
      true,
    );
  }

  const workload = policy.workloadClass;
  const typeMeta = snapshot.typeMeta[workload];
  if (!typeMeta) {
    return fallbackToPrimary(
      `Workload class '${workload}' not found in Spot feed; falling back to primary region ${policy.primaryRegion}`,
      true,
    );
  }

  const cutoffMs = snapshot.generatedAtMs - windowHours * 3_600_000;
  const noPoolRegions = new Set(snapshot.noPool[workload] ?? []);
  const regionScores = snapshot.scores[workload] ?? {};
  const regionPrices = snapshot.prices[workload] ?? {};

  const candidates: RegionCandidateEvaluation[] = [];

  for (const region of policy.allowedRegions) {
    const scoreSeries = sliceWindow(regionScores[region], cutoffMs);
    const priceSeries = sliceWindow(regionPrices[region], cutoffMs);
    const scoreTrend = analyzeTrend(scoreSeries);
    const priceTrend = analyzeTrend(priceSeries);
    const bestAz = selectBestAzInRegion(snapshot, workload, region, minScore, cutoffMs);
    const latestPriceUsd = bestAz.azPriceUsd ?? priceTrend.latest;

    let eligible = true;
    let rejectionReason: string | null = null;

    if (excluded.has(region)) {
      eligible = false;
      rejectionReason = 'Excluded due to recent Spot interruption or operator exclusion';
    } else if (noPoolRegions.has(region)) {
      eligible = false;
      rejectionReason = `No Spot capacity pool for ${workload} in ${region}`;
    } else if (scoreTrend.latest === null || latestPriceUsd === null) {
      eligible = false;
      rejectionReason = `Missing Spot score or price telemetry for ${workload} in ${region}`;
    } else if (scoreTrend.latest < minScore) {
      eligible = false;
      rejectionReason = `Latest Spot placement score ${scoreTrend.latest} is below minimum ${minScore}`;
    } else if ((scoreTrend.avg ?? 0) < Math.max(1, minScore - 1)) {
      eligible = false;
      rejectionReason = `Window average Spot score ${scoreTrend.avg} indicates unstable capacity`;
    } else if (policy.maxHourlyPriceUsd !== undefined && latestPriceUsd > policy.maxHourlyPriceUsd) {
      eligible = false;
      rejectionReason = `Spot price $${latestPriceUsd.toFixed(4)}/hr exceeds maxHourlyPriceUsd $${policy.maxHourlyPriceUsd.toFixed(4)}/hr`;
    }

    let effectiveCostUsd: number | null = null;
    if (eligible && latestPriceUsd !== null && scoreTrend.latest !== null) {
      // Primary region gets a small bonus to prefer local latency & zero cross-region transfer when prices are close.
      const primaryFactor = region === policy.primaryRegion ? 1 - primaryBonus : 1;
      // Stability penalty: declining score trend or score < 9 adds a modest risk factor for interruption overhead.
      const scorePenalty = scoreTrend.latest >= 9 ? 1 : scoreTrend.latest >= 8 ? 1.04 : 1.1;
      const trendPenalty = scoreTrend.direction === 'declining' ? 1.08 : scoreTrend.direction === 'improving' ? 0.98 : 1;
      effectiveCostUsd = Number((latestPriceUsd * primaryFactor * scorePenalty * trendPenalty).toFixed(6));
    }

    candidates.push({
      region,
      azId: bestAz.azId,
      azName: bestAz.azName,
      eligible,
      rejectionReason,
      latestScore: scoreTrend.latest,
      windowAvgScore: scoreTrend.avg,
      windowMinScore: scoreTrend.min,
      scoreSlope: scoreTrend.slope,
      trendDirection: scoreTrend.direction,
      latestPriceUsd,
      windowAvgPriceUsd: priceTrend.avg,
      effectiveCostUsd,
    });
  }

  const primaryEval = candidates.find((c) => c.region === policy.primaryRegion) ?? null;
  const primaryPriceUsd = primaryEval?.latestPriceUsd ?? null;

  const eligibleCandidates = candidates
    .filter((c) => c.eligible && c.effectiveCostUsd !== null)
    .sort((a, b) => {
      if (a.effectiveCostUsd! !== b.effectiveCostUsd!) return a.effectiveCostUsd! - b.effectiveCostUsd!;
      if (a.region === policy.primaryRegion) return -1;
      if (b.region === policy.primaryRegion) return 1;
      return (b.latestScore ?? 0) - (a.latestScore ?? 0);
    });

  if (!eligibleCandidates.length) {
    // Graceful fallback: pick highest-scoring non-excluded allowed region (preferring primaryRegion on tie) unless hard price cap blocks all.
    const unexcluded = candidates.filter((c) => !excluded.has(c.region) && c.latestScore !== null);
    if (policy.maxHourlyPriceUsd !== undefined) {
      throw new DomainError(
        `No allowed region satisfies Spot policy for ${workload} within maxHourlyPriceUsd $${policy.maxHourlyPriceUsd}`,
        422,
      );
    }
    unexcluded.sort((a, b) => {
      if ((b.latestScore ?? 0) !== (a.latestScore ?? 0)) return (b.latestScore ?? 0) - (a.latestScore ?? 0);
      if (a.region === policy.primaryRegion) return -1;
      if (b.region === policy.primaryRegion) return 1;
      return (a.latestPriceUsd ?? Number.POSITIVE_INFINITY) - (b.latestPriceUsd ?? Number.POSITIVE_INFINITY);
    });
    const best = unexcluded[0];
    if (!best) {
      return fallbackToPrimary(`No Spot telemetry available for ${workload}; falling back to ${policy.primaryRegion}`, true);
    }
    return {
      selectedRegion: best.region,
      selectedAzId: best.azId,
      selectedAzName: best.azName,
      primaryRegion: policy.primaryRegion,
      workloadClass: workload,
      instanceMembers: typeMeta.members,
      latestScore: best.latestScore,
      windowAvgScore: best.windowAvgScore,
      trendDirection: best.trendDirection,
      latestPriceUsd: best.latestPriceUsd,
      primaryPriceUsd,
      savingsVsPrimaryPercent:
        primaryPriceUsd && best.latestPriceUsd
          ? Number((((primaryPriceUsd - best.latestPriceUsd) / primaryPriceUsd) * 100).toFixed(1))
          : null,
      fallbackChain: unexcluded.slice(1).map((c) => ({ region: c.region, azId: c.azId, azName: c.azName })),
      candidates,
      feedGeneratedAt: snapshot.generated,
      feedStaleFallback: false,
      reason: `No region reached minPlacementScore ${minScore}; selected highest available region ${best.region} (score ${best.latestScore})`,
      decidedAt,
    };
  }

  const chosen = eligibleCandidates[0]!;
  const savingsVsPrimaryPercent =
    primaryPriceUsd && chosen.latestPriceUsd
      ? Number((((primaryPriceUsd - chosen.latestPriceUsd) / primaryPriceUsd) * 100).toFixed(1))
      : null;

  const reason =
    chosen.region === policy.primaryRegion
      ? `Selected primary region ${chosen.region}${chosen.azId ? ` (${chosen.azId})` : ''}: score ${chosen.latestScore}/10 (${chosen.trendDirection}), $${chosen.latestPriceUsd?.toFixed(4)}/hr`
      : `Selected spoke region ${chosen.region}${chosen.azId ? ` (${chosen.azId})` : ''} over primary ${policy.primaryRegion}: score ${chosen.latestScore}/10 (${chosen.trendDirection}), $${chosen.latestPriceUsd?.toFixed(4)}/hr${savingsVsPrimaryPercent !== null ? ` (${savingsVsPrimaryPercent >= 0 ? `${savingsVsPrimaryPercent}% cheaper` : `${Math.abs(savingsVsPrimaryPercent)}% higher but primary unavailable/low-score`})` : ''}`;

  return {
    selectedRegion: chosen.region,
    selectedAzId: chosen.azId,
    selectedAzName: chosen.azName,
    primaryRegion: policy.primaryRegion,
    workloadClass: workload,
    instanceMembers: typeMeta.members,
    latestScore: chosen.latestScore,
    windowAvgScore: chosen.windowAvgScore,
    trendDirection: chosen.trendDirection,
    latestPriceUsd: chosen.latestPriceUsd,
    primaryPriceUsd,
    savingsVsPrimaryPercent,
    fallbackChain: eligibleCandidates.slice(1).map((c) => ({ region: c.region, azId: c.azId, azName: c.azName })),
    candidates,
    feedGeneratedAt: snapshot.generated,
    feedStaleFallback: false,
    reason,
    decidedAt,
  };
}
