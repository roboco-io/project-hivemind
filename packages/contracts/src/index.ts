export type TaskStatus = 'awaiting_execution_approval' | 'queued' | 'running' | 'awaiting_review' | 'completed' | 'rejected' | 'cancelled' | 'failed';
export type Provider = 'mock' | 'codex' | 'claude';
export type Runtime = 'local' | 'ecs' | 'cloudflare';
export interface CreateTask {
  title: string;
  instructions: string;
  budgetMicros: number;
  provider: Provider;
  runtime: Runtime;
  repositoryId?: string;
  baseCommit?: string;
  testProfile?: string;
}
export interface Task extends CreateTask {
  testCommand?: string[];
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  workerId: string | null;
  leaseExpiresAt: number | null;
  estimatedCostMicros: number | null;
  actualCostMicros: number | null;
  diff: string | null;
  summary: string | null;
  execution?: ExecutionEvidence | null;
}
export interface Worker {
  id: string;
  provider: Provider;
  runtime: Runtime;
  lastSeenAt: string;
  repositoryId?: string;
}
export interface HiveEvent {
  sequence: number;
  taskId: string;
  runId: string | null;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
export interface State { tasks: Task[]; workers: Worker[]; events: HiveEvent[] }
export interface Lease { task: Task; leaseToken: string }
export interface ProcessEvidence {
  command: string[];
  status: 'passed' | 'failed' | 'timed_out' | 'error' | 'not_run';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface AgentRunEvidence {
  status: ProcessEvidence['status'];
  exitCode: number | null;
  threadId: string | null;
  model: string | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  stderr: string;
}
export interface ExecutionEvidence {
  repositoryId: string;
  baseCommit: string;
  headCommit: string;
  worktreePath: string;
  diffTruncated: boolean;
  status: 'succeeded' | 'failed';
  setup?: ProcessEvidence;
  tests: ProcessEvidence;
  codex?: AgentRunEvidence;
  claude?: AgentRunEvidence;
}
export interface RepositoryPolicy {
  id: string;
  name: string;
  baseCommit: string;
  testProfile: string;
  testCommand: string[];
}
export interface Capabilities { providers: Provider[]; repository: RepositoryPolicy | null }
export interface RunResult { summary: string; diff: string; actualCostMicros: number | null; execution?: ExecutionEvidence | null }
export interface AgentAdapter {
  readonly provider: Provider;
  execute(task: Task, signal: AbortSignal): Promise<RunResult>;
}
// Target runtime provisioning is a future adapter, not an implemented launcher.
export interface RuntimeDriver {
  readonly runtime: Runtime;
  launch(task: Task): Promise<{ externalRunId: string }>;
  stop(externalRunId: string): Promise<void>;
}
