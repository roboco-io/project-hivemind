import type {LargeArtifactRef} from './large-artifact.ts';
import type {BenchmarkResources} from './runtime/benchmark-resources.ts';
import type {ComputeGroupRecord} from './compute-group.ts';
import type {TerraLatencyMode} from './terra-latency.ts';
import type {BenchmarkInstance,CarbonCampaign,CarbonEffort,NpmCacheMode} from './carbon-benchmark.ts';
import type {CarbonRuntimeInput,CarbonEvidence} from './runtime/carbon-run.ts';
import type {WorkflowRecord} from './workflow.ts';
export type Provider = 'codex' | 'claude';
export interface SourceFile { path: string; content: string; sha256: string; executable: boolean }
export interface Snapshot { version: 1; digest: string; files: SourceFile[] }
export interface CheckSpec { id: string; argv: string[]; timeoutMs: number }
export interface JobSpec {
  provider: Provider;
  model?:string; effort?:'low'|'medium'|'high'|'xhigh';
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
  createdAt: number; startedAt?: number; runningAt?:number; finishedAt?: number; deadline: number;
  timeoutMs: number; containerStopped: boolean; authSynced: boolean;
  errorCode?: string; resultKey?: string; cancellationRequested?: boolean;
  model?:string; effort?:JobSpec['effort'];
  executionGroup?:{id:string;concurrency:number;instance:'standard-1'|'standard-3'|'standard-4';dependencyNetwork?:boolean};
  largeArtifacts?:LargeArtifactRef[];
  ralph?: RalphPolicy;
  checkpoint?: RalphCheckRecord;
  checkpointHistory?: RalphCheckRecord[];
  carbon?: {campaignId:string;effort:CarbonEffort;probe?:boolean;model?:'terra';instance?:BenchmarkInstance;latency?:TerraLatencyMode;cacheMode?:NpmCacheMode};
}
export interface CredentialRecord { id: string; provider: Provider; generation: number; objectKey: string; quarantined: boolean; activeJobId?: string }
export interface SchedulerState { version: 1; jobs: Record<string,JobRecord>; credentials: Record<string,CredentialRecord>; idempotency: Record<string,{fingerprint:string;jobId:string}>; workflows?: Record<string,WorkflowRecord>; carbonCampaigns?: Record<string,CarbonCampaign>; computeGroups?:Record<string,ComputeGroupRecord> }
export interface SealedAuth { version: 1; wrappedKey: string; iv: string; tag: string; ciphertext: string }
export interface ProcessResult { status: 'passed' | 'failed' | 'timed_out' | 'error' | 'not_run'; exitCode: number|null; signal?:NodeJS.Signals|null; terminationReason?:'exit'|'signal'|'timeout'|'cancelled'|'spawn-error'|'output-limit'|'capture-error'; stdout: string; stderr: string; durationMs: number; truncated: boolean; startedAt?: number; finishedAt?: number }
export interface RuntimeInput {
  version: 1; jobId: string; attempt: string; mode: 'agent'|'compute';
  model?:string; effort?:JobSpec['effort']; resourceMeasurement?:boolean;
  provider?: Provider; instructions?: string; snapshot: Snapshot; argv?: string[];
  timeoutMs: number; auth?: string; authReturnPublicKey?: string; claudeNestedCompatible?: boolean;
  ralph?: RalphPolicy & { token:string };
  largeArtifacts?:{refs:LargeArtifactRef[];capability:string};
  carbon?: CarbonRuntimeInput;
}
export interface ClaudeResultMetrics {
 coverage:'final-result-provider-reported';
 duration_ms?:number; duration_api_ms?:number; num_turns?:number;
 modelUsage?:Record<string,Record<string,number>>;
}
export interface RuntimeResult {
  version: 1; jobId: string; attempt: string; inputSnapshotId: string;
  process: ProcessResult; snapshot?: Snapshot; summary: string;
  sandboxReceipts?: {sessionId:string;agentId:string|null;toolUseId:string;commandHash:string;timestamp:string}[];
  mcpReceipts?: {callId:string;nonce:string;marker:'hivemind-phase0-mcp-v1'}[];
  errorCode?: 'NEEDS_REAUTH';
  authReturn?: SealedAuth; sourceUnchanged: boolean; credentialsAbsent?: boolean;
  provider?: Provider; sessionId?: string; usage?: Record<string,number>; claudeResultMetrics?:ClaudeResultMetrics; subagentReceipts?: unknown[];
  boundary?: {platform:string;checkedAt:string;capabilities:Record<string,string>;noNewPrivs:number;verified:boolean};
  ralphRounds?: RalphRound[];
  carbon?: CarbonEvidence;
  resources?:BenchmarkResources;
  largeArtifacts?:{durationMs:number;receipts:(LargeArtifactRef & {files:number})[]};
  sandboxPolicy: 'codex-workspace'|'claude-nested-compatible'|'claude-strict'|'compute-workspace';
}
export const terminal = (status: Status) => ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED'].includes(status);
