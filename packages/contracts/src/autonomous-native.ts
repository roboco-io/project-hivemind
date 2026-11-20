import type {AutonomousLease,AutonomousQuotaProof} from './autonomous.js';

/** Private runtime wire only. Never include subscriptionAuth or session data in public results. */
export interface NativeSnapshot {
  version: 1;
  digest: string;
  files: {path: string; content: string; sha256: string; executable: boolean}[];
}
export interface NativeClaudeSession {sessionId: string; model: string; sequence: number; data: unknown}
export interface NativeClaudeRequest {
  version: 1; taskId: string; executionLease: AutonomousLease; model: string; subagentModel?: string;
  web?:{allowedHosts:string[]}; externalProfiles?:string[];
  tools: string[]; goal: string; session: NativeClaudeSession;
  subscriptionAuth: string; maxRunMs: number; initialSnapshot?: NativeSnapshot;
}
export interface NativeClaudeResponse {
  version: 1; session: NativeClaudeSession;
  quota?:AutonomousQuotaProof;
  /** When true, all usage numbers are unmeasured zero placeholders. */
  usageUnavailable?:true;
  usage: {inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number};
  outcome: 'continue'|'complete'|'wait'|'input'|'failed'; wakeAt?: number;
  boundary: {platform: 'linux'; verified: true; noNewPrivs: 1; capabilitiesDropped: true};
}
export interface NativeClaudeRuntimePort {
  execute(request: NativeClaudeRequest, signal: AbortSignal): Promise<NativeClaudeResponse>;
}
