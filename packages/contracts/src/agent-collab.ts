export type CollabProvider = 'claude' | 'codex';

export type CollabSessionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export type CollabSubtaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type CollabMessageKind = 'chat' | 'handoff' | 'question' | 'blocker' | 'decision' | 'artifact';

export type CollabWorkLogKind = 'progress' | 'checkpoint' | 'artifact' | 'error';

export interface CollabOrchestratorRun {
  runId: string;
  provider: CollabProvider;
  model: string | null;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
}

export interface CollabSession {
  id: string;
  projectId?: string;
  title: string;
  goal: string;
  provider: CollabProvider;
  status: CollabSessionStatus;
  maxParallelWorkers: number;
  allowedRegions: string[];
  repository?: string;
  baseCommit?: string;
  latestOrchestratorRun: CollabOrchestratorRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollabSubtask {
  id: string;
  sessionId: string;
  title: string;
  instructions: string;
  provider: CollabProvider;
  dependsOn: string[];
  status: CollabSubtaskStatus;
  assignedAgentId: string | null;
  region: string | null;
  ecsTaskArn: string | null;
  artifactS3Prefix: string | null;
  resultSummary: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollabMessage {
  id: string;
  sessionId: string;
  seq: number;
  sender: string;
  recipient: string | null;
  threadId: string | null;
  kind: CollabMessageKind;
  body: string;
  artifactRefs: string[];
  createdAt: string;
}

export interface CollabWorkLog {
  id: string;
  sessionId: string;
  subtaskId: string | null;
  agentId: string;
  kind: CollabWorkLogKind;
  summary: string;
  s3Uri: string | null;
  sha256: string | null;
  createdAt: string;
}

export interface CreateCollabSession {
  projectId?: string;
  title: string;
  goal: string;
  provider: CollabProvider;
  maxParallelWorkers?: number;
  allowedRegions?: string[];
  repository?: string;
  baseCommit?: string;
}

export interface CreateCollabSubtask {
  title: string;
  instructions: string;
  provider?: CollabProvider;
  dependsOn?: string[];
  artifactS3Prefix?: string;
}

export interface PostCollabMessage {
  sender: string;
  recipient?: string | null;
  threadId?: string | null;
  kind?: CollabMessageKind;
  body: string;
  artifactRefs?: string[];
}

export interface AppendCollabWorkLog {
  subtaskId?: string | null;
  agentId: string;
  kind: CollabWorkLogKind;
  summary: string;
  s3Uri?: string | null;
  sha256?: string | null;
}

export interface CollabSessionSnapshot {
  storageBackend: 'aurora-dsql' | 'sqlite';
  session: CollabSession;
  subtasks: CollabSubtask[];
  messages: CollabMessage[];
  workLogs: CollabWorkLog[];
}
