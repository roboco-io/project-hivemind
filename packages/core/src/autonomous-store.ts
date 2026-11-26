import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AutonomousEngine,AutonomousPageRequiredError } from './autonomous.js';
import { autonomousRecordJsonMetadata, iterateAutonomousRecordJson, createAutonomousRecordDecoder, pageAutonomousTasks, summarizeAutonomousTask, pageAutonomousHistory, type AutonomousHistoryQuery } from './autonomous-repository.js';
import type { AutonomousState, AutonomousTask } from '../../contracts/src/autonomous.js';

export type AutonomousPageQuery = {limit?:number;cursor?:string};
export type AutonomousStore = AutonomousEngine & {
 transaction<T>(fn: (engine: AutonomousEngine) => T, operation?:string): T;
 getSummary(id:string):ReturnType<typeof summarizeAutonomousTask>;
 historyPage(query:AutonomousHistoryQuery):ReturnType<typeof pageAutonomousHistory>;
 listPage(query?:AutonomousPageQuery): ReturnType<typeof pageAutonomousTasks>;
 close(): void;
};

/** Every call reloads under the SQLite write lock, including calls from other handles.
 * Full history remains in memory for core validation/credential arbitration. Disk records
 * use the shared per-task 32MiB ceiling and <=128KiB encoded chunks; no history is pruned.
 */
export function createAutonomousStore(path: string): AutonomousStore {
 if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
 const db=new DatabaseSync(path);
 if(path!==':memory:') chmodSync(path,0o600);
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS autonomous_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_metadata (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL, active INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, bytes INTEGER NOT NULL, summary TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS autonomous_chunks (task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,ordinal));`);
 let closed=false;
 function locked<T>(fn:()=>T):T {
  if(closed) throw new Error('Autonomous store is closed');
  db.exec('BEGIN IMMEDIATE');
  try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
 }
 function metadata(){
  db.prepare('INSERT OR IGNORE INTO autonomous_metadata(id,secret,active) VALUES(1,?,0)').run(randomBytes(32).toString('hex'));
  return db.prepare('SELECT secret,active FROM autonomous_metadata WHERE id=1').get()!;
 }
 function capacity():never{throw Object.assign(new Error('Autonomous storage capacity exceeded'),{statusCode:413,code:'AUTONOMOUS_STORAGE_CAPACITY'});}
 function load():AutonomousEngine {
  if(!metadata().active){
   const row=db.prepare('SELECT data FROM autonomous_state WHERE id=1').get();
   if(row&&Buffer.byteLength(String(row.data),'utf8')>32*1024*1024)capacity();
   return new AutonomousEngine(row?JSON.parse(String(row.data)) as AutonomousState:undefined,{ownership:'exclusive'});
  }
  const bound=db.prepare('SELECT COALESCE(SUM(bytes),0) AS total, MIN(bytes) AS minimum, MAX(bytes) AS maximum FROM autonomous_tasks').get()!;
  if(!Number.isSafeInteger(bound.total)||Number(bound.total)>32*1024*1024||Number(bound.minimum)<0||Number(bound.maximum)>32*1024*1024)capacity();
  const tasks:Record<string,AutonomousTask>=Object.create(null);
  for(const row of db.prepare('SELECT id,digest,bytes FROM autonomous_tasks ORDER BY sequence').all()){
   const decoder=createAutonomousRecordDecoder({digest:String(row.digest),bytes:Number(row.bytes),chunks:Math.ceil(Number(row.bytes)/(96*1024))});let ordinal=0;
   for(const chunk of db.prepare('SELECT ordinal,data FROM autonomous_chunks WHERE task_id=? ORDER BY ordinal').iterate(String(row.id))){if(chunk.ordinal!==ordinal++)throw new Error('Invalid chunk ordinal');decoder.push(String(chunk.data));}
   const task=decoder.finish() as AutonomousTask;
   if(task.id!==row.id)throw new Error('Autonomous record identity mismatch');
   tasks[task.id]=task;
  }
  return new AutonomousEngine({version:1,tasks},{ownership:'exclusive'});
 }
 const recoveryOperations=new Set(['acceptExternal','settleExternal','cleanedExternal','nativeReady','recordNativeReceipt','workerState','cancel','cleaned','tick','stopExternalBudget','toolAuditScope','heartbeat','settle','finish','finishCloud','finishUnstartedCloud','abandonCloud','reconcile','reconcileRun','get','getSummary','historyPage','list','listPage','snapshot']);
 function persist(engine:AutonomousEngine,recovery=true){
  let total=Number(db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM autonomous_tasks').get()!.total),changed=false;
  for(const serialized of engine.persistenceRecords()){
   const {id,json,summary}=serialized,record=autonomousRecordJsonMetadata(json),prior=db.prepare('SELECT digest,bytes FROM autonomous_tasks WHERE id=?').get(id);
   if(prior?.digest===record.digest)continue;
   if(record.bytes>(recovery?32:30)*1024*1024)capacity();total+=record.bytes-Number(prior?.bytes??0);changed=true;
   db.prepare(`INSERT INTO autonomous_tasks(id,digest,bytes,summary) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,bytes=excluded.bytes,summary=excluded.summary`).run(id,record.digest,record.bytes,JSON.stringify(summary));
   db.prepare('DELETE FROM autonomous_chunks WHERE task_id=?').run(id);
   const insert=db.prepare('INSERT INTO autonomous_chunks(task_id,ordinal,data) VALUES(?,?,?)');let ordinal=0;for(const chunk of iterateAutonomousRecordJson(json))insert.run(id,ordinal++,chunk);if(ordinal!==record.chunks)throw new Error('Serialized chunk mismatch');
  }
  // Multi-task swaps use the final aggregate, and every write rolls back on failure.
  if(changed&&total>(recovery?32:30)*1024*1024)capacity();
  if(!changed&&metadata().active)return;
  // Keep the legacy JSON intact. This marker also preserves existing UPDATE fault probes.
  db.prepare("INSERT OR IGNORE INTO autonomous_state(id,data) VALUES(1,'{\"version\":1,\"tasks\":{}}')").run();
  db.prepare('UPDATE autonomous_state SET data=data WHERE id=1').run();
  db.prepare('UPDATE autonomous_metadata SET active=1 WHERE id=1').run();
 }
 function transaction<T>(fn:(engine:AutonomousEngine)=>T,operation?:string):T {
  let intentional:unknown;
  let failed=false;
  const result=locked(()=>{
   const targeted=operation==='get'||operation==='getSummary'||operation==='historyPage';
   if(targeted&&!metadata().active)persist(load());
   const engine=targeted?new AutonomousEngine():load();let readClock:number|undefined;
   if(targeted)Object.defineProperty(engine,'tick',{value:(now:number)=>{readClock=now;}});
   const one=(id:string,maxBytes?:number)=>{
    const row=db.prepare('SELECT digest,bytes FROM autonomous_tasks WHERE id=?').get(id);
    if(!row)throw Object.assign(new Error('Task not found'),{statusCode:404});
    if(maxBytes!==undefined){if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Object.assign(new Error('Invalid public byte ceiling'),{statusCode:400});if(Number(row.bytes)>maxBytes)throw new AutonomousPageRequiredError();}
    if(!Number.isSafeInteger(row.bytes)||Number(row.bytes)>32*1024*1024||Number(row.bytes)<1)capacity();
    const decoder=createAutonomousRecordDecoder({digest:String(row.digest),bytes:Number(row.bytes),chunks:Math.ceil(Number(row.bytes)/(96*1024))});let ordinal=0;
    for(const chunk of db.prepare('SELECT ordinal,data FROM autonomous_chunks WHERE task_id=? ORDER BY ordinal').iterate(id)){if(chunk.ordinal!==ordinal++)throw new Error('Invalid chunk ordinal');decoder.push(String(chunk.data));}
    const task=decoder.finish() as AutonomousTask;
    if(task.id!==id)throw new Error('Autonomous record identity mismatch');
    const selected=new AutonomousEngine({version:1,tasks:{[id]:task}},{ownership:'exclusive'});if(readClock!==undefined)selected.tick(readClock);persist(selected);return selected;
   };
   if(targeted)Object.defineProperty(engine,'get',{value:(id:string,maxBytes?:number)=>AutonomousEngine.prototype.get.call(one(id,maxBytes),id)});
   Object.defineProperty(engine,'getSummary',{value:(id:string)=>{
    if(!targeted)return AutonomousEngine.prototype.getSummary.call(engine,id);
    const row=db.prepare('SELECT summary FROM autonomous_tasks WHERE id=?').get(id);if(!row)throw Object.assign(new Error('Task not found'),{statusCode:404});
    const t=JSON.parse(String(row.summary)) as AutonomousTask;
    const due=readClock!==undefined&&!['completed','cancelled','budget_exceeded','expired','failed'].includes(t.status)&&(t.spec.endsAt<=readClock||(t.lease!==undefined&&t.lease.expiresAt<=readClock)||(t.status==='waiting'&&t.nextRunAt!==undefined&&t.nextRunAt<=readClock));
    return due?one(id).getSummary(id):summarizeAutonomousTask(t);
   }});
   Object.defineProperty(engine,'historyPage',{value:({id,kind,...query}:AutonomousHistoryQuery)=>AutonomousEngine.prototype.historyPage.call(targeted?one(id):engine,{id,kind,...query},String(metadata().secret))});
   // Page reads inside API transactions see the same lock and policy tick as mutations.
   Object.defineProperty(engine,'listPage',{value:(query:AutonomousPageQuery)=>{persist(engine);return readPage(query);}});
   let value:T;
   try{value=fn(engine);}catch(error){if((error as {commitState?:unknown})?.commitState!==true)throw error;failed=true;intentional=error;persist(engine);return undefined;}
   if(!targeted)persist(engine,recoveryOperations.has(operation??''));return value;
  });
  if(failed)throw intentional;
  return result as T;
 }
 function readPage(query:AutonomousPageQuery={}){
  const meta=metadata();
  if(!meta.active)persist(load());
  // Summaries are bounded independently of histories; the helper verifies cursor MAC/scope.
  const entries=db.prepare('SELECT sequence,summary FROM autonomous_tasks ORDER BY sequence').all().map(row=>({sequence:Number(row.sequence),task:JSON.parse(String(row.summary)) as AutonomousTask}));
  return pageAutonomousTasks(entries,query,String(meta.secret));
 }
 const methods=new Set(['acceptExternal','settleExternal','cleanedExternal','snapshot','create','get','getSummary','historyPage','list','approve','revise','claim','claimCloud','finishCloud','finishUnstartedCloud','abandonCloud','nativeStart','nativeReady','recordNativeReceipt','workerState','heartbeat','finish','cancel','message','reserve','settle','reconcile','resume','reconcileRun','cleaned','tick','stopExternalBudget','toolAuditScope']);
 return new Proxy(Object.create(null) as AutonomousStore,{
  get(_target,property){
   if(property==='transaction') return transaction;
   if(property==='getSummary')return (id:string)=>transaction(engine=>(Reflect.get(engine,'getSummary') as (id:string)=>unknown)(id),'getSummary');
   if(property==='historyPage')return (query:AutonomousHistoryQuery)=>transaction(engine=>(Reflect.get(engine,'historyPage') as (q:AutonomousHistoryQuery)=>unknown)(query),'historyPage');
   if(property==='listPage')return (query:AutonomousPageQuery={})=>locked(()=>readPage(query));
   if(property==='close') return ()=>{if(!closed){db.close();closed=true;}};
   if(typeof property!=='string'||!methods.has(property)) return undefined;
   return (...args:unknown[])=>transaction(engine=>Reflect.apply(engine[property as keyof AutonomousEngine] as (...args:unknown[])=>unknown,engine,args),property);
  }
 });
}
