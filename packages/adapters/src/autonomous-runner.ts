import { randomUUID } from 'node:crypto';
import type { AutonomousAction, AutonomousActionRequest, AutonomousCheckpoint, AutonomousLease, AutonomousRunResult, AutonomousResource, AutonomousSpec, AutonomousTask, AutonomousWorkerState } from '../../contracts/src/autonomous.js';

export class UnsupportedAutonomousCapabilityError extends Error {
  readonly code = 'NOT_SUPPORTED';
  constructor(capability: string) { super(`NOT_SUPPORTED: ${capability}`); this.name = 'UnsupportedAutonomousCapabilityError'; }
}
export interface PrivateSession {
  sessionId: string;
  model: string;
  sequence: number;
  data: unknown;
}
export interface PrivateSessionStore {
  readonly durable?: boolean;
  load(taskId: string, checkpoint: AutonomousCheckpoint): Promise<PrivateSession | undefined>;
  save(taskId: string, session: PrivateSession): Promise<AutonomousCheckpoint>;
}
/** Synthetic/local storage only. Reuse this instance across runner restarts.
 * Native providers need a durable private artifact store, including session content. */
export class MemorySessionStore implements PrivateSessionStore {
  readonly synthetic = true;
  private readonly entries = new Map<string, {taskId: string; session: PrivateSession}>();
  async load(taskId: string, checkpoint: AutonomousCheckpoint): Promise<PrivateSession | undefined> {
    const entry = this.entries.get(checkpoint.objectKey);
    if (!entry || entry.taskId !== taskId || entry.session.sessionId !== checkpoint.sessionId || entry.session.model !== checkpoint.model || entry.session.sequence !== checkpoint.sequence) return undefined;
    return structuredClone(entry.session);
  }
  async save(taskId: string, session: PrivateSession): Promise<AutonomousCheckpoint> {
    const objectKey = `private/${randomUUID()}`;
    this.entries.set(objectKey, {taskId, session: structuredClone(session)});
    return {objectKey, sessionId: session.sessionId, model: session.model, sequence: session.sequence};
  }
}
export type {AutonomousWorkerState} from '../../contracts/src/autonomous.js';
export interface AutonomousWorkerClient {
  workerState?(taskId: string, signal?: AbortSignal): Promise<AutonomousWorkerState>;
  claim(taskId: string, workerId: string, signal?: AbortSignal): Promise<{task: AutonomousTask; lease: AutonomousLease} | null>;
  heartbeat(lease: AutonomousLease, signal?: AbortSignal): Promise<AutonomousLease>;
  finish(lease: AutonomousLease, result: AutonomousRunResult, signal?: AbortSignal): Promise<unknown>;
  reserve(lease: AutonomousLease, request: AutonomousActionRequest, signal?: AbortSignal): Promise<AutonomousAction>;
  settle(lease: AutonomousLease, actionId: string, actualCostMicros: number, success: boolean, resource?: {id: string; system: string; cleanupOperation: string}, signal?: AbortSignal): Promise<AutonomousAction>;
}
/** Cancellation must settle locally even if an injected capability ignores its signal. */
async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve,reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
  });
  try { return await Promise.race([operation(),cancelled]); }
  finally { signal.removeEventListener('abort',abort); }
}
async function boundedJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)) {
    void response.body?.cancel().catch(()=>{});
    throw Error('Autonomous response too large');
  }
  const reader=response.body?.getReader();
  if(!reader)throw Error('Invalid autonomous response');
  const chunks:Uint8Array[]=[];let size=0,complete=false;
  try {
    for(;;){
      const {done,value}=await abortable(()=>reader.read(),signal);
      if(done){complete=true;break;}
      size+=value.byteLength;
      if(size>limit)throw Error('Autonomous response too large');
      chunks.push(value);
    }
  } finally {
    if(!complete)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw Error('Invalid autonomous response');}
}
function workerStateDto(value: unknown, id: string): AutonomousWorkerState {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid worker state');
  const state=value as AutonomousWorkerState;
  if(Object.keys(state).some(key=>!['taskId','status','endsAt','nextRunAt','iteration'].includes(key))||state.taskId!==id||
    !['awaiting_approval','ready','running','waiting','awaiting_input','stopping','completed','cancelled','budget_exceeded','expired','failed'].includes(state.status)||
    !Number.isSafeInteger(state.endsAt)||state.endsAt<0||!Number.isSafeInteger(state.iteration)||state.iteration<0||
    (state.nextRunAt!==undefined&&(!Number.isSafeInteger(state.nextRunAt)||state.nextRunAt<0)))throw Error('Invalid worker state');
  return state;
}
/** Worker transport intentionally has no operator reads, approval or cleanup confirmation. */
export function createAutonomousHttpClient(options: {apiUrl: string; workerToken: string; fetchImpl?: typeof fetch}): AutonomousWorkerClient {
  const base = options.apiUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  async function post<T>(taskId: string, operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await abortable(()=>fetchImpl(`${base}/v1/autonomous-tasks/${encodeURIComponent(taskId)}/${operation}`, {
      method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', authorization: `Bearer ${options.workerToken}`}, body: JSON.stringify(body), signal,
    }),signal);
    // Do not echo server bodies: they are untrusted and may include secrets.
    if (!response.ok) throw new Error(`Autonomous ${operation} rejected (${response.status})`);
    return await boundedJson(response,2*1024*1024,signal) as T;
  }
  return {
    workerState: async (id, signal) => {
      const response = await abortable(()=>fetchImpl(`${base}/v1/autonomous-tasks/${encodeURIComponent(id)}/worker-state`, {
        method: 'GET', headers: {authorization: `Bearer ${options.workerToken}`}, redirect: 'error', signal,
      }),signal);
      if (!response.ok) throw new Error(`Autonomous worker-state rejected (${response.status})`);
      return workerStateDto(await boundedJson(response,4096,signal),id);
    },
    claim: (id, workerId, signal) => post(id, 'claim', {workerId}, signal),
    heartbeat: (lease, signal) => post(lease.taskId, 'heartbeat', {lease}, signal),
    finish: (lease, result, signal) => post(lease.taskId, 'finish', {lease, result}, signal),
    reserve: (lease, request, signal) => post(lease.taskId, 'reserve', {lease, request}, signal),
    settle: (lease, actionId, actualCostMicros, success, resource, signal) => post(lease.taskId, 'settle', {lease, actionId, actualCostMicros, success, resource}, signal),
  };
}
export interface AutonomousExecutionContext {
  taskId: string;
  executionLease: AutonomousLease;
  spec: Readonly<AutonomousSpec>;
  model: string;
  subagentModel?: string;
  session: PrivateSession;
  credentials: Readonly<Record<string, string>>;
  signal: AbortSignal;
  actions: {
    reserve(request: AutonomousActionRequest): Promise<AutonomousAction>;
    settle(actionId: string, actualCostMicros: number, success: boolean, resource?: {id: string; system: string; cleanupOperation: string}): Promise<AutonomousAction>;
  };
}
export type AutonomousExecutor = (context: AutonomousExecutionContext) => Promise<Omit<AutonomousRunResult, 'checkpoint'> & {session: PrivateSession}>;
export interface AutonomousIterationOptions {
  client: AutonomousWorkerClient;
  taskId: string;
  workerId: string;
  sessions: PrivateSessionStore;
  executor?: AutonomousExecutor;
  /** Trusted adapter assertion, not a sandbox. Never set for an arbitrary Bash executor.
   * Native adapters must enforce tools/systems, durable artifact restore and real billing. */
  nativeCapabilities?: {approvedPolicyEnforced: boolean; privateSessionRestore: boolean};
  resolveCredentials?: (ids: readonly string[], signal: AbortSignal) => Promise<Record<string, string>>;
  heartbeatMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export async function runAutonomousIteration(options: AutonomousIterationOptions): Promise<boolean> {
  options.signal?.throwIfAborted();
  const claimed = await abortable(()=>options.client.claim(options.taskId, options.workerId, options.signal),options.signal);
  if (!claimed) return false;
  const {task} = claimed;
  let lease = claimed.lease;
  const now = options.now ?? Date.now;
  // Policy comes only from the authenticated claim, never an operator GET.
  if (task.status !== 'running' && task.status !== 'ready') return false;
  if (task.nextRunAt !== undefined && task.nextRunAt > now()) return false;
  try {
    if (!options.executor) throw new UnsupportedAutonomousCapabilityError('explicit executor required');
    if (task.spec.provider !== 'mock' && (!options.nativeCapabilities?.approvedPolicyEnforced || !options.nativeCapabilities.privateSessionRestore || options.sessions.durable !== true || options.sessions instanceof MemorySessionStore)) {
      throw new UnsupportedAutonomousCapabilityError('native policy enforcement and durable private session restore required');
    }
    if (task.spec.credentialIds.length && !options.resolveCredentials) throw new UnsupportedAutonomousCapabilityError('scoped credential resolver required');
  } catch(error) {
    // No credential resolution, session capability or executor has run. Report only this
    // provable zero execution; later failures must retain unknown billing semantics.
    try {
      await options.client.finish(lease,{outcome:'failed',usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},costMicros:0,message:'Preflight rejected before credential resolution or executor invocation'},options.signal);
    } catch(finishError) {
      if(error instanceof Error)Object.defineProperty(error,'cause',{value:finishError,configurable:true});
    }
    throw error;
  }
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', relayAbort, {once:true});
  if (options.signal?.aborted) relayAbort();
  const remaining = Math.min(task.spec.endsAt, now() + task.spec.maxRunMs) - now();
  if (remaining <= 0) { options.signal?.removeEventListener('abort', relayAbort); throw new Error('Autonomous execution deadline expired'); }
  const deadline = setTimeout(() => controller.abort(new Error('Autonomous execution deadline expired')), remaining);
  const interval = options.heartbeatMs ?? Math.max(1, Math.floor(Math.min(remaining, lease.expiresAt - now()) / 3));
  if (!Number.isFinite(interval) || interval <= 0) {clearTimeout(deadline);options.signal?.removeEventListener('abort', relayAbort);throw new Error('Invalid heartbeat interval');}
  let leaseExpiry: ReturnType<typeof setTimeout> | undefined;
  const armLease = () => {
    if (leaseExpiry) clearTimeout(leaseExpiry);
    const delay = lease.expiresAt - now();
    if (delay <= 0) {controller.abort(new Error('Autonomous lease expired'));return;}
    leaseExpiry = setTimeout(() => controller.abort(new Error('Autonomous lease expired')),delay);
  };
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let pendingHeartbeat: Promise<void> | undefined;
  const beat = () => {
    heartbeat = setTimeout(() => {
      pendingHeartbeat = options.client.heartbeat(lease, controller.signal).then(updated => {
        if (updated.taskId !== lease.taskId || updated.runId !== lease.runId || updated.workerId !== lease.workerId || updated.token !== lease.token || updated.expiresAt <= now()) throw new Error('Invalid heartbeat lease');
        lease = updated;
        armLease();
        if (!controller.signal.aborted) beat();
      }).catch(() => { controller.abort(new Error('Autonomous heartbeat rejected')); });
    }, options.heartbeatMs ?? Math.max(1, Math.floor(Math.min(remaining, lease.expiresAt - now()) / 3)));
  };
  // Race every asynchronous capability with cancellation, even if an adapter ignores its signal.
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, {once:true});
    });
    try { return await Promise.race([Promise.resolve().then(() => {controller.signal.throwIfAborted();return operation();}), aborted]); }
    finally { if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); }
  };
  let credentials: Record<string, string> = {};
  try {
    armLease();
    beat();
    let session: PrivateSession;
    if (task.checkpoint) {
      const restored = await guarded(() => options.sessions.load(task.id, task.checkpoint!));
      if (!restored || restored.model !== task.spec.model || restored.sessionId !== task.checkpoint.sessionId || restored.sequence !== task.checkpoint.sequence) throw new UnsupportedAutonomousCapabilityError('exact private session artifact unavailable');
      session = restored;
    } else session = {sessionId: randomUUID(), model: task.spec.model, sequence: 0, data: null};
    if (task.spec.credentialIds.length) credentials = await guarded(() => options.resolveCredentials!(task.spec.credentialIds, controller.signal));
    const result = await guarded(() => options.executor!({
      taskId: task.id, executionLease: structuredClone(lease), spec: structuredClone(task.spec), model: task.spec.model, subagentModel: task.spec.subagentModel,
      session: structuredClone(session), credentials, signal: controller.signal,
      actions: {
        reserve: request => {
          controller.signal.throwIfAborted();
          return guarded(() => options.client.reserve(lease, request, controller.signal));
        },
        settle: (id, cost, success, resource) => guarded(() => options.client.settle(lease, id, cost, success, resource, controller.signal)),
      },
    }));
    controller.signal.throwIfAborted();
    if (result.session.sessionId !== session.sessionId || result.session.model !== task.spec.model || result.session.sequence !== session.sequence + 1) throw new Error('Executor changed fixed session identity/model/sequence');
    const checkpoint = await guarded(() => options.sessions.save(task.id, result.session));
    if (checkpoint.sessionId !== session.sessionId || checkpoint.model !== task.spec.model || checkpoint.sequence !== session.sequence + 1) throw new Error('Private checkpoint identity mismatch');
    // Explicit allowlist: no session content, credential map or arbitrary executor fields.
    const publicResult: AutonomousRunResult = {outcome: result.outcome,
      usage: {inputTokens:result.usage.inputTokens,cacheReadTokens:result.usage.cacheReadTokens,cacheWriteTokens:result.usage.cacheWriteTokens,outputTokens:result.usage.outputTokens},
      costMicros: result.costMicros,
      ...(result.quota?{quota:{kind:result.quota.kind,resetsAt:result.quota.resetsAt,evidence:result.quota.evidence}}:{}),
      ...(result.usageUnavailable===true?{usageUnavailable:true as const}:{}),
      checkpoint: {sessionId:checkpoint.sessionId,objectKey:checkpoint.objectKey,model:checkpoint.model,sequence:checkpoint.sequence},
      ...(result.wakeAt === undefined ? {} : {wakeAt:result.wakeAt}), ...(result.message === undefined ? {} : {message:result.message})};
    if (heartbeat) clearTimeout(heartbeat);
    if (pendingHeartbeat) await guarded(() => pendingHeartbeat!);
    if (heartbeat) clearTimeout(heartbeat);
    await guarded(() => options.client.finish(lease, publicResult, controller.signal));
    return true;
  } finally {
    controller.abort(new Error('Autonomous iteration ended'));
    if (heartbeat) clearTimeout(heartbeat);
    clearTimeout(deadline);
    if (leaseExpiry) clearTimeout(leaseExpiry);
    options.signal?.removeEventListener('abort', relayAbort);
    // Retained executor references receive an empty scoped map after this iteration.
    for (const key of Object.keys(credentials)) delete credentials[key];
  }
}

/** Trusted cleanup adapter is separate from executor and worker authentication.
 * confirm must use an explicit operator/trust adapter, never a worker credential.
 * Failed cleanup/confirmation stays pending for idempotent retry. */
export interface AutonomousCleanupClient {
  readTask(taskId: string): Promise<AutonomousTask>;
  confirmCleaned(taskId: string, resourceId: string): Promise<unknown>;
}
export async function runAutonomousCleanup(options: {
  taskId: string;
  client: AutonomousCleanupClient;
  cleanup: (resource: AutonomousResource, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}): Promise<{cleaned: string[]; pending: string[]}> {
  const {signal,client,taskId} = options;
  const cleaned: string[] = [], pending: string[] = [];
  signal?.throwIfAborted();
  const task = await client.readTask(taskId);
  signal?.throwIfAborted();
  if (task.id !== taskId) throw new Error('Cleanup task identity mismatch');
  if (task.status !== 'stopping' && task.status !== 'awaiting_input') return {cleaned, pending};
  for (const resource of task.resources) {
    if (resource.status !== 'cleanup_pending') continue;
    signal?.throwIfAborted();
    try {
      // Trusted cleanup must be idempotent: confirmation may fail after deletion.
      await options.cleanup(structuredClone(resource), signal);
      signal?.throwIfAborted();
      await client.confirmCleaned(taskId, resource.id);
      cleaned.push(resource.id);
    } catch {
      signal?.throwIfAborted();
      pending.push(resource.id);
    }
  }
  return {cleaned, pending};
}
