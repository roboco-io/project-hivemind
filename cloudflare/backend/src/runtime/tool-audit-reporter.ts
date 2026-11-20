import type {AutonomousLease} from '../../../../packages/contracts/src/autonomous.ts';
import {TOOL_AUDIT_LIMITS,type ToolAuditRecord} from './tool-audit-redact.ts';
export class ToolAuditSequenceError extends Error {expectedSequence:number;constructor(expectedSequence:number){super('Tool audit sequence mismatch');this.expectedSequence=expectedSequence;}}
export async function shipToolAudit(o:{lease:AutonomousLease;url:string;token:string;records:ToolAuditRecord[];droppedByWorker:number;fetchImpl?:typeof fetch;signal:AbortSignal}):Promise<{shipped:number}> {
 const fail=()=>Error('Tool audit report refused or failed');
 let url:URL;try{url=new URL(o.url);}catch{throw fail();}
 if(!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!o.token||o.token.length>4096||/[\s\p{Cc}]/u.test(o.token)||!/^[A-Za-z0-9_-]{1,128}$/.test(o.lease.taskId)||!Number.isSafeInteger(o.droppedByWorker)||o.droppedByWorker<0)throw fail();
 const endpoint=`${url.href.replace(/\/$/,'')}/v1/autonomous-tasks/${encodeURIComponent(o.lease.taskId)}/tool-calls`,fetcher=o.fetchImpl??fetch;
 const batches:ToolAuditRecord[][]=[];for(let i=0;i<o.records.length;i+=TOOL_AUDIT_LIMITS.batchRecords)batches.push(o.records.slice(i,i+TOOL_AUDIT_LIMITS.batchRecords));
 if(!batches.length&&o.droppedByWorker>0)batches.push([]);
 let shipped=0;
 for(const [index,records] of batches.entries()){
  const signal=AbortSignal.any([o.signal,AbortSignal.timeout(10000)]);
  try{
   signal.throwIfAborted();
   // droppedByWorker is the worker's cumulative count; sent on the first batch only.
   const response=await fetcher(endpoint,{method:'POST',headers:{authorization:'Bearer '+o.token,'content-type':'application/json'},body:JSON.stringify({lease:o.lease,records,droppedByWorker:index===0?o.droppedByWorker:0}),redirect:'error',signal});
   const text=await readBounded(response,signal);
   const body=JSON.parse(text);
   if(response.status===409&&Number.isSafeInteger(body?.expectedSequence))throw new ToolAuditSequenceError(body.expectedSequence);
   if(!response.ok||!body||body.recorded!==true||!Number.isSafeInteger(body.nextSequence))throw Error();
   shipped+=records.length;
  }catch(error){if(error instanceof ToolAuditSequenceError)throw error;throw fail();}
 }
 return {shipped};
}
async function readBounded(response:Response,signal:AbortSignal):Promise<string> {
 if(!response.body)throw Error();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024)throw Error();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}
