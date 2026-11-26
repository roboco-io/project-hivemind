import type { SpotMarketSnapshot } from '../../contracts/src/multi-region.js';

export const DEFAULT_SPOT_FEED_URL = 'https://d16jdvzof4zpo7.cloudfront.net/data.json';
const MAX_FEED_BYTES = 12 * 1024 * 1024;

export interface SpotPlacementFeedConfig {
  feedUrl?: string;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SpotPlacementFeedPort {
  getSnapshot(signal?: AbortSignal): Promise<SpotMarketSnapshot | null>;
}

export function parseGeneratedTimestampMs(raw: string): number {
  const trimmed = raw.trim();
  // Feed format example: "2026-11-26 00:11 UTC"
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?\s+UTC$/i.test(trimmed)
    ? trimmed.replace(/\s+/, 'T').replace(/\s+UTC$/i, 'Z')
    : trimmed;
  return Date.parse(normalized);
}

export function parseSpotMarketSnapshot(raw: unknown): SpotMarketSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Spot feed payload must be a JSON object');
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.generated !== 'string' || !Array.isArray(data.types) || !Array.isArray(data.regions)) {
    throw new Error('Spot feed missing required top-level fields (generated, types, regions)');
  }
  const generatedAtMs = parseGeneratedTimestampMs(data.generated);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error('Spot feed has unparseable generated timestamp');
  }
  if (!data.typeMeta || typeof data.typeMeta !== 'object' || !data.scores || typeof data.scores !== 'object' || !data.prices || typeof data.prices !== 'object') {
    throw new Error('Spot feed missing typeMeta, scores, or prices');
  }
  return {
    generated: data.generated,
    generatedAtMs,
    types: data.types.filter((v): v is string => typeof v === 'string'),
    regions: data.regions.filter((v): v is string => typeof v === 'string'),
    typeMeta: data.typeMeta as SpotMarketSnapshot['typeMeta'],
    noPool: (data.noPool && typeof data.noPool === 'object' ? data.noPool : {}) as SpotMarketSnapshot['noPool'],
    azMeta: (data.azMeta && typeof data.azMeta === 'object' ? data.azMeta : {}) as SpotMarketSnapshot['azMeta'],
    scores: data.scores as SpotMarketSnapshot['scores'],
    azScores: (data.azScores && typeof data.azScores === 'object' ? data.azScores : {}) as SpotMarketSnapshot['azScores'],
    prices: data.prices as SpotMarketSnapshot['prices'],
    azPrice: (data.azPrice && typeof data.azPrice === 'object' ? data.azPrice : {}) as SpotMarketSnapshot['azPrice'],
  };
}

export function createSpotPlacementFeedPort(config: SpotPlacementFeedConfig = {}): SpotPlacementFeedPort {
  const feedUrl = config.feedUrl ?? DEFAULT_SPOT_FEED_URL;
  const parsed = new URL(feedUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Spot placement feed URL must use HTTPS');
  }
  const cacheTtlMs = config.cacheTtlMs ?? 15 * 60_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;

  let cached: { snapshot: SpotMarketSnapshot; fetchedAtMs: number } | null = null;

  return {
    async getSnapshot(signal?: AbortSignal): Promise<SpotMarketSnapshot | null> {
      const currentMs = now();
      if (cached && currentMs - cached.fetchedAtMs < cacheTtlMs) {
        return cached.snapshot;
      }
      try {
        const res = await fetchImpl(feedUrl, {
          method: 'GET',
          redirect: 'error',
          headers: { accept: 'application/json', 'user-agent': 'project-hivemind-spot-router' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          return cached?.snapshot ?? null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > MAX_FEED_BYTES) {
          throw new Error('Spot feed exceeded maximum allowed payload size');
        }
        const json = JSON.parse(Buffer.from(buf).toString('utf8')) as unknown;
        const snapshot = parseSpotMarketSnapshot(json);
        cached = { snapshot, fetchedAtMs: currentMs };
        return snapshot;
      } catch {
        // Graceful degradation: return last cached snapshot (staleness checked in core policy) or null -> primaryRegion fallback.
        return cached?.snapshot ?? null;
      }
    },
  };
}
