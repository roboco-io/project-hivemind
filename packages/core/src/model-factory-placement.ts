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

function windowValues(series: readonly SpotTimeSeriesPoint[] | undefined, cutoffMs: number): number[] {
  if (!Array.isArray(series)) return [];
  const values: number[] = [];
  for (const point of series) {
    if (!Array.isArray(point)) continue;
    const at = Date.parse(String(point[0]));
    const value = point[1];
    if (Number.isFinite(at) && at >= cutoffMs && typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  return values;
}

function trendOf(values: number[]): PlacementScoreTrend | null {
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

/** Current scores read from EC2 GetSpotPlacementScores for the job's own instance type. */
export interface LivePlacementScores {
  at: string;
  /** `azId` null: a regional score. */
  scores: { region: string; azId: string | null; score: number }[];
}

/**
 * Orders the job's regions, and the AZs inside each region, by Spot Placement Score stability.
 * The feed gives the trend; live scores, when present, are added as the newest sample. Regions without
 * scores keep their listed order after the scored ones. The plan never adds or removes a region, so it
 * stays inside what the human approved.
 */
export function planTrainingPlacement(
  snapshot: SpotMarketSnapshot | null,
  compute: Pick<TrainingComputeSpec, 'region' | 'candidateRegions' | 'instanceType' | 'workloadClass'>,
  nowMs: number,
  feedUrl: string | null = null,
  live: LivePlacementScores | null = null,
): TrainingPlacementPlan {
  const regions = trainingCandidateRegions(compute);
  const liveScores = live?.scores.filter((s) => Number.isInteger(s.score) && s.score >= 1 && s.score <= 10) ?? [];

  let feedProblem: { status: TrainingPlacementPlan['status']; note: string } | null = null;
  let pool: string | null = null;
  if (!snapshot) {
    feedProblem = { status: 'feed_unavailable', note: 'Spot placement score feed is unavailable.' };
  } else if (!Number.isFinite(snapshot.generatedAtMs) || nowMs - snapshot.generatedAtMs > PLACEMENT_MAX_FEED_AGE_HOURS * 3_600_000) {
    feedProblem = {
      status: 'feed_stale',
      note: `Spot placement score feed (${snapshot.generated}) is older than ${PLACEMENT_MAX_FEED_AGE_HOURS} hours.`,
    };
  } else {
    pool = resolveFeedPool(snapshot, compute);
    if (!pool) {
      feedProblem = {
        status: 'type_not_in_feed',
        note: compute.workloadClass
          ? `Feed has no pool '${compute.workloadClass}'.`
          : `Feed does not cover ${compute.instanceType}.`,
      };
    }
  }
  const feed = pool && snapshot ? snapshot : null;
  const cutoffMs = (feed?.generatedAtMs ?? nowMs) - PLACEMENT_TREND_WINDOW_HOURS * 3_600_000;
  const regionScores = feed ? (feed.scores[pool!] ?? {}) : {};
  const regionPrices = feed ? (feed.prices[pool!] ?? {}) : {};
  const azScores = feed ? (feed.azScores[pool!] ?? {}) : {};
  const noPool = new Set(feed ? (feed.noPool[pool!] ?? []) : []);

  const planned: PlannedPlacementRegion[] = regions.map((region) => {
    const azIds = new Set<string>();
    if (feed) for (const [azId, meta] of Object.entries(feed.azMeta)) if (meta?.region === region) azIds.add(azId);
    for (const s of liveScores) if (s.region === region && s.azId) azIds.add(s.azId);
    const azs: { azId: string; trend: PlacementScoreTrend }[] = [];
    for (const azId of azIds) {
      const values = noPool.has(region) ? [] : windowValues(azScores[azId], cutoffMs);
      for (const s of liveScores) if (s.azId === azId) values.push(s.score);
      const trend = trendOf(values);
      if (trend) azs.push({ azId, trend });
    }
    azs.sort((a, b) => compareStability(a.trend, b.trend) || a.azId.localeCompare(b.azId));
    const values = noPool.has(region) ? [] : windowValues(regionScores[region], cutoffMs);
    for (const s of liveScores) if (s.region === region && s.azId === null) values.push(s.score);
    return { region, trend: trendOf(values), priceUsd: latestPrice(regionPrices[region]), azs };
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
  const sources = [feed ? `the feed pool '${pool}' over ${PLACEMENT_TREND_WINDOW_HOURS} hours` : null, liveScores.length ? `live scores of ${compute.instanceType}` : null]
    .filter(Boolean)
    .join(' and ');
  const ranked = first.trend !== null;
  const note = ranked
    ? `${feedProblem ? `${feedProblem.note} ` : ''}Ranked by the lowest, average and latest Spot placement score from ${sources}. ` +
      `First: ${first.region}${first.azs[0] ? ` (${first.azs[0].azId})` : ''}, min ${first.trend!.min}, avg ${first.trend!.avg}, latest ${first.trend!.latest}.`
    : `${feedProblem?.note ?? `Feed pool '${pool}' has no scores for these regions.`} No live scores. Regions keep their listed order.` +
      (feedProblem?.status === 'type_not_in_feed' && !compute.workloadClass ? ' Set compute.workloadClass to a feed pool to rank by a similar pool.' : '');
  return {
    status: ranked ? 'ranked' : (feedProblem?.status ?? 'type_not_in_feed'),
    note,
    feedUrl,
    feedGeneratedAt: snapshot?.generated ?? null,
    feedPool: pool,
    feedPoolMembers: pool && snapshot ? [...(snapshot.typeMeta[pool]?.members ?? [])] : [],
    liveScoredAt: liveScores.length ? live!.at : null,
    trendWindowHours: PLACEMENT_TREND_WINDOW_HOURS,
    regions: planned,
    plannedAt: new Date(nowMs).toISOString(),
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
