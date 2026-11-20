import {randomBytes} from 'node:crypto';
import {autonomousRecordJsonMetadata,iterateAutonomousRecordJson,createAutonomousRecordDecoder,pageAutonomousTasks,summarizeAutonomousTask,type AutonomousHistoryQuery,type AutonomousTaskSummary} from '../../../packages/core/src/autonomous-repository.ts';
import { AutonomousEngine,AutonomousPageRequiredError,type AutonomousPersistenceRecord } from '../../../packages/core/src/autonomous.ts';
import type { AutonomousState, AutonomousTask } from '../../../packages/contracts/src/autonomous.ts';
import { executeAutonomousOperation } from '../../../apps/control-plane/src/autonomous-api.ts';
import type { AutonomousApiService, AutonomousOperation } from '../../../apps/control-plane/src/autonomous-api.ts';

export const AUTONOMOUS_STATE_MAX_BYTES = 1536 * 1024;
// Leave room below the 2 MB KV key/value limit for bounded stop and recovery writes.
export const AUTONOMOUS_STATE_HARD_MAX_BYTES = 1900 * 1024;
const recoveryOperations=new Set<AutonomousOperation>(['acceptExternal','settleExternal','cleanedExternal','nativeReady','recordNativeReceipt','workerState','cancel','cleaned','tick','heartbeat','settle','finish','finishCloud','finishUnstartedCloud','abandonCloud','reconcile','reconcileRun','get','getSummary','historyPage','list','listPage']);
export class AutonomousStorageCapacityError extends Error {
 statusCode=413;
 code='AUTONOMOUS_STORAGE_CAPACITY';
 constructor(){super('Autonomous state storage capacity exceeded');}
}
export interface AutonomousStorage {
 transaction?<T>(callback:(tx:AutonomousStorage)=>Promise<T>):Promise<T>;
 delete?(key:string):Promise<unknown>;
 get<T>(key:string):Promise<T|undefined>;
 put<T>(key:string,value:T):Promise<unknown>;
}
/** One instance per Durable Object. Do not share this storage key with another writer. */
export class AutonomousService implements AutonomousApiService {
 private storage:AutonomousStorage;
 private clock:()=>number;
 private tail:Promise<unknown>=Promise.resolve();
 constructor(storage:AutonomousStorage,clock:()=>number=Date.now){this.storage=storage;this.clock=clock;}
 get supportsLongRunning():boolean{return typeof this.storage.transaction==='function';}
 execute(operation:AutonomousOperation,input:Record<string,unknown>):Promise<unknown> {
  const run=this.tail.then(async()=>{
   if(this.storage.transaction)return this.partitioned(operation,input);
   // A published catalog remains authoritative when an adapter loses transactions.
   // Never resurrect a missing or stale legacy snapshot and bypass credential owners.
   if(await this.storage.get<unknown>('autonomous:catalog')!==undefined)throw Object.assign(new Error('Transactional storage required'),{statusCode:503});
   if(operation==='create'||operation==='revise'){const spec=input.spec as {execution?:{mode?:string}}|undefined;if(spec?.execution?.mode==='long_running')throw Object.assign(new Error('Transactional storage required'),{statusCode:503});}
   const state=await this.storage.get<AutonomousState>('autonomous-state');
   if(state&&Object.values(state.tasks).some(t=>t.spec.execution?.mode==='long_running'))throw Object.assign(new Error('Transactional storage required'),{statusCode:503});
   const candidate=new AutonomousEngine(state,{ownership:'exclusive'});
   const changed=()=>{let count=0;for(const record of candidate.persistenceRecords()){count++;if(!state||!Object.hasOwn(state.tasks,record.id)||record.json!==JSON.stringify(state.tasks[record.id]))return true;}return count!==Object.keys(state?.tasks??{}).length;};
   const persist=async(recovery=false)=>{
    const snapshot=changed()?candidate.snapshot():state??{version:1,tasks:{}};
    const limit=recovery||recoveryOperations.has(operation)?AUTONOMOUS_STATE_HARD_MAX_BYTES:AUTONOMOUS_STATE_MAX_BYTES;
    if(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>limit) throw new AutonomousStorageCapacityError();
    await this.storage.put('autonomous-state',snapshot);
   };
   let result:unknown;
   try{if(operation==='listPage'){
    let secret=await this.storage.get<string>('autonomous:legacy-page-secret');if(!secret){secret=randomBytes(32).toString('hex');await this.storage.put('autonomous:legacy-page-secret',secret);}
    candidate.tick(this.clock());result=pageAutonomousTasks(candidate.list().map((task,i)=>({sequence:i+1,task})),input,secret);
   }else if(operation==='getSummary'||operation==='historyPage'){
    candidate.tick(this.clock());
    if(operation==='getSummary')result=candidate.getSummary(input.id as string);else{let secret=await this.storage.get<string>('autonomous:legacy-page-secret');if(!secret){secret=randomBytes(32).toString('hex');await this.storage.put('autonomous:legacy-page-secret',secret);}const {id:_id,kind,...query}=input as unknown as AutonomousHistoryQuery;result=candidate.historyPage({id:_id,kind,...query},secret);}
   }else if(operation==='get'&&(input.maxBytes??input.publicMaxBytes)!==undefined){candidate.tick(this.clock());result=candidate.get(input.id as string,(input.maxBytes??input.publicMaxBytes) as number);}
   else result=executeAutonomousOperation(candidate,operation,input,this.clock());}
   catch(error){
    // Scope/budget suspension is intentional policy state. Other errors roll back.
    if((error as {commitState?:unknown})?.commitState===true) await persist(true);
    throw error;
   }
   if(!['get','getSummary','historyPage','list','workerState','listPage'].includes(operation)||changed())await persist();
   return result;
  });
  this.tail=run.catch(()=>undefined);
  return run;
 }
 private async partitioned(operation:AutonomousOperation,input:Record<string,unknown>):Promise<unknown>{
  // Throw intentional policy denials only after the transaction commits their state.
  const outcome=await this.storage.transaction!(async tx=>{
   type Manifest={generation:string;digest:string;bytes:number;chunks:number;sequence:number;summary:AutonomousTaskSummary};
   type Catalog={version:2;secret:string;ids:string[];nextSequence:number;bytes:number;requestIndexVersion?:1;tickCursor?:number};
   type Owner={credentialIds:string[];blocked:boolean};
   const taskKey=(id:string)=>'autonomous:task:'+id;
   const requestKey=(requestId:string)=>'autonomous:request:'+encodeURIComponent(requestId);
   const ownerKey=(id:string)=>'autonomous:credential-owner:'+id;
   const chunkKey=(id:string,g:string,i:number)=>`autonomous:chunk:${id}:${g}:${i}`;
   const invalid:()=>never=()=>{throw Object.assign(new Error('Invalid autonomous catalog or index'),{statusCode:503});};
   const conflict:()=>never=()=>{throw Object.assign(new Error('Autonomous identity conflict'),{statusCode:409});};
   const now=this.clock(),hard=32*1024*1024;
   const recovery=recoveryOperations.has(operation);
   let catalog=await tx.get<Catalog>('autonomous:catalog');
   const manifests=new Map<string,Manifest>(),requests=new Map<string,string>();
   let catalogChanged=false;
   const writeTask=async(serialized:AutonomousPersistenceRecord,allowRecovery:boolean)=>{
    const {id,json,summary,credentialOwner}=serialized,requestId=summary.spec.requestId,record=autonomousRecordJsonMetadata(json),old=manifests.get(id);
    if(old?.digest===record.digest)return;
    if(record.bytes>(allowRecovery?32:30)*1024*1024)throw new AutonomousStorageCapacityError();
    const total=catalog!.bytes-(old?.bytes??0)+record.bytes;
    if(total>(allowRecovery?32:30)*1024*1024)throw new AutonomousStorageCapacityError();
    if(!old&&catalog!.ids.length>=1000)throw Object.assign(new Error('Task limit'),{statusCode:422});
    const generation=randomBytes(16).toString('hex');
    let ordinal=0;for(const chunk of iterateAutonomousRecordJson(json))await tx.put(chunkKey(id,generation,ordinal++),chunk);if(ordinal!==record.chunks)invalid();
    const m:Manifest={generation,digest:record.digest,bytes:record.bytes,chunks:record.chunks,sequence:old?.sequence??catalog!.nextSequence++,summary:summary};
    await tx.put(taskKey(id),m);
    await tx.put(requestKey(requestId),{id:id,sequence:m.sequence});
    await tx.put(ownerKey(id),credentialOwner);
    if(old&&tx.delete)for(let i=0;i<old.chunks;i++)await tx.delete(chunkKey(id,old.generation,i));
    if(!old)catalog!.ids.push(id);
    catalog!.bytes=total;catalogChanged=true;manifests.set(id,m);requests.set(requestId,id);
   };
   if(!catalog){
    const legacy=await tx.get<AutonomousState>('autonomous-state')??{version:1,tasks:{}};
    if(Buffer.byteLength(JSON.stringify(legacy),'utf8')>hard)throw new AutonomousStorageCapacityError();
    const legacyEngine=new AutonomousEngine(legacy,{ownership:'exclusive'}); // Validate every legacy history without cloning it.
    catalog={version:2,secret:randomBytes(32).toString('hex'),ids:[],nextSequence:1,bytes:0,requestIndexVersion:1};
    // Publish only inside this transaction; keep legacy intact for rollback/retry.
    for(const record of legacyEngine.persistenceRecords())await writeTask(record,recovery);
   }else{
    if(catalog.version!==2||!Array.isArray(catalog.ids)||catalog.ids.length>1000||new Set(catalog.ids).size!==catalog.ids.length||!Number.isSafeInteger(catalog.bytes)||catalog.bytes<0||catalog.bytes>hard||!Number.isSafeInteger(catalog.nextSequence)||catalog.nextSequence<1||typeof catalog.secret!=='string'||catalog.secret.length<32||(catalog.requestIndexVersion!==undefined&&catalog.requestIndexVersion!==1)||(catalog.tickCursor!==undefined&&(!Number.isSafeInteger(catalog.tickCursor)||catalog.tickCursor<0)))invalid();
    let total=0;const sequences=new Set<number>();
    for(const id of catalog.ids){
     if(typeof id!=='string'||!id)invalid();
     const m=await tx.get<Manifest>(taskKey(id));
     if(!m||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>hard||!Number.isSafeInteger(m.chunks)||m.chunks!==Math.ceil(m.bytes/(96*1024))||typeof m.generation!=='string'||!/^[a-f0-9]{32}$/.test(m.generation)||typeof m.digest!=='string'||!/^[a-f0-9]{64}$/.test(m.digest)||!Number.isSafeInteger(m.sequence)||m.sequence<1||m.sequence>=catalog.nextSequence||sequences.has(m.sequence)||m.summary?.id!==id||typeof m.summary.spec?.requestId!=='string'||requests.has(m.summary.spec.requestId))invalid();
     sequences.add(m.sequence);total+=m.bytes;manifests.set(id,m);requests.set(m.summary.spec.requestId,id);
    }
    if(total!==catalog.bytes||total>hard)invalid();
    if(catalog.requestIndexVersion!==1){
     // Old v2 catalogs can rebuild request identity without touching any history.
     for(const [requestId,id] of requests)await tx.put(requestKey(requestId),{id,sequence:manifests.get(id)!.sequence});
     catalog.requestIndexVersion=1;catalogChanged=true;
    }
   }
   const state:AutonomousState={version:1,tasks:{}};
   const load=async(id:string)=>{
    if(Object.hasOwn(state.tasks,id))return state.tasks[id]!;
    const m=manifests.get(id);if(!m)return;
    const decoder=createAutonomousRecordDecoder({chunks:m.chunks,digest:m.digest,bytes:m.bytes});
    for(let i=0;i<m.chunks;i++){const c=await tx.get<string>(chunkKey(id,m.generation,i));if(c===undefined)invalid();decoder.push(c);}
    const task=decoder.finish() as AutonomousTask;
    if(task.id!==id||JSON.stringify(summarizeAutonomousTask(task))!==JSON.stringify(m.summary))invalid();
    Object.defineProperty(state.tasks,id,{value:task,writable:true,enumerable:true,configurable:true});return task;
   };
   const due=(t:AutonomousTaskSummary)=>!['completed','cancelled','budget_exceeded','expired','failed'].includes(t.status)&&(t.spec.endsAt<=now||(t.lease!==undefined&&t.lease.expiresAt<=now)||(t.status==='waiting'&&t.nextRunAt!==undefined&&t.nextRunAt<=now));
   const entries=()=>catalog!.ids.map(id=>({sequence:manifests.get(id)!.sequence,task:manifests.get(id)!.summary}));
   if(operation==='list'&&(input.maxBytes??input.publicMaxBytes)!==undefined){const max=input.maxBytes??input.publicMaxBytes;if(typeof max!=='number'||!Number.isSafeInteger(max)||max<1)invalid();if(catalog.bytes+Math.max(0,catalog.ids.length-1)+2>max)throw new AutonomousPageRequiredError();}
   if(operation==='get'&&(input.maxBytes??input.publicMaxBytes)!==undefined){const bytes=input.maxBytes??input.publicMaxBytes;if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1)invalid();const m=manifests.get(input.id as string);if(m&&m.bytes>bytes)throw new AutonomousPageRequiredError();}
   if(operation==='getSummary'){
    const m=manifests.get(input.id as string);if(m&&!due(m.summary)){if(catalogChanged)await tx.put('autonomous:catalog',catalog);return {result:summarizeAutonomousTask(m.summary),error:undefined};}
   }
   if(operation==='list'){
    // Compatibility only: internal alarm consumers use metadata pages and tick batches.
    for(const id of catalog.ids)await load(id);
   }else if(operation==='listPage'){
    const page=pageAutonomousTasks(entries(),input,catalog.secret);
    for(const item of page.items)if(due(item))await load(item.id);
   }else if(operation==='tick'){
    let cursor=catalog.tickCursor??0,scanned=0,selected=0;
    while(scanned<catalog.ids.length&&selected<25){
     const id=catalog.ids[cursor%catalog.ids.length]!;cursor=(cursor+1)%catalog.ids.length;scanned++;
     if(due(manifests.get(id)!.summary)){await load(id);selected++;}
    }
    if(selected>0&&cursor!==(catalog.tickCursor??0)){catalog.tickCursor=cursor;catalogChanged=true;}
   }else if(operation==='create'){
    const requestId=(input.spec as {requestId?:unknown}|undefined)?.requestId;
    if(typeof requestId==='string'){
     const indexed=await tx.get<{id:string;sequence:number}>(requestKey(requestId)),expected=requests.get(requestId);
     if(indexed?(indexed.id!==expected||indexed.sequence!==manifests.get(indexed.id)?.sequence):expected!==undefined)invalid();
     if(indexed)await load(indexed.id);
     else if(catalog.ids.length>=1000)throw Object.assign(new Error('Task limit'),{statusCode:422});
    }
   }else{
    const id=(input.id??(input.lease as {taskId?:unknown}|undefined)?.taskId) as string;
    const target=typeof id==='string'?await load(id):undefined;
    if(target&&(operation==='claim'||operation==='claimCloud')&&target.spec.provider!=='mock'){
     for(const otherId of catalog.ids){
      if(otherId===id)continue;
      const o=await tx.get<Owner>(ownerKey(otherId)),summary=manifests.get(otherId)!.summary;
      if(!o||typeof o.blocked!=='boolean'||!Array.isArray(o.credentialIds)||JSON.stringify(o.credentialIds)!==JSON.stringify(summary.spec.credentialIds))invalid();
      if(o.blocked&&o.credentialIds.some(c=>target.spec.credentialIds.includes(c)))await load(otherId);
     }
    }
   }
   const candidate=new AutonomousEngine(state,{ownership:'exclusive'});
   const historyPage=candidate.historyPage.bind(candidate);
   Object.defineProperty(candidate,'historyPage',{value:(query:AutonomousHistoryQuery)=>historyPage(query,catalog!.secret)});
   let result:unknown,error:unknown;
   try{if(operation==='listPage')candidate.tick(now);else result=executeAutonomousOperation(candidate,operation,input,now);}
   catch(e){if(!(e as {commitState?:boolean})?.commitState)throw e;error=e;}
   for(const record of candidate.persistenceRecords()){
    const {id,summary}=record,requestId=summary.spec.requestId;
    // The core sees only loaded tasks; enforce identities against the entire catalog.
    if(!Object.hasOwn(state.tasks,id)&&(manifests.has(id)||(requests.has(requestId)&&requests.get(requestId)!==id)))conflict();
    if(requests.has(requestId)&&requests.get(requestId)!==id)conflict();
    await writeTask(record,error!==undefined||recovery);
   }
   if(catalogChanged)await tx.put('autonomous:catalog',catalog);
   if(operation==='listPage')result=pageAutonomousTasks(entries(),input,catalog.secret);
   return {result,error};
  });
  if(outcome.error!==undefined)throw outcome.error;return outcome.result;
 }
 async tick():Promise<void>{await this.execute('tick',{});}
}
