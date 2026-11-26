import type {ExternalSqlPort} from '../../core/src/autonomous-external-sql.ts';
import {LARGE_UPLOAD_RECORDS_CEILING,type ExternalLargeRecordPort,type ExternalLargeUploadRecord} from './autonomous-external-large-store.ts';

const MAX_RECORD_BYTES=1024*1024;
function invalid():never{throw new Error('Invalid large upload record');}
const owner=(r:ExternalLargeUploadRecord)=>[r.taskId,r.revision,r.profileId,r.ownerKey,r.path,r.size,r.sha256,r.storageRef].join('\n');
function checked(r:ExternalLargeUploadRecord):ExternalLargeUploadRecord{
 if(!r||typeof r!=='object'||typeof r.uploadId!=='string'||!r.uploadId||typeof r.taskId!=='string'||!r.taskId||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.profileId!=='string'||!r.profileId
  ||!['uploading','complete','aborted','failed','cancelled'].includes(r.status)||!r.parts||typeof r.parts!=='object')invalid();
 return r;
}
/** Durable upload ledger over the same SQL port as the external store. Rows are JSON, so every read and write returns a copy. */
export function createExternalLargeRecordPort(sql:ExternalSqlPort):ExternalLargeRecordPort{
 sql.exec('CREATE TABLE IF NOT EXISTS external_large_uploads(upload_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision INTEGER NOT NULL,profile_id TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL)');
 sql.exec('CREATE INDEX IF NOT EXISTS external_large_uploads_task ON external_large_uploads(task_id,revision)');
 sql.exec('CREATE INDEX IF NOT EXISTS external_large_uploads_task_order ON external_large_uploads(task_id,revision,upload_id)');
 sql.exec('CREATE TABLE IF NOT EXISTS external_large_cancelled(task_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(task_id,revision))');
 const read=(row:Record<string,unknown>):ExternalLargeUploadRecord=>{
  const r=checked(JSON.parse(String(row.json)) as ExternalLargeUploadRecord);
  if(r.uploadId!==row.upload_id||r.taskId!==row.task_id||r.revision!==row.revision||r.profileId!==row.profile_id||r.status!==row.status)invalid();
  return r;
 };
 return {
  async get(uploadId){const row=[...sql.exec('SELECT upload_id,task_id,revision,profile_id,status,json FROM external_large_uploads WHERE upload_id=?',uploadId)][0];return row?read(row):undefined;},
  async put(record){
   const r=checked(structuredClone(record)),json=JSON.stringify(r);if(Buffer.byteLength(json)>MAX_RECORD_BYTES)invalid();
   sql.transactionSync(()=>{
    const prior=[...sql.exec('SELECT upload_id,task_id,revision,profile_id,status,json FROM external_large_uploads WHERE upload_id=?',r.uploadId)][0];
    // The owner, file identity and storage reference of an upload never change after begin.
    if(prior&&owner(read(prior))!==owner(r))invalid();
    sql.exec('INSERT INTO external_large_uploads(upload_id,task_id,revision,profile_id,status,json) VALUES(?,?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET status=excluded.status,json=excluded.json',r.uploadId,r.taskId,r.revision,r.profileId,r.status,json);
   });
  },
  async listTask(taskId,revision){return [...sql.exec('SELECT upload_id,task_id,revision,profile_id,status,json FROM external_large_uploads WHERE task_id=? AND revision=? ORDER BY upload_id LIMIT ?',taskId,revision,LARGE_UPLOAD_RECORDS_CEILING)].map(read);},
  async isCancelled(taskId,revision){return [...sql.exec('SELECT 1 AS x FROM external_large_cancelled WHERE task_id=? AND revision=?',taskId,revision)].length>0;},
  async markCancelled(taskId,revision){sql.exec('INSERT OR IGNORE INTO external_large_cancelled(task_id,revision) VALUES(?,?)',taskId,revision);},
 };
}
