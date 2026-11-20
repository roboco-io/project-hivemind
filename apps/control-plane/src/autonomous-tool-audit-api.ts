import type {AutonomousLease} from '../../../packages/contracts/src/autonomous.js';
import type {ToolAuditStore} from '../../../packages/core/src/autonomous-tool-audit-sql.ts';
import {TOOL_AUDIT_LIMITS} from '../../../packages/contracts/src/autonomous-tool-audit.ts';
import type {ToolAuditRecord} from '../../../packages/contracts/src/autonomous-tool-audit.js';

const BODY_LIMIT=65536;
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
function equalToken(a:string,b:string):boolean{let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
class HttpError extends Error{readonly statusCode:number;constructor(statusCode:number){super('Invalid tool audit request');this.statusCode=statusCode;}}
async function readBody(request:Request):Promise<unknown>{
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>BODY_LIMIT))throw new HttpError(413);
 if(!request.body)throw new HttpError(400);
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>BODY_LIMIT){void reader.cancel().catch(()=>{});throw new HttpError(413);}parts.push(part.value);}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw new HttpError(400);}
}
const exact=(v:unknown,keys:string[]):Record<string,unknown>=>{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new HttpError(400);
 const o=v as Record<string,unknown>;if(Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))throw new HttpError(400);return o;
};
export async function handleToolAuditApi(request:Request,o:{operatorToken:string;reporterToken?:string;authorize:(lease:AutonomousLease)=>Promise<{taskId:string;runId:string;iteration:number}>;store:ToolAuditStore}):Promise<Response|null>{
 const url=new URL(request.url),m=url.pathname.match(/^\/v1\/autonomous-tasks\/([^/]+)\/tool-calls\/?$/);
 if(!m)return null;
 try{
  let id:string;try{id=decodeURIComponent(m[1]!);}catch{throw new HttpError(400);}
  if(request.method!=='GET'&&request.method!=='POST')return json({error:'Method not allowed'},405);
  const post=request.method==='POST';
  const expected=post?o.reporterToken:o.operatorToken;
  if(!expected||!o.operatorToken||post&&(equalToken(o.reporterToken??'',o.operatorToken)||/[\s\p{Cc}]/u.test(expected))||!equalToken(request.headers.get('authorization')??'','Bearer '+expected))return json({error:'Unauthorized'},401);
  if(!post){
   const params=url.searchParams,q:{limit?:number;cursor?:string}={};
   for(const k of params.keys())if(!['limit','cursor'].includes(k)||params.getAll(k).length!==1)throw new HttpError(400);
   if(params.has('limit')){const v=params.get('limit')!;if(!/^[1-9][0-9]{0,2}$/.test(v)||Number(v)>100)throw new HttpError(400);q.limit=Number(v);}
   if(params.has('cursor')){const v=params.get('cursor')!;if(!v||v.length>2048||!/^[A-Za-z0-9_.-]+$/.test(v))throw new HttpError(400);q.cursor=v;}
   return json({source:'worker_report',...o.store.page(id,q)});
  }
  const body=exact(await readBody(request),['lease','records','droppedByWorker']);
  const l=exact(body.lease,['taskId','runId','workerId','token','expiresAt']);
  for(const k of ['taskId','runId','workerId','token'])if(typeof l[k]!=='string'||!l[k]||(l[k] as string).length>12000)throw new HttpError(400);
  if(!Number.isSafeInteger(l.expiresAt)||Number(l.expiresAt)<0||!Array.isArray(body.records)||body.records.length>TOOL_AUDIT_LIMITS.batchRecords||!Number.isSafeInteger(body.droppedByWorker)||Number(body.droppedByWorker)<0)throw new HttpError(400);
  if(l.taskId!==id)return json({error:'Lease conflict'},409);
  let scope:{taskId:string;runId:string;iteration:number};
  try{scope=await o.authorize(l as unknown as AutonomousLease);}catch{return json({error:'Lease conflict'},409);}
  if(scope.taskId!==id||scope.runId!==l.runId)return json({error:'Lease conflict'},409);
  return json(o.store.append({taskId:scope.taskId,runId:scope.runId,iteration:scope.iteration},{records:body.records as ToolAuditRecord[],droppedByWorker:body.droppedByWorker as number},Date.now()));
 }catch(error){
  const e=error as {statusCode?:unknown;expectedSequence?:unknown};
  const status=typeof e.statusCode==='number'&&[400,409,413].includes(e.statusCode)?e.statusCode:500;
  if(status===409&&Number.isSafeInteger(e.expectedSequence))return json({error:'Sequence conflict',expectedSequence:e.expectedSequence},409);
  return json({error:status===500?'Tool audit failed':status===409?'Conflict':status===413?'Too large':'Invalid tool audit request'},status);
 }
}
