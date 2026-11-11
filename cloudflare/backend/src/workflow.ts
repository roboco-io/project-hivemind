import type {CheckSpec, JobSpec, Snapshot, SourceFile} from './contracts.ts';
import {terminal} from './contracts.ts';
import {SchedulerError, validateJobSpec} from './scheduler.ts';
import {canonicalSourcePath, createSnapshot, sha256} from './snapshot.ts';

export interface WorkflowWorker extends Omit<JobSpec, 'snapshotId' | 'idempotencyKey'> {
  writes: string[];
}
export interface WorkflowSpec {
  snapshotId: string;
  contractPath: string;
  contractHash: string;
  idempotencyKey: string;
  workers: [WorkflowWorker, WorkflowWorker];
  integration: CheckSpec;
}
export interface WorkflowRecord {
  id: string;
  spec: WorkflowSpec;
  status: 'DRAFT' | 'RUNNING' | 'INTEGRATING' | 'SUCCEEDED' | 'FAILED';
  createdAt: number;
  approvedAt?: number;
  deadline?: number;
  finishedAt?: number;
  workerIds?: [string, string];
  integrationId?: string;
  outputSnapshotId?: string;
  errorCode?: string;
}
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    throw new SchedulerError('Invalid workflow fields', 400);
  }
  return value as Record<string, unknown>;
}
export function validateWorkflowSpec(value: unknown): WorkflowSpec {
  const raw = object(value, ['snapshotId','contractPath','contractHash','idempotencyKey','workers','integration']);
  if (!Array.isArray(raw.workers) || raw.workers.length !== 2 ||
      typeof raw.contractHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contractHash)) {
    throw new SchedulerError('Expected a contract hash and exactly two workers', 400);
  }
  const contractPath = canonicalSourcePath(raw.contractPath);
  const workers = raw.workers.map(value => {
    const {writes, ...worker} = object(value, ['provider','credentialId','instructions','checks','timeoutMs','writes']);
    const {snapshotId: _snapshot, idempotencyKey: _key, ...job} =
      validateJobSpec({...worker, snapshotId:raw.snapshotId, idempotencyKey:raw.idempotencyKey});
    if (!Array.isArray(writes) || writes.length < 1 || writes.length > 32) {
      throw new SchedulerError('Expected one to thirty-two write paths', 400);
    }
    return {...job, writes:writes.map(canonicalSourcePath).sort()};
  }) as [WorkflowWorker, WorkflowWorker];
  const paths = [contractPath, ...workers.flatMap(worker => worker.writes)].map(path => path.toLowerCase()).sort();
  if (workers[0].provider === workers[1].provider ||
      workers[0].credentialId === workers[1].credentialId ||
      paths.some((path, i) => paths.slice(i + 1).some(other => other === path || other.startsWith(path + '/')))) {
    throw new SchedulerError('Workers must use distinct providers and disjoint write paths', 400);
  }
  const {writes: _writes, ...integrationJob} = workers[0];
  const integration = validateJobSpec({...integrationJob, checks:[raw.integration],
    snapshotId:raw.snapshotId, idempotencyKey:raw.idempotencyKey,
  }).checks[0]!;
  return {snapshotId:raw.snapshotId as string, contractPath, contractHash:raw.contractHash,
    idempotencyKey:raw.idempotencyKey as string, workers, integration};
}
export function workflowFingerprint(spec: WorkflowSpec): string {
  return sha256(JSON.stringify(spec));
}
function sameFile(a: SourceFile | undefined, b: SourceFile | undefined): boolean {
  return a?.sha256 === b?.sha256 && a?.executable === b?.executable;
}
export function changedPaths(base: Snapshot, output: Snapshot): string[] {
  const before = new Map(base.files.map(file => [file.path, file]));
  const after = new Map(output.files.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => !sameFile(before.get(path), after.get(path)));
}
export function mergeWorkflowOutputs(base: Snapshot, outputs: Snapshot[], scopes: string[][]): Snapshot {
  const merged = new Map(base.files.map(file => [file.path, file]));
  const claimed = new Set<string>();
  if (outputs.length !== 2 || scopes.length !== outputs.length) throw new Error('Invalid merge input');
  outputs.forEach((output, i) => {
    const allowed = new Set(scopes[i]);
    const after = new Map(output.files.map(file => [file.path, file]));
    const changed = changedPaths(base, output);
    if (!changed.length) throw new Error('Worker produced no changes');
    for (const path of changed) {
      const key = path.toLowerCase();
      if (!allowed.has(path) || claimed.has(key)) throw new Error('Worker changed a path outside its write scope');
      claimed.add(key);
      const file = after.get(path);
      if (file) merged.set(path, file);
      else merged.delete(path);
    }
  });
  return createSnapshot([...merged.values()]);
}

export async function advanceWorkflow(
  workflow: WorkflowRecord,
  scheduler: import('./scheduler.ts').Scheduler,
  artifacts: {read(id: string): Promise<Snapshot>; write(snapshot: Snapshot): Promise<unknown>},
  now: number,
): Promise<void> {
  if ((workflow.status === 'RUNNING' || workflow.status === 'INTEGRATING') &&
      workflow.deadline !== undefined && now >= workflow.deadline) {
    const ids = [...(workflow.workerIds ?? []), ...(workflow.integrationId ? [workflow.integrationId] : [])];
    for (const id of ids) scheduler.requestCancel(id, now);
    if (ids.every(id => {
      const job = scheduler.get(id);
      return terminal(job.status) && job.containerStopped &&
        (job.checkpoint?.checkIds ?? []).every(checkId => scheduler.get(checkId).containerStopped);
    })) Object.assign(workflow, {status:'FAILED', errorCode:'WORKFLOW_DEADLINE', finishedAt:now});
    return;
  }
  if (workflow.status === 'RUNNING') {
    const workers = workflow.workerIds!.map(id => scheduler.get(id));
    if (workers.some(job => !terminal(job.status) || !job.containerStopped)) return;
    if (workers.some(job => job.status !== 'SUCCEEDED' || !job.outputSnapshotId || !job.authSynced)) {
      Object.assign(workflow, {status:'FAILED', errorCode:'WORKER_FAILED', finishedAt:now});
      return;
    }
    const [base,...outputs] = await Promise.all([workflow.spec.snapshotId,...workers.map(job => job.outputSnapshotId!)].map(id => artifacts.read(id)));
    let merged: Snapshot;
    try {
      merged = mergeWorkflowOutputs(base!, outputs, workflow.spec.workers.map(worker => worker.writes));
    } catch {
      Object.assign(workflow, {status:'FAILED', errorCode:'MERGE_SCOPE_INVALID', finishedAt:now});
      return;
    }
    await artifacts.write(merged);
    const integration = scheduler.enqueueCompute(merged.digest, workflow.spec.integration, now);
    Object.assign(workflow, {status:'INTEGRATING', outputSnapshotId:merged.digest, integrationId:integration.id});
  } else if (workflow.status === 'INTEGRATING') {
    const integration = scheduler.get(workflow.integrationId!);
    if (!terminal(integration.status) || !integration.containerStopped) return;
    Object.assign(workflow, integration.status === 'SUCCEEDED' && integration.snapshotId === workflow.outputSnapshotId
      ? {status:'SUCCEEDED', finishedAt:now}
      : {status:'FAILED', errorCode:'INTEGRATION_CHECK_FAILED', finishedAt:now});
  }
}
