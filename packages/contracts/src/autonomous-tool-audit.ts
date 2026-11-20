/** Worker-reported tool-call audit records. The worker reports them; they are not independent proof. */
export interface ToolAuditRecord {
  sequence: number; tool: string; inputDigest: string; inputSummary: string; inputTruncated: boolean;
  outcome: 'allowed' | 'denied' | 'error'; startedAt: number; durationMs: number | null; subagent?: true;
}
export interface StoredToolAuditRecord extends ToolAuditRecord {
  runId: string; iteration: number; receivedAt: number; source: 'worker_report';
}
export interface ToolAuditTotals {
  recorded: number; denied: number; errors: number; droppedByWorker: number; droppedByStore: number;
}
export const TOOL_AUDIT_LIMITS = {
  recordBytes: 1024, summaryBytes: 512, batchRecords: 32, taskRecords: 20000,
  taskBytes: 16 * 1024 * 1024, spoolBytes: 8 * 1024 * 1024
} as const;
