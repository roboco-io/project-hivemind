import {z} from 'zod';

export const workflowId = z.uuid();
export const workflowDigest = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z.string().min(1).max(512).refine(path =>
  !/[\\\x00-\x1f\x7f]/.test(path) && path === path.normalize('NFC') &&
  !/^[a-z]:/i.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'));
const assignment = z.strictObject({
  instructions: z.string().trim().min(1).max(8000),
  writes: z.array(sourcePath).min(1).max(16),
});
export const workflowDraft = z.strictObject({
  requestId: workflowId,
  title: z.string().trim().min(1).max(160),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  contractPath: sourcePath,
  codex: assignment,
  claude: assignment,
}).refine(value => {
  const paths=[value.contractPath,...value.codex.writes,...value.claude.writes].map(path=>path.toLowerCase());
  return paths.every((path,i)=>paths.slice(i+1).every(other=>path!==other&&!path.startsWith(other+'/')&&!other.startsWith(path+'/')));
},'Contract and worker write paths must be disjoint');
export const workflowApproval = z.strictObject({workflowId, contractHash: workflowDigest});
export type WorkflowDraft = z.infer<typeof workflowDraft>;
export interface WorkflowBinding {
  id: string;
  inputSnapshotId: string;
  contractHash: string;
}
export interface CloudWorkflowPort {
  draft(input: WorkflowDraft, key: string): Promise<WorkflowBinding>;
  approve(binding: WorkflowBinding): Promise<{status: string}>;
  read(binding: WorkflowBinding, result: boolean, includeDiff: boolean): Promise<Record<string, unknown>>;
}
export interface CloudWorkflowControl {
  draft(input: unknown): Promise<Record<string, unknown>>;
  approve(id: string, body: unknown): Promise<Record<string, unknown>>;
  list(): Array<Record<string, unknown>>;
  read(id: string, result: boolean, includeDiff: boolean): Promise<Record<string, unknown>>;
  close(): void;
}

const states = z.enum(['DRAFT','RUNNING','INTEGRATING','SUCCEEDED','FAILED']);
const registered = z.object({
  id: workflowId, title:z.string().max(160), baseCommit:z.string().regex(/^[a-f0-9]{40}$/),
  contractPath:sourcePath, contractHash:workflowDigest, inputSnapshotId:workflowDigest,
  codexWrites:z.array(sourcePath).max(16), claudeWrites:z.array(sourcePath).max(16),
});
const workerPhase = z.enum(['QUEUED','STARTING','RUNNING','VERIFYING','SAVING','SUCCEEDED','FAILED','CANCELLING','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED']);
export const workflowList = z.object({workflows:z.array(registered).max(20)});
export const workflowRegistration = registered.extend({status:states});
export const workflowView = workflowRegistration.extend({
  errorCode:z.string().max(100).nullable(), outputSnapshotId:workflowDigest.nullable(),
  workers:z.array(z.object({
    id:workflowId, provider:z.enum(['codex','claude']), status:workerPhase,
    containerStopped:z.boolean(), authSynced:z.boolean(),
    rounds:z.array(z.object({
      round:z.number().int().min(1).max(4), rejected:z.boolean(),
      checks:z.array(z.object({id:workflowId,status:workerPhase})).max(4),
    })).max(4),
  })).max(2),
  integration:z.object({id:workflowId,status:workerPhase}).nullable(),
  resultReady:z.boolean(),
  workerResults:z.array(z.object({id:workflowId,rounds:z.array(z.object({
    round:z.number().int().min(1).max(4),accepted:z.boolean(),
  })).max(4)})).max(2).optional(),
  verification:z.object({credentialsAbsent:z.boolean().optional(),sourceUnchanged:z.boolean().optional(),
    process:z.object({status:z.string().max(40),exitCode:z.number().int().nullable(),
      durationMs:z.number().int().nonnegative(),stdout:z.string().max(32000),stderr:z.string().max(32000),truncated:z.boolean()}),
  }).nullable().optional(),
  diff:z.string().max(180000).nullable().optional(),
  diffTruncated:z.boolean().optional(),
  actualCostMicros:z.null(),
});
