export type ClaudeAgentReceipt = { event: 'SubagentStart' | 'SubagentStop'; sessionId: string; agentId: string; agentType: string; timestamp: string };

export function claudeAgentReceipt(input: unknown, timestamp: string): ClaudeAgentReceipt | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (!['SubagentStart', 'SubagentStop'].includes(String(value.hook_event_name)) ||
    typeof value.session_id !== 'string' || typeof value.agent_id !== 'string' || value.agent_type !== 'worker' || !Number.isFinite(Date.parse(timestamp))) return null;
  return { event: value.hook_event_name as ClaudeAgentReceipt['event'], sessionId: value.session_id, agentId: value.agent_id, agentType: value.agent_type, timestamp };
}
