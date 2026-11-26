import {z} from 'zod';
import {TeamBlockInputSchema,TeamReviewInputSchema,TeamTaskInputSchema} from './team.js';

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
export type TeamSection = 'summary'|'tasks'|'events'|'notes';
export const teamPageQuery = z.strictObject({after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),limit:z.number().int().min(1).max(100).optional()});
export type TeamPageQuery = z.infer<typeof teamPageQuery>;
export const teamBlockInput = TeamBlockInputSchema;
export const teamReviewInput = TeamReviewInputSchema;
export type TeamBlockInput = z.infer<typeof teamBlockInput>;
export type TeamReviewInput = z.infer<typeof teamReviewInput>;
export interface CloudWorkflowPort {
  teamRead?(binding: WorkflowBinding, section: TeamSection, query?: TeamPageQuery): Promise<Record<string,unknown>>;
  teamBlock?(binding: WorkflowBinding, input: TeamBlockInput): Promise<Record<string,unknown>>;
  teamReview?(binding: WorkflowBinding, input: TeamReviewInput): Promise<Record<string,unknown>>;
  draft(input: WorkflowDraft, key: string): Promise<WorkflowBinding>;
  approve(binding: WorkflowBinding): Promise<{status: string}>;
  read(binding: WorkflowBinding, result: boolean, includeDiff: boolean): Promise<Record<string, unknown>>;
}
export interface CloudWorkflowControl {
  teamRead?(id: string, section: TeamSection, query?: TeamPageQuery): Promise<Record<string,unknown>>;
  teamBlock?(id: string, input: TeamBlockInput): Promise<Record<string,unknown>>;
  teamReview?(id: string, input: TeamReviewInput): Promise<Record<string,unknown>>;
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

const teamSafeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const teamNumber=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const teamCounts=z.object({pending:teamNumber,claimed:teamNumber,submitted:teamNumber,verified:teamNumber,failed:teamNumber,recovery_required:teamNumber});
export const teamSummaryView=z.object({id:teamSafeId,workflowId,status:z.enum(['active','blocked','completed','expired','failed']),blocked:z.boolean(),recoveryRequired:z.boolean(),taskCounts:teamCounts,block:teamBlockInput.optional(),reviewed:z.boolean(),endsAt:teamNumber});
const teamTaskView=TeamTaskInputSchema.strip().extend({status:z.enum(['pending','claimed','submitted','verified','failed','recovery_required']),evidenceRef:z.string().max(2048).optional()});
const teamEventView=z.object({sequence:teamNumber,at:teamNumber,type:z.string().max(128),taskId:teamSafeId.optional(),source:z.enum(['gateway_observed','worker_report','operator']).optional()});
const teamNoteView=z.object({source:z.literal('worker_report'),sequence:teamNumber,at:teamNumber,memberId:teamSafeId,taskId:teamSafeId.optional(),text:z.string().max(2048)});
export function projectTeamResponse(value:unknown,section:TeamSection|'block'|'review',secrets:string[]=[]):Record<string,unknown>{
  const schema=section==='tasks'?z.object({tasks:z.array(teamTaskView).max(128)}):section==='events'?z.object({events:z.array(teamEventView).max(100),nextAfter:teamNumber.optional()}):section==='notes'?z.object({notes:z.array(teamNoteView).max(100),nextAfter:teamNumber.optional()}):teamSummaryView;
  const parsed=schema.parse(value);
  const clean=(value:unknown):unknown=>{
    if(typeof value==='string'){
      for(const secret of secrets.filter(Boolean))for(const variant of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url'),Buffer.from(secret).toString('hex'),JSON.stringify(secret).slice(1,-1)])value=(value as string).replaceAll(variant,'[REDACTED]');
      return (value as string).replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]').replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|control[_-]?token|operator[_-]?token|authorization|password|secret|capability|lease[_-]?token)\s*[=:]\s*)[^\s,"'}]+/gi,'$1[REDACTED]').replace(/(?:sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g,'[REDACTED]');
    }
    if(Array.isArray(value))return value.map(clean);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,clean(child)]));
    return value;
  };
  return clean(parsed) as Record<string,unknown>;
}
