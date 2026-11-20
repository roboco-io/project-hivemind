import type {AutonomousStatus} from '../../contracts/src/autonomous.js';
import {runAutonomousIteration,type AutonomousIterationOptions} from './autonomous-runner.js';

export interface AutonomousLoopOptions extends AutonomousIterationOptions {
  maxIterations: number;
  maxIdlePolls: number;
  pollMs?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Operator credentials do not belong in worker configuration. */
  operatorToken?: never;
}
export type AutonomousLoopReason = AutonomousStatus | 'iteration_limit' | 'idle_limit';
export interface AutonomousLoopResult {iterations: number; reason: AutonomousLoopReason}

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject) => {
    const abort = () => {clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
    const timer = setTimeout(() => {signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
  });
}
/** Explicit opt-in. Errors propagate without retry: invocation/finish may be uncertain. */
export async function runAutonomousLoop(options: AutonomousLoopOptions): Promise<AutonomousLoopResult> {
  if ('operatorToken' in options || 'operatorCredentials' in options) throw Error('Operator credentials forbidden in worker loop');
  if (!options.client.workerState) throw Error('Worker-state capability required');
  for(const limit of [options.maxIterations,options.maxIdlePolls]) {
    if(!Number.isSafeInteger(limit)||limit<1) throw Error('Explicit positive finite loop limits required');
  }
  const pollMs=options.pollMs??1000;
  if(!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>60000) throw Error('Polling interval must be 1..60000 milliseconds');
  const now=options.now??Date.now,wait=options.wait??sleep;
  let iterations=0,idlePolls=0;
  for(;;){
    options.signal?.throwIfAborted();
    if(iterations>=options.maxIterations)return {iterations,reason:'iteration_limit'};
    const state=await abortable(()=>options.client.workerState!(options.taskId,options.signal),options.signal);
    options.signal?.throwIfAborted();
    if(state.taskId!==options.taskId||!Number.isSafeInteger(state.endsAt)||!Number.isSafeInteger(state.iteration)||state.iteration<0||
      (state.nextRunAt!==undefined&&!Number.isSafeInteger(state.nextRunAt)))throw Error('Invalid worker state');
    if(state.status!=='ready'&&state.status!=='waiting'&&state.status!=='running'){
      if(!['awaiting_approval','awaiting_input','stopping','completed','cancelled','budget_exceeded','expired','failed'].includes(state.status))throw Error('Invalid worker status');
      return {iterations,reason:state.status};
    }
    const current=now();
    if(!Number.isSafeInteger(current))throw Error('Invalid loop clock');
    if(current>=state.endsAt)return {iterations,reason:'expired'};
    if(state.status==='ready'&&(state.nextRunAt===undefined||state.nextRunAt<=current)){
      if(await runAutonomousIteration(options)){iterations++;continue;}
    }
    if(idlePolls>=options.maxIdlePolls)return {iterations,reason:'idle_limit'};
    const untilWake=state.nextRunAt!==undefined&&state.nextRunAt>current?state.nextRunAt-current:pollMs;
    await abortable(()=>wait(Math.min(pollMs,untilWake,state.endsAt-current),options.signal),options.signal);
    options.signal?.throwIfAborted();
    idlePolls++;
  }
}
