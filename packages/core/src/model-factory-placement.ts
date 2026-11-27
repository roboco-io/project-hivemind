import type {
  PlacementScoreTrend,
  PlannedPlacementRegion,
  TrainingComputeSpec,
  TrainingPlacementPlan,
} from '../../contracts/src/model-factory.js';
import type { SpotMarketSnapshot, SpotTimeSeriesPoint } from '../../contracts/src/multi-region.js';
import { resolveWorkloadPreset } from './multi-region.js';

export const PLACEMENT_TREND_WINDOW_HOURS = 72;
export const PLACEMENT_MAX_FEED_AGE_HOURS = 24;

/** The regions a training job may launch in: its own region first, then its candidate regions. */
export function trainingCandidateRegions(compute: Pick<TrainingComputeSpec, 'region' | 'candidateRegions'>): string[] {
  return [...new Set([compute.region, ...(compute.candidateRegions ?? [])])];
}

/**
 * Finds the feed pool for a job. An explicit `workloadClass` wins. Otherwise the pool is the one named after
 * the instance type, or the one whose members include it. Null when the feed does not cover the type.
 */
export function resolveFeedPool(
  snapshot: SpotMarketSnapshot,
  compute: Pick<TrainingComputeSpec, 'instanceType' | 'workloadClass'>,
): string | null {
  if (compute.workloadClass) {
    let pool: string;
    try {
      pool = resolveWorkloadPreset(compute.workloadClass);
    } catch {
      return null;
    }
    return Object.hasOwn(snapshot.typeMeta, pool) ? pool : null;
  }
  if (Object.hasOwn(snapshot.typeMeta, compute.instanceType)) return compute.instanceType;
  for (const [pool, meta] of Object.entries(snapshot.typeMeta)) {
    if (Array.isArray(meta?.members) && meta.members.includes(compute.instanceType)) return pool;
  }
  return null;
}

function trendOf(series: readonly SpotTimeSeriesPoint[] | undefined, cutoffMs: number): PlacementScoreTrend | null {
  if (!Array.isArray(series)) return null;
  const values: number[] = [];
  for (const point of series) {
    if (!Array.isArray(point)) continue;
    const at = Date.parse(String(point[0]));
    const value = point[1];
    if (Number.isFinite(at) && at >= cutoffMs && typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  const avgOf = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  const mid = Math.floor(values.length / 2);
  const slope = values.length >= 2 ? avgOf(values.slice(mid)) - avgOf(values.slice(0, mid)) : 0;
  return {
    latest: values.at(-1)!,
    min: Math.min(...values),
    avg: Number(avgOf(values).toFixed(2)),
    slope: Number(slope.toFixed(2)),
    samples: values.length,
  };
}

function latestPrice(series: readonly SpotTimeSeriesPoint[] | undefined): number | null {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i]?.[1];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Most stable first: the lowest score in the window, then the average, then the latest score.
 * A pool that never dropped is safer than one that is high now but dropped recently.
 */
function compareStability(a: PlacementScoreTrend, b: PlacementScoreTrend): number {
  return b.min - a.min || b.avg - a.avg || b.latest - a.latest;
}

/**
 * Orders the job's regions, and the AZs inside each region, by Spot Placement Score stability.
 * Regions without scores keep their listed order after the scored ones. The plan never adds or removes a
 * region, so it stays inside what the human approved.
 */
export function planTrainingPlacement(
  snapshot: SpotMarketSnapshot | null,
  compute: Pick<TrainingComputeSpec, 'region' | 'candidateRegions' | 'instanceType' | 'workloadClass'>,
  nowMs: number,
  feedUrl: string | null = null,
): TrainingPlacementPlan {
  const regions = trainingCandidateRegions(compute);
  const base = {
    feedUrl,
    feedGeneratedAt: snapshot?.generated ?? null,
    trendWindowHours: PLACEMENT_TREND_WINDOW_HOURS,
    plannedAt: new Date(nowMs).toISOString(),
  };
  const unranked = (status: TrainingPlacementPlan['status'], note: string, feedPool: string | null = null): TrainingPlacementPlan => ({
    ...base,
    status,
    note,
    feedPool,
    feedPoolMembers: feedPool && snapshot ? [...(snapshot.typeMeta[feedPool]?.members ?? [])] : [],
    regions: regions.map((region) => ({ region, trend: null, priceUsd: null, azs: [] })),
  });

  if (!snapshot) return unranked('feed_unavailable', 'Spot placement score feed is unavailable; regions keep their listed order.');
  if (!Number.isFinite(snapshot.generatedAtMs) || nowMs - snapshot.generatedAtMs > PLACEMENT_MAX_FEED_AGE_HOURS * 3_600_000) {
    return unranked(
      'feed_stale',
      `Spot placement score feed (${snapshot.generated}) is older than ${PLACEMENT_MAX_FEED_AGE_HOURS} hours; regions keep their listed order.`,
    );
  }
  const pool = resolveFeedPool(snapshot, compute);
  if (!pool) {
    return unranked(
      'type_not_in_feed',
      compute.workloadClass
        ? `Feed has no pool '${compute.workloadClass}'; regions keep their listed order.`
        : `Feed does not cover ${compute.instanceType}; regions keep their listed order. Set compute.workloadClass to a feed pool to rank by a similar pool.`,
    );
  }

  const cutoffMs = snapshot.generatedAtMs - PLACEMENT_TREND_WINDOW_HOURS * 3_600_000;
  const regionScores = snapshot.scores[pool] ?? {};
  const regionPrices = snapshot.prices[pool] ?? {};
  const azScores = snapshot.azScores[pool] ?? {};
  const noPool = new Set(snapshot.noPool[pool] ?? []);

  const planned: PlannedPlacementRegion[] = regions.map((region) => {
    const azs: { azId: string; trend: PlacementScoreTrend }[] = [];
    for (const [azId, meta] of Object.entries(snapshot.azMeta)) {
      if (meta?.region !== region) continue;
      const trend = trendOf(azScores[azId], cutoffMs);
      if (trend) azs.push({ azId, trend });
    }
    azs.sort((a, b) => compareStability(a.trend, b.trend) || a.azId.localeCompare(b.azId));
    return {
      region,
      trend: noPool.has(region) ? null : trendOf(regionScores[region], cutoffMs),
      priceUsd: latestPrice(regionPrices[region]),
      azs: noPool.has(region) ? [] : azs,
    };
  });

  const order = new Map(regions.map((region, index) => [region, index]));
  planned.sort((a, b) => {
    if (a.trend && b.trend) {
      return (
        compareStability(a.trend, b.trend) ||
        (a.priceUsd ?? Number.POSITIVE_INFINITY) - (b.priceUsd ?? Number.POSITIVE_INFINITY) ||
        order.get(a.region)! - order.get(b.region)!
      );
    }
    if (a.trend) return -1;
    if (b.trend) return 1;
    return order.get(a.region)! - order.get(b.region)!;
  });

  const first = planned[0]!;
  const note = first.trend
    ? `Ranked by the lowest, average and latest Spot placement score of '${pool}' over ${PLACEMENT_TREND_WINDOW_HOURS} hours. ` +
      `First: ${first.region}${first.azs[0] ? ` (${first.azs[0].azId})` : ''}, min ${first.trend.min}, avg ${first.trend.avg}, latest ${first.trend.latest}.`
    : `Feed pool '${pool}' has no scores for these regions; regions keep their listed order.`;
  return {
    ...base,
    status: first.trend ? 'ranked' : 'type_not_in_feed',
    note,
    feedPool: pool,
    feedPoolMembers: [...(snapshot.typeMeta[pool]?.members ?? [])],
    regions: planned,
  };
}

/**
 * Orders subnets by the plan's AZ order. Subnets whose AZ the plan does not rank keep their order after
 * the ranked ones.
 */
export function orderSubnetsByPlannedAzs(
  subnetIds: readonly string[],
  subnetAzIds: Readonly<Record<string, string>>,
  plannedAzIds: readonly string[],
): string[] {
  const rank = new Map(plannedAzIds.map((azId, index) => [azId, index]));
  const position = new Map(subnetIds.map((id, index) => [id, index]));
  const rankOf = (subnetId: string) => {
    const azId = subnetAzIds[subnetId];
    return azId !== undefined && rank.has(azId) ? rank.get(azId)! : Number.POSITIVE_INFINITY;
  };
  return [...subnetIds].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return position.get(a)! - position.get(b)!;
  });
}
