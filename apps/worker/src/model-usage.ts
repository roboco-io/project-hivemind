import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryModelUsage } from '../../../packages/contracts/src/delivery.js';
import type { ProcessEvidence } from '../../../packages/contracts/src/index.js';

export type ModelTokenCounts = Pick<DeliveryModelUsage, 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens' | 'reasoningOutputTokens'>;

const EMPTY: ModelTokenCounts = { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null };

async function newestJsonl(dir: string, depth = 0): Promise<{ path: string; mtimeMs: number } | null> {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const found = entry.isDirectory()
      ? await newestJsonl(path, depth + 1)
      : entry.isFile() && entry.name.endsWith('.jsonl')
        ? { path, mtimeMs: (await stat(path)).mtimeMs }
        : null;
    if (found && (!best || found.mtimeMs > best.mtimeMs)) best = found;
  }
  return best;
}

const count = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);

/**
 * Cumulative token usage of the codex session in codexHome, from the last token_count event of the newest
 * session log. The log is written as the model answers, so a run that timed out or was killed still has
 * the usage up to its last model response. Returns null when there is no log or no token_count event.
 */
export async function readCodexSessionUsage(codexHome: string): Promise<ModelTokenCounts | null> {
  const newest = await newestJsonl(join(codexHome, 'sessions'));
  if (!newest) return null;
  const lines = (await readFile(newest.path, 'utf8').catch(() => '')).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('token_count')) continue;
    let event: { payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const total = event.payload?.type === 'token_count' ? event.payload.info?.total_token_usage : undefined;
    if (!total) continue;
    return {
      inputTokens: count(total.input_tokens),
      cachedInputTokens: count(total.cached_input_tokens),
      cacheWriteInputTokens: count(total.cache_write_input_tokens),
      // codex reports total_tokens = input + output, so output already includes the reasoning tokens.
      outputTokens: count(total.output_tokens),
      reasoningOutputTokens: count(total.reasoning_output_tokens),
    };
  }
  return null;
}

export function usageOutcome(status: ProcessEvidence['status']): DeliveryModelUsage['outcome'] {
  if (status === 'passed') return 'completed';
  if (status === 'timed_out') return 'timed_out';
  if (status === 'failed') return 'failed';
  return 'aborted';
}

/** The usage report body for one run. */
export async function buildModelUsageReport(input: {
  provider: DeliveryModelUsage['provider'];
  codexHome: string;
  runId: string;
  iteration: number;
  status: ProcessEvidence['status'];
  durationMs: number;
}): Promise<Omit<DeliveryModelUsage, 'recordedAt' | 'provider'>> {
  const counts = input.provider === 'codex' ? await readCodexSessionUsage(input.codexHome).catch(() => null) : null;
  return {
    runId: input.runId,
    iteration: input.iteration,
    outcome: usageOutcome(input.status),
    ...(counts ?? EMPTY),
    source: counts ? 'codex_session_log' : 'unavailable',
    durationMs: Math.max(0, Math.round(input.durationMs)),
  };
}
