import { createSpotPlacementFeedPort, DEFAULT_SPOT_FEED_URL } from '../packages/adapters/src/spot-placement-feed.js';
import {
  DEFAULT_ALLOWED_REGIONS,
  DEFAULT_PRIMARY_REGION,
  selectOptimalSpotPlacement,
} from '../packages/core/src/multi-region.js';

const PRESETS = [
  { label: 'CPU ARM64 Worker (4vCPU/8GiB)', workloadClass: 'c.xlarge-arm' },
  { label: 'CPU x86 Worker (4vCPU/8GiB)', workloadClass: 'c.xlarge' },
  { label: 'Memory ARM64 (4vCPU/32GiB)', workloadClass: 'r.xlarge-arm' },
  { label: 'NVMe ARM64 Heavy Build', workloadClass: 'i8g.mixed' },
  { label: 'GPU 4×L40S (g6e.12xlarge)', workloadClass: 'g6e.12xlarge' },
  { label: 'GPU 8×H100 (p5.48xlarge)', workloadClass: 'p5.48xlarge' },
] as const;

async function main(): Promise<void> {
  const feedUrl = process.env.HIVEMIND_SPOT_FEED_URL ?? DEFAULT_SPOT_FEED_URL;
  const primaryRegion = process.env.HIVEMIND_PRIMARY_REGION ?? DEFAULT_PRIMARY_REGION;
  const allowedRegions = (process.env.HIVEMIND_ALLOWED_REGIONS ?? DEFAULT_ALLOWED_REGIONS.join(','))
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const minPlacementScore = Number(process.env.HIVEMIND_MIN_PLACEMENT_SCORE ?? '7');
  const trendWindowHours = Number(process.env.HIVEMIND_TREND_WINDOW_HOURS ?? '48');

  const feed = createSpotPlacementFeedPort({ feedUrl });
  const snapshot = await feed.getSnapshot(AbortSignal.timeout(15_000));
  if (!snapshot) {
    throw new Error(`Failed to load Spot placement feed from ${feedUrl}`);
  }

  const recommendations = PRESETS.map(({ label, workloadClass }) => {
    const decision = selectOptimalSpotPlacement(snapshot, {
      primaryRegion,
      allowedRegions,
      workloadClass,
      minPlacementScore,
      trendWindowHours,
      primaryRegionBonusPercent: 5,
    });
    return {
      label,
      workloadClass: decision.workloadClass,
      selectedRegion: decision.selectedRegion,
      selectedAz: decision.selectedAzId ? `${decision.selectedAzId} (${decision.selectedAzName})` : null,
      score: decision.latestScore,
      windowAvgScore: decision.windowAvgScore,
      trend: decision.trendDirection,
      selectedPriceUsd: decision.latestPriceUsd,
      primaryPriceUsd: decision.primaryPriceUsd,
      savingsVsSeoulPercent: decision.savingsVsPrimaryPercent,
      fallback: decision.fallbackChain.slice(0, 2).map((f) => `${f.region}${f.azId ? `/${f.azId}` : ''}`),
      reason: decision.reason,
    };
  });

  console.log(
    JSON.stringify(
      {
        feedUrl,
        feedGeneratedAt: snapshot.generated,
        primaryRegion,
        allowedRegions,
        recommendations,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
