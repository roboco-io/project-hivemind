export type RolloutReceipt = {
  id: string | null; source: unknown; forkedFromId: string | null;
  fileThreadId?: string | null; storageThreadId?: string | null; storageSource?: unknown;
  rolloutFile?: string;
  lifecycle: { type: string; timestamp: string; turnId?: string }[];
  calls: { name: string; callId: string; timestamp: string }[];
  spawnReturns: { callId: string; agentId: string; timestamp: string }[];
  malformedRows: number;
};

export function summarizeRollout(text: string): RolloutReceipt {
  const result: RolloutReceipt = { id: null, source: null, forkedFromId: null, lifecycle: [], calls: [], spawnReturns: [], malformedRows: 0 };
  const spawnCalls = new Set<string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { result.malformedRows++; continue; }
    const payload = row.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (row.type === 'session_meta') {
      result.id = typeof payload.id === 'string' ? payload.id : null;
      result.source = payload.source ?? null;
      result.forkedFromId = payload.forked_from_id ?? null;
    }
    if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
      result.lifecycle.push({ type: payload.type, timestamp: row.timestamp, turnId: payload.turn_id });
    }
    if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type) && typeof payload.name === 'string') {
      result.calls.push({ name: payload.name, callId: payload.call_id, timestamp: row.timestamp });
      if (payload.name === 'spawn_agent' || payload.name.endsWith('.spawn_agent')) spawnCalls.add(payload.call_id);
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type) && spawnCalls.has(payload.call_id)) {
      try {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output);
        const ids = new Set<string>(output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []);
        for (const agentId of ids) if (agentId !== result.id) result.spawnReturns.push({ callId: payload.call_id, agentId, timestamp: row.timestamp });
      } catch { /* Never export raw tool output or prompt contents. */ }
    }
  }
  return result;
}
