import type {WorkflowRecord} from './workflow.ts';
export type Provider = 'codex' | 'claude';
export interface SourceFile { path: string; content: string; sha256: string; executable: boolean }
export interface Snapshot { version: 1; digest: string; files: SourceFile[] }
export interface CheckSpec { id: string; argv: string[]; timeoutMs: number }
export interface JobSpec {
  provider: Provider;
  credentialId: string;
  snapshotId: string;
  instructions: string;
  checks: CheckSpec[];
  timeoutMs: number;
  idempotencyKey: string;
}
export type Status = 'QUEUED' | 'STARTING' | 'RUNNING' | 'VERIFYING' | 'SAVING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLING' | 'CANCELLED' | 'TIMED_OUT' | 'NEEDS_REAUTH' | 'AUTH_SYNC_FAILED';
export interface RalphPolicy { maxRounds: number; writes: string[] }
export interface RalphRound { round: number; sessionId: string; snapshotId: string; accepted: boolean; startedAt: number; finishedAt: number }
export interface RalphCheckpoint { round: number; sessionId: string; snapshot: Snapshot }
export interface RalphFeedback { accepted: boolean; message: string }
export interface RalphCheckRecord {round:number;sessionId:string;snapshotId:string;checkIds:string[];rejected?:boolean}
export interface JobRecord {
  id: string; attempt: string; kind: 'agent' | 'compute'; provider?: Provider;
  credentialId?: string; credentialGeneration?: number; parentId?: string; checkId?: string;
  snapshotId: string; outputSnapshotId?: string; status: Status;
  instructions?: string; argv?: string[]; checks: CheckSpec[]; childIds: string[];
  createdAt: number; startedAt?: number; finishedAt?: number; deadline: number;
  timeoutMs: number; containerStopped: boolean; authSynced: boolean;
  errorCode?: string; resultKey?: string; cancellationRequested?: boolean;
  ralph?: RalphPolicy;
  checkpoint?: RalphCheckRecord;
  checkpointHistory?: RalphCheckRecord[];
}
export interface CredentialRecord { id: string; provider: Provider; generation: number; objectKey: string; quarantined: boolean; activeJobId?: string }
export interface SchedulerState { version: 1; jobs: Record<string,JobRecord>; credentials: Record<string,CredentialRecord>; idempotency: Record<string,{fingerprint:string;jobId:string}>; workflows?: Record<string,WorkflowRecord> }
export interface SealedAuth { version: 1; wrappedKey: string; iv: string; tag: string; ciphertext: string }
export interface ProcessResult { status: 'passed' | 'failed' | 'timed_out' | 'error' | 'not_run'; exitCode: number|null; stdout: string; stderr: string; durationMs: number; truncated: boolean; startedAt?: number; finishedAt?: number }
export interface RuntimeInput {
  version: 1; jobId: string; attempt: string; mode: 'agent'|'compute';
  provider?: Provider; instructions?: string; snapshot: Snapshot; argv?: string[];
  timeoutMs: number; auth?: string; authReturnPublicKey?: string; claudeNestedCompatible?: boolean;
  ralph?: RalphPolicy & { token:string };
}
export interface RuntimeResult {
  version: 1; jobId: string; attempt: string; inputSnapshotId: string;
  process: ProcessResult; snapshot?: Snapshot; summary: string;
  sandboxReceipts?: {sessionId:string;agentId:string|null;toolUseId:string;commandHash:string;timestamp:string}[];
  mcpReceipts?: {callId:string;nonce:string;marker:'hivemind-phase0-mcp-v1'}[];
  errorCode?: 'NEEDS_REAUTH';
  authReturn?: SealedAuth; sourceUnchanged: boolean; credentialsAbsent?: boolean;
  provider?: Provider; sessionId?: string; usage?: Record<string,number>; subagentReceipts?: unknown[];
  boundary?: {platform:string;checkedAt:string;capabilities:Record<string,string>;noNewPrivs:number;verified:boolean};
  ralphRounds?: RalphRound[];
  sandboxPolicy: 'codex-workspace'|'claude-nested-compatible'|'claude-strict'|'compute-workspace';
}
export const terminal = (status: Status) => ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED'].includes(status);
