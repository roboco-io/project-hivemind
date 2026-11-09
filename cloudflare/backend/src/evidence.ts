import type {Provider} from './contracts.ts';
interface Interval {id:string;start:number;end:number}
export interface ParallelEvidence {ids:string[];start:number;end:number;overlapMs:number}
const object=(x:unknown):Record<string,any>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
function parentId(value:unknown,depth=0):string|undefined{const x=object(value);if(!x||depth>8)return;if(typeof x.parent_thread_id==='string')return x.parent_thread_id;for(const child of Object.values(x)){const id=parentId(child,depth+1);if(id)return id;}}
export function nativeParallelEvidence(provider:Provider,sessionId:string,receipts:unknown[]):ParallelEvidence|null {
 if(!sessionId||!Array.isArray(receipts))return null;
 const rows=receipts.map(object).filter((x):x is Record<string,any>=>x!==null),intervals:Interval[]=[];
 if(provider==='claude'){
  const starts=new Map<string,number>();
  for(const row of rows){if(row.sessionId!==sessionId||row.agentType!=='worker'||typeof row.agentId!=='string'||!row.agentId)continue;const time=Date.parse(row.timestamp);if(!Number.isFinite(time))continue;
   if(row.event==='SubagentStart')starts.set(row.agentId,time);
   if(row.event==='SubagentStop'&&starts.has(row.agentId)){const start=starts.get(row.agentId)!;if(time>start)intervals.push({id:row.agentId,start,end:time});starts.delete(row.agentId);}
  }
 }else{
  const id=(row:Record<string,any>)=>row.storageThreadId??row.fileThreadId??row.id;
  const root=rows.find(row=>id(row)===sessionId),spawned=new Set((Array.isArray(root?.spawnReturns)?root.spawnReturns:[]).map((x:any)=>x.agentId));
  for(const row of rows){const child=id(row);if(typeof child!=='string'||!child||child===sessionId||row.malformedRows!==0||!(parentId(row.storageSource??row.source)===sessionId||row.forkedFromId===sessionId||spawned.has(child)))continue;
   let start:number|undefined;for(const mark of Array.isArray(row.lifecycle)?row.lifecycle:[]){const time=Date.parse(mark.timestamp);if(!Number.isFinite(time))continue;if(mark.type==='task_started')start=time;if(mark.type==='turn_aborted')start=undefined;if(mark.type==='task_complete'&&start!==undefined){if(time>start)intervals.push({id:child,start,end:time});start=undefined;}}
  }
 }
 for(const a of intervals)for(const b of intervals){const start=Math.max(a.start,b.start),end=Math.min(a.end,b.end);if(a.id!==b.id&&end>start)return {ids:[a.id,b.id],start,end,overlapMs:end-start};}
 return null;
}
