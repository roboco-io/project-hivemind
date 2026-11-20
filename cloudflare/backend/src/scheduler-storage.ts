import {pageSchedulerJobs,type SchedulerJobPage,type SchedulerJobQuery} from './scheduler-jobs.ts';
import {randomBytes} from 'node:crypto';
import {Scheduler} from './scheduler.ts';
import type {SchedulerState,JobRecord} from './contracts.ts';
import {autonomousRecordJsonMetadata,iterateAutonomousRecordJson,createAutonomousRecordDecoder} from '../../../packages/core/src/autonomous-repository.ts';
export const SCHEDULER_STATE_NORMAL_BYTES=30*1024*1024;
export const SCHEDULER_STATE_HARD_BYTES=32*1024*1024;
export const SCHEDULER_STATE_LEGACY_BYTES=2*1024*1024;
const manifestKey='scheduler:manifest',legacyOrderKey='scheduler:jobs-page-order';
interface Manifest {version:2;format:'instructions_pool_v1';generation:string;digest:string;bytes:number;chunks:number}
export interface SchedulerStoragePort {
 get<T>(key:string):Promise<T|undefined>;put<T>(key:string,value:T):Promise<unknown>;delete?(key:string):Promise<unknown>;
 transaction?<T>(fn:(tx:SchedulerStoragePort)=>Promise<T>):Promise<T>;
}
export interface SchedulerStorage {
 load():Promise<SchedulerState|undefined>;
 legacyByteLength(state:SchedulerState):number;
 pageJobs(state:SchedulerState,query:SchedulerJobQuery):Promise<SchedulerJobPage>;
 /** Recovery may add checks for an existing admitted parent, never new root work. */
 save(state:SchedulerState,options?:{recovery?:boolean}):Promise<void>;
}
function invalid():never{throw Object.assign(Error('Invalid scheduler storage'),{statusCode:503});}
function capacity(statusCode=413):never{throw Object.assign(Error('Scheduler storage capacity exceeded'),{statusCode});}
function dict(value:unknown):asserts value is Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value))invalid();}
function shape(state:SchedulerState){
 dict(state);if(state.version!==1)invalid();for(const key of ['jobs','credentials','idempotency'] as const)dict(state[key]);
 for(const [id,job] of Object.entries(state.jobs)){
  dict(job);if(job.id!==id||!['agent','compute'].includes(job.kind)||!Array.isArray(job.childIds)||!Array.isArray(job.checks)||typeof job.containerStopped!=='boolean')invalid();
  if(job.parentId&&!Object.hasOwn(state.jobs,job.parentId)||job.childIds.some(child=>!Object.hasOwn(state.jobs,child)))invalid();
  if(job.kind==='agent'&&!job.containerStopped){const c=state.credentials[job.credentialId!];if(!c||c.activeJobId!==id||c.generation!==job.credentialGeneration)invalid();}
 }
 for(const [id,c] of Object.entries(state.credentials)){
  dict(c);if(c.id!==id||!['claude','codex'].includes(c.provider)||!Number.isSafeInteger(c.generation)||c.generation<0)invalid();
  if(c.activeJobId){const j=state.jobs[c.activeJobId];if(!j||j.credentialId!==id||j.credentialGeneration!==c.generation)invalid();}
 }
 for(const value of Object.values(state.idempotency)){dict(value);if(typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!Object.hasOwn(state.jobs,value.jobId))invalid();}
}
/** No full unpooled serialization: repeated immutable instruction strings appear once. */
function pack(state:SchedulerState,jobOrder=Object.keys(state.jobs)){
 shape(state);const jobs:Record<string,unknown>={},instructionPool:string[]=[],pool=new Map<string,{index:number;bytes:number}>();let legacyDelta=0;
 for(const [id,job] of Object.entries(state.jobs)){
  const row:Record<string,unknown>={...job};
  if(job.instructions!==undefined){
   if(typeof job.instructions!=='string')invalid();let entry=pool.get(job.instructions);
   if(!entry){entry={index:instructionPool.length,bytes:Buffer.byteLength(JSON.stringify(job.instructions))};pool.set(job.instructions,entry);instructionPool.push(job.instructions);}
   const ref={pool:entry.index};row.instructions=ref;legacyDelta+=entry.bytes-Buffer.byteLength(JSON.stringify(ref));
  }
  Object.defineProperty(jobs,id,{value:row,enumerable:true,writable:true,configurable:true});
 }
 const stateJson=JSON.stringify({...state,jobs}),legacyBytes=Buffer.byteLength(stateJson)+legacyDelta;
 const json='{"version":2,"instructionPool":'+JSON.stringify(instructionPool)+',"jobOrder":'+JSON.stringify(jobOrder)+',"legacyBytes":'+legacyBytes+',"state":'+stateJson+'}';
 return {json,bytes:Buffer.byteLength(json),legacyBytes,jobOrder};
}
function unpack(value:unknown):{state:SchedulerState;jobOrder:string[];legacyBytes:number} {
 dict(value);if(value.version!==2||Object.keys(value).some(k=>!['version','instructionPool','jobOrder','legacyBytes','state'].includes(k))||!Array.isArray(value.instructionPool)||value.instructionPool.some(v=>typeof v!=='string')||new Set(value.instructionPool).size!==value.instructionPool.length)invalid();
 const state=value.state;dict(state);dict(state.jobs);const jobs:Record<string,JobRecord>={};
 for(const [id,raw] of Object.entries(state.jobs)){
  dict(raw);const row={...raw};if(Object.hasOwn(raw,'instructions')){
   const ref=raw.instructions;dict(ref);if(Object.keys(ref).length!==1||!Number.isSafeInteger(ref.pool)||ref.pool<0||ref.pool>=value.instructionPool.length)invalid();row.instructions=value.instructionPool[ref.pool];
  }
  Object.defineProperty(jobs,id,{value:row,enumerable:true,writable:true,configurable:true});
 }
 const restored={...state,jobs} as SchedulerState;shape(restored);
 const order=value.jobOrder===undefined?Object.keys(jobs):value.jobOrder;if(!Array.isArray(order)||order.length!==Object.keys(jobs).length||new Set(order).size!==order.length||order.some(id=>typeof id!=='string'||!Object.hasOwn(jobs,id)))invalid();
 const legacyBytes=value.legacyBytes===undefined?pack(restored,order).legacyBytes:value.legacyBytes;if(!Number.isSafeInteger(legacyBytes)||legacyBytes<1)invalid();
 return {state:new Scheduler(restored,{exclusiveOwnership:true}).state,jobOrder:order,legacyBytes};
}
/** Exact legacy byte count without constructing the full repeated-goal JSON. */
export function schedulerLegacyByteLength(state:SchedulerState):number{return pack(state).legacyBytes;}
function ordered(state:SchedulerState,previous:readonly string[]):string[]{const result=[...previous],seen=new Set(previous);if(previous.some(id=>!Object.hasOwn(state.jobs,id)))invalid();for(const id of Object.keys(state.jobs))if(!seen.has(id)){seen.add(id);result.push(id);}return result;}
function manifest(value:unknown):Manifest {
 dict(value);if(value.version!==2||value.format!=='instructions_pool_v1'||typeof value.generation!=='string'||!/^[a-f0-9]{32}$/.test(value.generation)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>SCHEDULER_STATE_HARD_BYTES||!Number.isSafeInteger(value.chunks)||value.chunks!==Math.ceil(value.bytes/(96*1024))||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))invalid();return value as unknown as Manifest;
}
const chunkKey=(generation:string,index:number)=>`scheduler:chunk:${generation}:${index}`;
function admissionKeys(s:SchedulerState):Set<string>{
 const keys=new Set<string>();for(const [id,j]of Object.entries(s.jobs))if(j.kind==='agent'||!j.parentId)keys.add('job:'+id);
 for(const name of ['credentials','workflows','computeGroups','carbonCampaigns'] as const)for(const id of Object.keys(s[name]??{}))keys.add(name+':'+id);return keys;
}
function retainedKeys(s:SchedulerState):Set<string>{const keys=new Set<string>();for(const name of ['jobs','credentials','idempotency','completionReceipts','workflows','computeGroups','carbonCampaigns'])for(const id of Object.keys((s as unknown as Record<string,Record<string,unknown>>)[name]??{}))keys.add(name+':'+id);return keys;}
/**
 * Legacy `state` is immutable after successful migration, not an old-binary rollback copy.
 * After v2 writes, disable/drain and retain a v2 reader/forward fix. Old-code rollback is
 * unsupported here; a separate lossless backfill needs ALL jobs stopped, credentials idle
 * and the CURRENT unpooled state <=2MiB. Never delete history to meet that bound.
 * Transactions contain storage only; generation switch and chunk replacement are atomic.
 */
export function createSchedulerStorage(storage:SchedulerStoragePort):SchedulerStorage {
 let loaded=false,generation:string|undefined,known=new Set<string>(),retained=new Set<string>(),jobOrder:string[]=[],acceptedState:SchedulerState|undefined,acceptedLegacyBytes=0;
 function accept(state:SchedulerState|undefined,version?:string,order?:string[],legacyBytes?:number){acceptedState=state;acceptedLegacyBytes=legacyBytes??(state?schedulerLegacyByteLength(state):0);jobOrder=order??(state?Object.keys(state.jobs):[]);loaded=true;generation=version;known=state?admissionKeys(state):new Set();retained=state?retainedKeys(state):new Set();return state;}
 async function publish(tx:SchedulerStoragePort,state:SchedulerState,packed:ReturnType<typeof pack>,old?:Manifest){
  const meta=autonomousRecordJsonMetadata(packed.json),next=randomBytes(16).toString('hex'),iterator=iterateAutonomousRecordJson(packed.json);let part=iterator.next(),count=0;
  while(!part.done){await tx.put(chunkKey(next,count++),part.value);part=iterator.next();}
  if(count!==meta.chunks||part.value.bytes!==meta.bytes||part.value.chunks!==meta.chunks||part.value.digest!==meta.digest)invalid();
  const result:Manifest={version:2,format:'instructions_pool_v1',generation:next,...meta};await tx.put(manifestKey,result);
  if(old&&tx.delete)for(let i=0;i<old.chunks;i++)await tx.delete(chunkKey(old.generation,i));
  return {state,generation:next,jobOrder:packed.jobOrder,legacyBytes:packed.legacyBytes};
 }
 async function read(tx:SchedulerStoragePort,migrate:boolean){
  const saved=await tx.get<Manifest>(manifestKey);
  if(saved!==undefined){
   if(!migrate)invalid();const m=manifest(saved),decoder=createAutonomousRecordDecoder({bytes:m.bytes,digest:m.digest,chunks:m.chunks});
   for(let i=0;i<m.chunks;i++){const chunk=await tx.get<string>(chunkKey(m.generation,i));if(chunk===undefined)invalid();decoder.push(chunk);}
   return {...unpack(decoder.finish()),generation:m.generation};
  }
  const raw=await tx.get<SchedulerState>('state');if(raw===undefined)return {state:undefined,generation:undefined,jobOrder:[],legacyBytes:0};
  const packed=pack(raw);
  if(!migrate&&packed.legacyBytes>SCHEDULER_STATE_LEGACY_BYTES)capacity(503);
  if(packed.bytes>SCHEDULER_STATE_HARD_BYTES)capacity();
  // Detach legacy ownership through the normalized graph, not a full copy of every
  // repeated goal. The immutable old key is never mutated during validation.
  const restored=unpack(JSON.parse(packed.json));
  if(!migrate){const order=await tx.get<unknown>(legacyOrderKey);if(order!==undefined){if(!Array.isArray(order)||order.some(id=>typeof id!=='string')||new Set(order).size!==order.length)invalid();restored.jobOrder=ordered(restored.state,order);}return {...restored,generation:undefined};}
  return publish(tx,restored.state,packed);
 }
 const repository:SchedulerStorage={
  legacyByteLength:state=>state===acceptedState?acceptedLegacyBytes:schedulerLegacyByteLength(state),
  async pageJobs(state,query){
   if(!loaded)await repository.load();if(!storage.transaction&&await storage.get(manifestKey)!==undefined)invalid();const order=ordered(state,jobOrder);
   if(!storage.transaction){if(Buffer.byteLength(JSON.stringify(order))>SCHEDULER_STATE_LEGACY_BYTES)capacity(503);await storage.put(legacyOrderKey,order);}jobOrder=order;
   const getSecret=async(tx:SchedulerStoragePort)=>{let secret=await tx.get<string>('scheduler:jobs-page-secret');if(secret===undefined){secret=randomBytes(32).toString('hex');await tx.put('scheduler:jobs-page-secret',secret);}if(!/^[a-f0-9]{64}$/.test(secret))invalid();return secret;};
   const secret=storage.transaction?await storage.transaction(getSecret):await getSecret(storage);return pageSchedulerJobs(state,order,query,secret);
  },
  async load(){const result=storage.transaction?await storage.transaction(tx=>read(tx,true)):await read(storage,false);return accept(result.state,result.generation,result.jobOrder,result.legacyBytes);},
  async save(state,options={}){
   if(!loaded)await repository.load();const present=retainedKeys(state);if([...retained].some(id=>!present.has(id)))throw Object.assign(Error('Scheduler history removal denied'),{statusCode:409});const nextKeys=admissionKeys(state),admission=[...nextKeys].some(id=>!known.has(id));const packed=pack(state,ordered(state,jobOrder)),recovery=options.recovery===true&&!admission;
   if(storage.transaction){
    if(packed.bytes>(recovery?SCHEDULER_STATE_HARD_BYTES:SCHEDULER_STATE_NORMAL_BYTES))capacity();
    const result=await storage.transaction(async tx=>{const raw=await tx.get<Manifest>(manifestKey),old=raw===undefined?undefined:manifest(raw);if(old?.generation!==generation)throw Object.assign(Error('Scheduler storage writer changed'),{statusCode:409});return publish(tx,state,packed,old);});accept(state,result.generation,result.jobOrder,result.legacyBytes);
   }else{
    if(await storage.get(manifestKey)!==undefined)invalid();if(packed.legacyBytes>SCHEDULER_STATE_LEGACY_BYTES)capacity(503);await storage.put('state',new Scheduler(state).state);await storage.put(legacyOrderKey,packed.jobOrder);accept(state,undefined,packed.jobOrder,packed.legacyBytes);
   }
  },
 };
 return repository;
}
/** Fresh decoded result is exclusively owned; caller may adopt it without another clone. */
export async function loadSchedulerState(storage:SchedulerStoragePort):Promise<SchedulerState|undefined>{return createSchedulerStorage(storage).load();}
