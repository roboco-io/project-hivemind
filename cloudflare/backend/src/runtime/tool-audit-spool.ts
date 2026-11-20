import {TOOL_AUDIT_LIMITS,type ToolAuditRecord} from './tool-audit-redact.ts';
import {constants} from 'node:fs';
import {mkdir,open} from 'node:fs/promises';
/** Spool line formats (one JSON object per line). s=start, e=end, d=dropped count. */
export interface SpoolStart {v:1;t:'s';id?:string;tool:string;digest:string;summary:string;truncated:boolean;outcome:'allowed'|'denied';at:number;sub?:true}
export interface SpoolEnd {v:1;t:'e';id:string;ok:boolean;at:number}
export interface SpoolDrop {v:1;t:'d';n:number}
const RESERVE=64*1024;
const digest=/^[a-f0-9]{64}$/;
/** Folds spool text into records. Sequence is the 1-based order of valid start lines, stable while the spool is append-only. */
export function foldToolAuditSpool(raw:string):{records:ToolAuditRecord[];droppedByWorker:number} {
 const records:ToolAuditRecord[]=[],open=new Map<string,ToolAuditRecord>();let dropped=0;
 const lines=raw.split('\n');lines.pop();// last element is '' or an unfinished line
 for(const line of lines){
  if(!line)continue;
  let item:any;try{item=JSON.parse(line);}catch{dropped++;continue;}
  if(!item||typeof item!=='object'||item.v!==1){dropped++;continue;}
  if(item.t==='d'){if(Number.isSafeInteger(item.n)&&item.n>0)dropped+=item.n;else dropped++;continue;}
  if(item.t==='s'){
   if(typeof item.tool!=='string'||!item.tool||typeof item.digest!=='string'||!digest.test(item.digest)||typeof item.summary!=='string'||typeof item.truncated!=='boolean'||!['allowed','denied'].includes(item.outcome)||!Number.isSafeInteger(item.at)||item.at<0){dropped++;continue;}
   const record:ToolAuditRecord={sequence:records.length+1,tool:item.tool,inputDigest:item.digest,inputSummary:item.summary,inputTruncated:item.truncated,outcome:item.outcome,startedAt:item.at,durationMs:null,...(item.sub===true?{subagent:true as const}:{})};
   if(Buffer.byteLength(JSON.stringify(record))>TOOL_AUDIT_LIMITS.recordBytes){dropped++;continue;}
   records.push(record);
   if(typeof item.id==='string'&&record.outcome==='allowed')open.set(item.id,record);
   continue;
  }
  if(item.t==='e'){
   const record=typeof item.id==='string'?open.get(item.id):undefined;
   if(!record||!Number.isSafeInteger(item.at))continue;
   open.delete(item.id);record.durationMs=Math.max(0,item.at-record.startedAt);if(item.ok===false)record.outcome='error';
   continue;
  }
  dropped++;
 }
 return {records,droppedByWorker:dropped};
}
/** Appends one line. Rejects only when the spool cannot be written; a full spool records a drop marker instead. */
export async function appendToolAuditLine(path:string,line:string,limit:number=TOOL_AUDIT_LIMITS.spoolBytes):Promise<{dropped:boolean}> {
 const dir=path.slice(0,path.lastIndexOf('/'));
 if(dir)await mkdir(dir,{recursive:true,mode:0o700});
 const file=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{
  const info=await file.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.nlink!==1)throw Error('Invalid audit destination');
  const text=line.endsWith('\n')?line:line+'\n';
  if(info.size+Buffer.byteLength(text)>limit){
   if(info.size<limit+RESERVE)await file.writeFile(JSON.stringify({v:1,t:'d',n:1})+'\n');
   return {dropped:true};
  }
  await file.writeFile(text);
  return {dropped:false};
 }finally{await file.close();}
}
