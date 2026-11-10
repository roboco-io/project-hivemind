import type { CreateTask, HiveEvent, ProcessEvidence, RepositoryPolicy, Task } from './index.js';

export type CloudProcess = Omit<ProcessEvidence, 'command'>;
export interface CloudCheck {
  id: string; name: string; status: string; command: string[]; process: CloudProcess | null;
  credentialsAbsent: boolean | null; sourceUnchanged: boolean | null;
}
export interface CloudEvidence {
  phase: string; jobId: string | null; inputSnapshotId: string | null; outputSnapshotId: string | null;
  containerStopped: boolean; authSynced: boolean; agent: CloudProcess | null; checks: CloudCheck[]; errorCode: string | null;
}
export interface CloudTask extends Task {
  provider: 'codex' | 'claude'; runtime: 'cloudflare'; remote: CloudEvidence;
  worktreePath: string | null; diffTruncated: boolean; execution: null;
}
export interface CloudConnection { status: 'checking' | 'ready' | 'unavailable'; message: string | null; checkedAt: string | null }
export interface CloudCapabilities { providers: Array<'codex' | 'claude'>; repository: RepositoryPolicy; connection: CloudConnection }
export interface CloudState { tasks: CloudTask[]; events: HiveEvent[]; connection: CloudConnection }
/** Private durable dispatch data. Never return this object to the browser. */
export interface CloudSubmission { snapshot: unknown; spec: Record<string, unknown>; worktreePath: string }
export interface CloudPrivateTask { task: CloudTask; submission: CloudSubmission | null; cancelRequested: boolean }
export interface CloudPort {
  connection(): Promise<CloudConnection>;
  prepare(task: CloudTask): Promise<CloudSubmission>;
  submit(submission: CloudSubmission): Promise<string>;
  poll(jobId: string, submission: CloudSubmission): Promise<CloudPoll>;
  cancel(jobId: string): Promise<void>;
}
export interface CloudPoll {
  phase: string; terminal: boolean; success: boolean; cancelled: boolean; evidence: CloudEvidence;
  summary: string | null; diff: string | null; diffTruncated: boolean;
}
export interface CloudControl {
  capabilities(): CloudCapabilities; state(): CloudState; create(input: CreateTask): CloudTask;
  decision(id: string, decision: string, reason: string): CloudTask;
  cancel(id: string, reason: string): CloudTask;
  tick(): Promise<void>; start(): void; close(): Promise<void>;
}
