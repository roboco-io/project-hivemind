import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {AutonomousTask} from '../../contracts/src/autonomous.js';
export const AUTONOMOUS_RECORD_MAX_BYTES=32*1024*1024;
export const AUTONOMOUS_PAGE_MAX_BYTES=1536*1024;
export const AUTONOMOUS_CHUNK_MAX_BYTES=128*1024;
export type AutonomousRecord={chunks:string[];digest:string;bytes:number};
function invalid():never{throw Object.assign(new Error('Invalid autonomous record or page'),{statusCode:400});}
export type AutonomousRecordMetadata={digest:string;bytes:number;chunks:number};
const RAW_CHUNK_BYTES=96*1024;
function jsonBytes(json:string):number{if(typeof json!=='string'||!json.length)invalid();const bytes=Buffer.byteLength(json,'utf8');if(bytes>AUTONOMOUS_RECORD_MAX_BYTES)throw Object.assign(new Error('Autonomous record capacity exceeded'),{statusCode:413});return bytes;}
/** Internal borrowed byte view; consumed synchronously before advancing the generator. */
function* utf8Pieces(json:string):Generator<Uint8Array>{
 const scratch=new Uint8Array(RAW_CHUNK_BYTES),encoder=new TextEncoder();
 for(let offset=0;offset<json.length;){let end=Math.min(offset+32*1024,json.length),last=json.charCodeAt(end-1);if(end<json.length&&last>=0xd800&&last<=0xdbff)end--;
  const part=json.slice(offset,end),encoded=encoder.encodeInto(part,scratch);if(encoded.read!==part.length)invalid();yield scratch.subarray(0,encoded.written);offset=end;
 }
}
/** Hash/size admission preflight without collecting JSON bytes or base64 chunks. */
export function autonomousRecordJsonMetadata(json:string):AutonomousRecordMetadata{
 const bytes=jsonBytes(json),hash=createHash('sha256');for(const piece of utf8Pieces(json))hash.update(piece);return {digest:hash.digest('hex'),bytes,chunks:Math.ceil(bytes/RAW_CHUNK_BYTES)};
}
/** Trusted JSON.stringify output only. Each yielded immutable string is <=128KiB. */
export function* iterateAutonomousRecordJson(json:string):Generator<string,AutonomousRecordMetadata,void>{
 const bytes=jsonBytes(json),raw=Buffer.allocUnsafe(RAW_CHUNK_BYTES),hash=createHash('sha256');let used=0,chunks=0;
 for(const piece of utf8Pieces(json)){let cursor=0;while(cursor<piece.byteLength){const size=Math.min(raw.length-used,piece.byteLength-cursor);raw.set(piece.subarray(cursor,cursor+size),used);used+=size;cursor+=size;
   if(used===raw.length){hash.update(raw);chunks++;yield raw.toString('base64');used=0;}
 }}
 if(used){const last=raw.subarray(0,used);hash.update(last);chunks++;yield last.toString('base64');}
 return {digest:hash.digest('hex'),bytes,chunks};
}
export function encodeAutonomousRecordJson(json:string):AutonomousRecord{
 const iterator=iterateAutonomousRecordJson(json),chunks:string[]=[];let next=iterator.next();while(!next.done){chunks.push(next.value);next=iterator.next();}return {chunks,digest:next.value.digest,bytes:next.value.bytes};
}
export function encodeAutonomousRecord(value:unknown):AutonomousRecord{const json=JSON.stringify(value);if(json===undefined)invalid();return encodeAutonomousRecordJson(json);}
export interface AutonomousRecordDecoder {push(chunk:string):void;finish():unknown}
export function createAutonomousRecordDecoder(meta:AutonomousRecordMetadata):AutonomousRecordDecoder{
 if(!meta||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||meta.bytes>AUTONOMOUS_RECORD_MAX_BYTES||typeof meta.digest!=='string'||!/^[a-f0-9]{64}$/.test(meta.digest)||meta.chunks!==Math.ceil(meta.bytes/RAW_CHUNK_BYTES))invalid();
 const raw=Buffer.allocUnsafe(RAW_CHUNK_BYTES),hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true}),parts:string[]=[];let bytes=0,chunks=0,closed=false;
 return {
  push(chunk){
   if(closed||chunks>=meta.chunks||typeof chunk!=='string'||!chunk.length||chunk.length>AUTONOMOUS_CHUNK_MAX_BYTES||chunk.length%4)invalid();
   try{const size=raw.write(chunk,0,raw.length,'base64'),piece=raw.subarray(0,size);if(piece.toString('base64')!==chunk||(chunks<meta.chunks-1&&size!==raw.length))invalid();bytes+=size;if(bytes>meta.bytes)invalid();chunks++;hash.update(piece);parts.push(decoder.decode(piece,{stream:true}));}catch{closed=true;parts.length=0;invalid();}
  },
  finish(){
   if(closed)invalid();closed=true;
   try{if(chunks!==meta.chunks||bytes!==meta.bytes||hash.digest('hex')!==meta.digest)invalid();parts.push(decoder.decode());const json=parts.join('');parts.length=0;return JSON.parse(json);}catch{parts.length=0;invalid();}
  },
 };
}
export function decodeAutonomousRecord(record:AutonomousRecord):unknown{
 if(!record||!Array.isArray(record.chunks))invalid();const decoder=createAutonomousRecordDecoder({bytes:record.bytes,digest:record.digest,chunks:record.chunks.length});for(const chunk of record.chunks)decoder.push(chunk);return decoder.finish();
}
export type AutonomousTaskSummary=Pick<AutonomousTask,'id'|'spec'|'revision'|'status'|'createdAt'|'approvedAt'|'nextRunAt'|'iteration'|'spentMicros'|'reservedMicros'|'stopReason'|'counts'> & {lease?:{expiresAt:number}};
export type AutonomousPageTask=Pick<AutonomousTask,'id'|'spec'|'revision'|'status'|'createdAt'|'iteration'|'spentMicros'|'reservedMicros'> & Partial<Omit<AutonomousTask,'lease'>> & {lease?:{expiresAt:number}};
export function summarizeAutonomousTask(task:AutonomousPageTask):AutonomousTaskSummary{
 const out:Record<string,unknown>={};
 for(const key of ['id','spec','revision','status','createdAt','approvedAt','nextRunAt','iteration','spentMicros','reservedMicros','stopReason','counts'] as const)if(task[key]!==undefined)out[key]=structuredClone(task[key]);
 if(task.lease)out.lease={expiresAt:task.lease.expiresAt};
 if(!task.counts&&task.interventions&&task.actions)out.counts={humanInterventions:task.interventions.filter(i=>i.kind!=='help').length,helpRequests:task.interventions.filter(i=>i.kind==='help').length,toolCalls:task.actions.length};
 return out as AutonomousTaskSummary;
}
export function pageAutonomousTasks(entries:readonly {sequence:number;task:AutonomousPageTask}[],query:{limit?:number;cursor?:string},secret:string):{items:AutonomousTaskSummary[];nextCursor?:string}{
 if(!query||Object.keys(query).some(k=>k!=='limit'&&k!=='cursor')||typeof secret!=='string'||secret.length<32)invalid();
 const limit=query.limit===undefined?20:query.limit;if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid();
 const sorted=[...entries].sort((a,b)=>a.sequence-b.sequence);let high=sorted.at(-1)?.sequence??0,last=0;
 if(sorted.some((e,i)=>!Number.isSafeInteger(e.sequence)||e.sequence<1||(i>0&&e.sequence===sorted[i-1]!.sequence)))invalid();
 const mac=(s:string)=>createHmac('sha256',secret).update(s).digest('hex');
 if(query.cursor!==undefined){
  if(typeof query.cursor!=='string'||query.cursor.length>512||!query.cursor.length)invalid();
  const [body,signature,...extra]=query.cursor.split('.');if(!body||!signature||extra.length||!/^[a-f0-9]{64}$/.test(signature))invalid();
  const raw=Buffer.from(body,'base64url');if(raw.toString('base64url')!==body||!timingSafeEqual(Buffer.from(mac(body),'hex'),Buffer.from(signature,'hex')))invalid();
  let parsed:unknown;try{parsed=JSON.parse(raw.toString('utf8'));}catch{invalid();}
  if(!Array.isArray(parsed)||parsed.length!==3||parsed[0]!==1||!Number.isSafeInteger(parsed[1])||!Number.isSafeInteger(parsed[2])||parsed[1]<0||parsed[2]<0||parsed[2]>parsed[1])invalid();
  high=parsed[1];last=parsed[2];
 }
 const eligible=sorted.filter(e=>e.sequence>last&&e.sequence<=high),items:AutonomousTaskSummary[]=[];let bytes=0,lastEmitted=last;
 for(const entry of eligible){if(items.length>=limit)break;const item=summarizeAutonomousTask(entry.task),size=Buffer.byteLength(JSON.stringify(item),'utf8')+1;
  if(size>AUTONOMOUS_PAGE_MAX_BYTES)throw Object.assign(new Error('Autonomous summary exceeds page budget'),{statusCode:413});
  if(items.length&&bytes+size>AUTONOMOUS_PAGE_MAX_BYTES)break;items.push(item);bytes+=size;lastEmitted=entry.sequence;
 }
 if(eligible.length<=items.length)return {items};
 const body=Buffer.from(JSON.stringify([1,high,lastEmitted])).toString('base64url');return {items,nextCursor:body+'.'+mac(body)};
}

export type AutonomousHistoryKind='runs'|'actions'|'resources'|'interventions';
export type AutonomousHistoryQuery={id:string;kind:AutonomousHistoryKind;limit?:number;cursor?:string};
export interface AutonomousHistoryPage {taskId:string;kind:AutonomousHistoryKind;revision:number;items:Record<string,unknown>[];nextCursor?:string}
const historyFields:Record<AutonomousHistoryKind,readonly string[]>={
 runs:['runId','workerId','startedAt','finishedAt','scheduledAt','outcome','costMicros','wakeAt','message','usageUnavailable','reconciledCostMicros','billingEvidence'],
 actions:['id','requestId','tool','system','operation','estimatedCostMicros','status','actualCostMicros','resourceId'],
 resources:['id','system','cleanupOperation','status','actionId'],
 interventions:['kind','message','at','revision'],
};
function publicHistoryItem(item:unknown,kind:AutonomousHistoryKind):Record<string,unknown>{
 if(!item||typeof item!=='object'||Array.isArray(item))invalid();const input=item as Record<string,unknown>,out:Record<string,unknown>={};
 const primitive=(v:unknown)=>v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v);
 for(const key of historyFields[kind])if(Object.hasOwn(input,key)&&primitive(input[key]))out[key]=input[key];
 if(kind==='runs')for(const [key,fields] of [['usage',['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']],['quota',['kind','resetsAt','evidence']]] as const){
  const source=input[key];if(source&&typeof source==='object'&&!Array.isArray(source)){const value:Record<string,unknown>={};for(const field of fields){const v=(source as Record<string,unknown>)[field];if(primitive(v))value[field]=v;}out[key]=value;}
 }
 return out;
}
/** Append-stable page bounds; reconciled records are read at their current value.
 * Settings revision changes invalidate the cursor; no history record is ever pruned. */
export function pageAutonomousHistory(task:AutonomousTask,kind:AutonomousHistoryKind,query:{limit?:number;cursor?:string},secret:string):AutonomousHistoryPage{
 if(!task||typeof task.id!=='string'||!task.id||!Number.isSafeInteger(task.revision)||task.revision<1||!Object.hasOwn(historyFields,kind)||!Array.isArray(task[kind])||!query||Object.keys(query).some(k=>!['limit','cursor'].includes(k))||typeof secret!=='string'||secret.length<32)invalid();
 const limit=query.limit===undefined?20:query.limit;if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid();
 let high=task[kind].length,offset=0;const mac=(body:string)=>createHmac('sha256',secret).update(body).digest('hex');
 if(query.cursor!==undefined){
  if(typeof query.cursor!=='string'||!query.cursor||query.cursor.length>2048)invalid();const [body,signature,...extra]=query.cursor.split('.');
  if(!body||!signature||extra.length||!/^[a-f0-9]{64}$/.test(signature))invalid();const raw=Buffer.from(body,'base64url');
  if(raw.toString('base64url')!==body||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(body),'hex')))invalid();
  let parsed:unknown;try{parsed=JSON.parse(raw.toString('utf8'));}catch{invalid();}
  if(!Array.isArray(parsed)||parsed.length!==7||parsed[0]!=='history-v1'||parsed[1]!==task.id||parsed[2]!==kind||!Number.isSafeInteger(parsed[3])||!Number.isSafeInteger(parsed[4])||!Number.isSafeInteger(parsed[5])||parsed[4]<0||parsed[5]<0||parsed[5]>parsed[4]||parsed[6]!==1)invalid();
  if(parsed[3]!==task.revision||parsed[4]>task[kind].length)throw Object.assign(new Error('Stale autonomous history cursor'),{statusCode:409});high=parsed[4];offset=parsed[5];
 }
 const items:Record<string,unknown>[]=[];let bytes=0;
 while(offset<high&&items.length<limit){const item=publicHistoryItem(task[kind][offset],kind),size=Buffer.byteLength(JSON.stringify(item),'utf8')+1;
  // Byte bound also covers 100 four-byte Unicode messages; limit is a maximum, not a promise.
  if(size>1024*1024)throw Object.assign(new Error('Autonomous history item too large'),{statusCode:413});if(items.length&&bytes+size>1024*1024)break;items.push(item);bytes+=size;offset++;
 }
 const result:AutonomousHistoryPage={taskId:task.id,kind,revision:task.revision,items};
 if(offset<high){const body=Buffer.from(JSON.stringify(['history-v1',task.id,kind,task.revision,high,offset,1])).toString('base64url');result.nextCursor=body+'.'+mac(body);}
 return result;
}
