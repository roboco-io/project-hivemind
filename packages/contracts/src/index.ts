export type TaskStatus = 'awaiting_execution_approval' | 'queued' | 'running' | 'awaiting_review' | 'completed' | 'rejected' | 'cancelled' | 'failed';
export type Provider = 'mock' | 'codex' | 'claude';
export type Runtime = 'local' | 'ecs' | 'cloudflare';
export interface CreateTask {
  title: string;
  instructions: string;
  budgetMicros: number;
  provider: Provider;
  runtime: Runtime;
}
export interface Task extends CreateTask {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  workerId: string | null;
  leaseExpiresAt: number | null;
  estimatedCostMicros: number;
  actualCostMicros: number;
  diff: string | null;
  summary: string | null;
}
export interface Worker {
  id: string;
  provider: Provider;
  runtime: Runtime;
  lastSeenAt: string;
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
export interface RunResult { summary: string; diff: string; actualCostMicros: number }
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
