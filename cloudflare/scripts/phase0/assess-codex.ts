import type { RolloutReceipt } from './rollout-receipts.ts';

type Result = {
  exitCode?: number; timedOut?: boolean; captureLimit?: boolean; containerStopped?: boolean;
  alpha?: string; beta?: string; nonce?: string;
  events?: { event?: { type?: string; thread_id?: string; item?: Record<string, unknown> } }[];
  rolloutReceipts?: RolloutReceipt[];
};

function parentId(source: unknown, depth = 0): string | undefined {
  if (!source || typeof source !== 'object' || depth > 8) return;
  const object = source as Record<string, unknown>;
  if (typeof object.parent_thread_id === 'string') return object.parent_thread_id;
  for (const value of Object.values(object)) {
    const found = parentId(value, depth + 1);
    if (found) return found;
  }
}

function completedIntervals(receipt: RolloutReceipt) {
  const intervals: { id: string; start: number; end: number }[] = [];
  let started: number | undefined;
  for (const mark of receipt.lifecycle) {
    const time = Date.parse(mark.timestamp);
    if (!Number.isFinite(time)) continue;
    if (mark.type === 'task_started') started = time;
    if (mark.type === 'turn_aborted') started = undefined;
    if (mark.type === 'task_complete' && started !== undefined) {
      const id = receipt.storageThreadId ?? receipt.fileThreadId ?? receipt.id;
      if (id && time > started) intervals.push({ id, start: started, end: time });
      started = undefined;
    }
  }
  return intervals;
}

export function assessCodexFixture(result: Result) {
  const events = result.events ?? [];
  const mcpVerified = events.some(({ event }) => {
    const item = event?.item;
    if (event?.type !== 'item.completed' || item?.type !== 'mcp_tool_call' || item.server !== 'phase0' || item.tool !== 'phase0_probe' || item.status !== 'completed' || item.error != null) return false;
    const returned = item.result as { structured_content?: { nonce?: string; marker?: string } } | undefined;
    return Boolean(result.nonce) && returned?.structured_content?.nonce === result.nonce && returned?.structured_content?.marker === 'hivemind-phase0-mcp-v1';
  });
  const cliSucceeded = result.exitCode === 0 && result.timedOut === false && result.captureLimit !== true;
  const filesVerified = result.alpha === 'ALPHA_HIVEMIND\n' && result.beta === 'BETA_HIVEMIND\n';
  const turnCompleted = events.some(({ event }) => event?.type === 'turn.completed');
  const rootId = events.find(({ event }) => event?.type === 'thread.started')?.event?.thread_id;
  const receipts = result.rolloutReceipts ?? [];
  const threadId = (receipt: RolloutReceipt) => receipt.storageThreadId ?? receipt.fileThreadId ?? receipt.id;
  const spawned = new Set(receipts.find(receipt => threadId(receipt) === rootId)?.spawnReturns.map(spawn => spawn.agentId) ?? []);
  const childIntervals = rootId ? receipts.filter(receipt => threadId(receipt) && threadId(receipt) !== rootId && receipt.malformedRows === 0 &&
    (parentId(receipt.storageSource ?? receipt.source) === rootId || receipt.forkedFromId === rootId || spawned.has(threadId(receipt)!)))
    .flatMap(completedIntervals) : [];
  let parallelEvidence: { threadIds: string[]; start: string; end: string; overlapMs: number } | null = null;
  for (const a of childIntervals) for (const b of childIntervals) {
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
    if (!parallelEvidence && a.id !== b.id && start < end) {
      parallelEvidence = { threadIds: [a.id, b.id], start: new Date(start).toISOString(), end: new Date(end).toISOString(), overlapMs: end - start };
    }
  }
  const parallelSubagentsVerified = parallelEvidence !== null;
  return { passed: cliSucceeded && filesVerified && turnCompleted && mcpVerified && parallelSubagentsVerified && result.containerStopped === true,
    cliSucceeded, filesVerified, turnCompleted, mcpVerified, parallelSubagentsVerified, parallelEvidence };
}
