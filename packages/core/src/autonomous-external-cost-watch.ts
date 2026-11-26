import type {ExternalTransactionalStore} from '../../contracts/src/autonomous-external.js';
import {listExternalTaskExposures} from './autonomous-external-exposure.ts';

export interface ExternalCostWatchOptions {
  store:ExternalTransactionalStore;
  stopTask(taskId:string,reason:string):Promise<void>;
  cancelApprovals(taskId:string,revision:number):void;
  now?:()=>number;
}
export interface ExternalCostSweepResult {stopped:string[];failed:string[];nextExpiryAt?:number}

/** Stops central tasks whose external cost reached the cap. Reads broker state only; never mutates it.
 * A stop is remembered per task revision once stopTask succeeds, so repeated sweeps do not repeat it. */
export function createExternalCostWatch(o:ExternalCostWatchOptions):{sweep(limit?:number):Promise<ExternalCostSweepResult>} {
  const done=new Set<string>(),retry=new Map<string,string>();// retry remembers the reason of a failed stop, so a later state change cannot cancel the retry
  return {async sweep(limit=50){
    const exposures=o.store.transaction(s=>listExternalTaskExposures(s));
    const stopped:string[]=[],failed:string[]=[];
    let pending=Math.max(0,Math.floor(limit)),nextExpiryAt:number|undefined,wake=Infinity;
    for(const e of exposures){
      const key=`${e.taskId}:${e.revision}`;
      let handled=done.has(key);
      const reason=e.stop??retry.get(key)??null;
      if(reason!==null&&!handled){
        if(pending>0){
          pending--;
          try{o.cancelApprovals(e.taskId,e.revision);await o.stopTask(e.taskId,reason);done.add(key);retry.delete(key);stopped.push(e.taskId);handled=true;}
          catch{retry.set(key,reason);failed.push(e.taskId);}
        }else wake=Math.min(wake,o.now?.()??Date.now());// over the per-sweep limit: ask the caller to wake again
      }
      if(!handled&&e.nextExpiryAt!==undefined&&(nextExpiryAt===undefined||e.nextExpiryAt<nextExpiryAt))nextExpiryAt=e.nextExpiryAt;
    }
    if(wake!==Infinity&&(nextExpiryAt===undefined||wake<nextExpiryAt))nextExpiryAt=wake;
    return {stopped,failed,...(nextExpiryAt===undefined?{}:{nextExpiryAt})};
  }};
}
