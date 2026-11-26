import {createHmac,timingSafeEqual} from 'node:crypto';
import type {ExternalSqlPort} from './autonomous-external-sql.ts';
import {TOOL_AUDIT_LIMITS} from '../../contracts/src/autonomous-tool-audit.ts';
import type {ToolAuditRecord,StoredToolAuditRecord,ToolAuditTotals} from '../../contracts/src/autonomous-tool-audit.js';
export interface ToolAuditStore {
 append(scope:{taskId:string;runId:string;iteration:number},batch:{records:ToolAuditRecord[];droppedByWorker:number},now:number):{recorded:true;nextSequence:number};
 page(taskId:string,q:{limit?:number;cursor?:string}):{items:StoredToolAuditRecord[];totals:ToolAuditTotals;nextCursor?:string};
 totals(taskId:string):ToolAuditTotals;
}
const fail=(statusCode:number,extra:Record<string,unknown>={}):never=>{throw Object.assign(new Error('Invalid tool audit request'),{statusCode},extra);};
const int=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const FIELDS=['sequence','tool','inputDigest','inputSummary','inputTruncated','outcome','startedAt','durationMs'];
function validRecord(r:unknown):asserts r is ToolAuditRecord{
 if(!r||typeof r!=='object'||Array.isArray(r))return fail(400);
 const o=r as Record<string,unknown>;
 if(Object.keys(o).some(k=>!FIELDS.includes(k)&&k!=='subagent')||FIELDS.some(k=>!Object.hasOwn(o,k)))return fail(400);
 if(!Number.isSafeInteger(o.sequence)||Number(o.sequence)<1||typeof o.tool!=='string'||!o.tool||o.tool.length>128||typeof o.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(o.inputDigest)
  ||typeof o.inputSummary!=='string'||Buffer.byteLength(o.inputSummary)>TOOL_AUDIT_LIMITS.summaryBytes||typeof o.inputTruncated!=='boolean'||!['allowed','denied','error'].includes(String(o.outcome))
  ||!int(o.startedAt)||o.durationMs!==null&&!int(o.durationMs)||o.subagent!==undefined&&o.subagent!==true||Buffer.byteLength(JSON.stringify(o))>TOOL_AUDIT_LIMITS.recordBytes)return fail(400);
}
/** Repository over an ExternalSqlPort. Cursors are MAC-signed and bound to the task. */
export function createToolAuditStore(sql:ExternalSqlPort,secret:string,limits:{taskRecords?:number;taskBytes?:number}={}):ToolAuditStore{
 if(typeof secret!=='string'||secret.length<32)throw new Error('Tool audit secret too short');
 const maxRecords=limits.taskRecords??TOOL_AUDIT_LIMITS.taskRecords,maxBytes=limits.taskBytes??TOOL_AUDIT_LIMITS.taskBytes;
 sql.exec('CREATE TABLE IF NOT EXISTS tool_audit_records(ord INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,run_id TEXT NOT NULL,sequence INTEGER NOT NULL,iteration INTEGER NOT NULL,received_at INTEGER NOT NULL,tool TEXT NOT NULL,input_digest TEXT NOT NULL,input_summary TEXT NOT NULL,input_truncated INTEGER NOT NULL,outcome TEXT NOT NULL,started_at INTEGER NOT NULL,duration_ms INTEGER,subagent INTEGER NOT NULL,bytes INTEGER NOT NULL,UNIQUE(task_id,run_id,sequence))');
 sql.exec('CREATE TABLE IF NOT EXISTS tool_audit_runs(task_id TEXT NOT NULL,run_id TEXT NOT NULL,high INTEGER NOT NULL,dropped_worker INTEGER NOT NULL,PRIMARY KEY(task_id,run_id))');
 sql.exec('CREATE TABLE IF NOT EXISTS tool_audit_tasks(task_id TEXT PRIMARY KEY,recorded INTEGER NOT NULL,denied INTEGER NOT NULL,errors INTEGER NOT NULL,dropped_store INTEGER NOT NULL,bytes INTEGER NOT NULL)');
 const one=(q:string,...b:(string|number|null)[])=>[...sql.exec(q,...b)][0];
 const mac=(body:string)=>createHmac('sha256',secret).update(body).digest('hex');
 function totals(taskId:string):ToolAuditTotals{
  const t=one('SELECT recorded,denied,errors,dropped_store FROM tool_audit_tasks WHERE task_id=?',taskId),w=one('SELECT COALESCE(SUM(dropped_worker),0) AS n FROM tool_audit_runs WHERE task_id=?',taskId);
  return {recorded:Number(t?.recorded??0),denied:Number(t?.denied??0),errors:Number(t?.errors??0),droppedByWorker:Number(w?.n??0),droppedByStore:Number(t?.dropped_store??0)};
 }
 return {
  totals,
  append(scope,batch,now){
   if(!scope||typeof scope.taskId!=='string'||!scope.taskId||typeof scope.runId!=='string'||!scope.runId||!int(scope.iteration)||!int(now)||!batch||!Array.isArray(batch.records)||!int(batch.droppedByWorker))return fail(400);
   if(batch.records.length>TOOL_AUDIT_LIMITS.batchRecords)return fail(400);
   for(const r of batch.records)validRecord(r);
   return sql.transactionSync(()=>{
    const run=one('SELECT high,dropped_worker FROM tool_audit_runs WHERE task_id=? AND run_id=?',scope.taskId,scope.runId);
    let high=Number(run?.high??0);const fresh=[...batch.records].sort((a,b)=>a.sequence-b.sequence).filter(r=>r.sequence>high);
    let expected=high+1;for(const r of fresh){if(r.sequence!==expected)return fail(409,{expectedSequence:high+1});expected++;}
    const t=one('SELECT recorded,denied,errors,dropped_store,bytes FROM tool_audit_tasks WHERE task_id=?',scope.taskId);
    let recorded=Number(t?.recorded??0),denied=Number(t?.denied??0),errors=Number(t?.errors??0),dropped=Number(t?.dropped_store??0),bytes=Number(t?.bytes??0);
    for(const r of fresh){
     const size=Buffer.byteLength(JSON.stringify(r));
     if(recorded+1>maxRecords||bytes+size>maxBytes)dropped++;
     else{
      sql.exec('INSERT INTO tool_audit_records(task_id,run_id,sequence,iteration,received_at,tool,input_digest,input_summary,input_truncated,outcome,started_at,duration_ms,subagent,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',scope.taskId,scope.runId,r.sequence,scope.iteration,now,r.tool,r.inputDigest,r.inputSummary,r.inputTruncated?1:0,r.outcome,r.startedAt,r.durationMs,r.subagent?1:0,size);
      recorded++;bytes+=size;if(r.outcome==='denied')denied++;if(r.outcome==='error')errors++;
     }
     high=r.sequence;
    }
    // The worker reports a cumulative drop count per run, so keep the maximum to stay idempotent.
    sql.exec('INSERT INTO tool_audit_runs VALUES(?,?,?,?) ON CONFLICT(task_id,run_id) DO UPDATE SET high=excluded.high,dropped_worker=MAX(dropped_worker,excluded.dropped_worker)',scope.taskId,scope.runId,high,batch.droppedByWorker);
    sql.exec('INSERT INTO tool_audit_tasks VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET recorded=excluded.recorded,denied=excluded.denied,errors=excluded.errors,dropped_store=excluded.dropped_store,bytes=excluded.bytes',scope.taskId,recorded,denied,errors,dropped,bytes);
    return {recorded:true as const,nextSequence:high+1};
   });
  },
  page(taskId,q){
   if(typeof taskId!=='string'||!taskId||!q||typeof q!=='object'||Object.keys(q).some(k=>!['limit','cursor'].includes(k)))return fail(400);
   const limit=q.limit===undefined?20:q.limit;if(!Number.isSafeInteger(limit)||limit<1||limit>100)return fail(400);
   let after=0;
   if(q.cursor!==undefined){
    if(typeof q.cursor!=='string'||!q.cursor||q.cursor.length>2048)return fail(400);
    const [body,sig,...extra]=q.cursor.split('.');
    if(!body||!sig||extra.length||!/^[a-f0-9]{64}$/.test(sig)||!timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(mac(body),'hex')))return fail(400);
    let parsed:unknown;try{parsed=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return fail(400);}
    if(!Array.isArray(parsed)||parsed.length!==3||parsed[0]!=='tool-audit-v1'||parsed[1]!==taskId||!Number.isSafeInteger(parsed[2])||parsed[2]<0)return fail(400);
    after=parsed[2];
   }
   const rows=[...sql.exec('SELECT * FROM tool_audit_records WHERE task_id=? AND ord>? ORDER BY ord LIMIT ?',taskId,after,limit+1)];
   const items=rows.slice(0,limit).map(r=>({sequence:Number(r.sequence),tool:String(r.tool),inputDigest:String(r.input_digest),inputSummary:String(r.input_summary),inputTruncated:r.input_truncated===1,outcome:String(r.outcome) as ToolAuditRecord['outcome'],startedAt:Number(r.started_at),durationMs:r.duration_ms===null?null:Number(r.duration_ms),...(r.subagent===1?{subagent:true as const}:{}),runId:String(r.run_id),iteration:Number(r.iteration),receivedAt:Number(r.received_at),source:'worker_report' as const}));
   const page:{items:StoredToolAuditRecord[];totals:ToolAuditTotals;nextCursor?:string}={items,totals:totals(taskId)};
   if(rows.length>limit){const body=Buffer.from(JSON.stringify(['tool-audit-v1',taskId,Number(rows[limit-1]!.ord)])).toString('base64url');page.nextCursor=body+'.'+mac(body);}
   return page;
  }
 };
}
