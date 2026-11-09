import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobSpec, JobRecord, Snapshot, RuntimeResult, ProcessResult } from './contracts.ts';
import { validateSnapshot } from './snapshot.ts';
import { readSnapshot, applySnapshot } from './files.ts';
import { parseSandboxReceipts } from './runtime/claude-bash-hook.ts';

const statuses=new Set(['QUEUED','STARTING','RUNNING','VERIFYING','SAVING','SUCCEEDED','FAILED','CANCELLING','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED']);
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid backend response');return value as Record<string,unknown>;};
function jobId(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value))throw new Error('Invalid job ID');return value;}
function checkedJob(value:unknown,expected?:string):JobRecord{const job=object(value);jobId(job.id);if(expected&&job.id!==expected)throw new Error('Backend job does not match request');if(typeof job.status!=='string'||!statuses.has(job.status))throw new Error('Invalid backend job state');return job as unknown as JobRecord;}
export type PublicRuntimeResult=Omit<RuntimeResult,'snapshot'|'authReturn'> & {outputSnapshotId?:string};
export interface ClientCheckResult {job:JobRecord;result?:PublicRuntimeResult}
export interface ClientJobResult {input:Snapshot;output:Snapshot;job:JobRecord;result?:PublicRuntimeResult;checks?:ClientCheckResult[]}
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function checkedRuntimeResult(value:unknown,job:JobRecord):PublicRuntimeResult{
 const result=object(value),process=object(result.process);
 if(result.version!==1||result.jobId!==job.id||result.attempt!==job.attempt||result.inputSnapshotId!==job.snapshotId||
  (result.outputSnapshotId!==undefined&&result.outputSnapshotId!==job.outputSnapshotId))throw new Error('Runtime result binding does not match job');
 if('authReturn' in result||'auth' in result||'snapshot' in result)throw new Error('Unexpected private runtime result fields');
 if(!['passed','failed','timed_out','error','not_run'].includes(String(process.status))||
  !(process.exitCode===null||typeof process.exitCode==='number'&&Number.isSafeInteger(process.exitCode))||
  typeof process.stdout!=='string'||typeof process.stderr!=='string'||!nonnegative(process.durationMs)||typeof process.truncated!=='boolean'||
  (process.startedAt!==undefined&&!nonnegative(process.startedAt))||(process.finishedAt!==undefined&&!nonnegative(process.finishedAt))||
  (typeof process.startedAt==='number'&&typeof process.finishedAt==='number'&&process.finishedAt<process.startedAt))throw new Error('Invalid runtime result process');
 if(typeof result.summary!=='string'||typeof result.sourceUnchanged!=='boolean'||
  (result.credentialsAbsent!==undefined&&typeof result.credentialsAbsent!=='boolean')||
  !['codex-workspace','claude-nested-compatible','claude-strict','compute-workspace'].includes(String(result.sandboxPolicy)))throw new Error('Invalid runtime result metadata');
 if(job.kind==='compute'&&(result.provider!==undefined||result.sandboxPolicy!=='compute-workspace')||job.kind==='agent'&&result.provider!==job.provider)throw new Error('Runtime result provider binding does not match job');
 if(result.sessionId!==undefined&&typeof result.sessionId!=='string')throw new Error('Invalid runtime result session');
 if(result.usage!==undefined&&!Object.values(object(result.usage)).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0))throw new Error('Invalid runtime result usage');
 if(result.subagentReceipts!==undefined&&!Array.isArray(result.subagentReceipts))throw new Error('Invalid runtime result receipts');
 if(result.boundary!==undefined){const boundary=object(result.boundary);if(typeof boundary.platform!=='string'||typeof boundary.checkedAt!=='string'||typeof boundary.verified!=='boolean'||!nonnegative(boundary.noNewPrivs)||!Object.values(object(boundary.capabilities)).every(v=>typeof v==='string'))throw new Error('Invalid runtime result boundary');}
 const safe:Record<string,unknown>={};
 for(const key of ['version','jobId','attempt','inputSnapshotId','outputSnapshotId','summary','sourceUnchanged','credentialsAbsent','provider','sessionId','usage','subagentReceipts','boundary','sandboxPolicy'])if(result[key]!==undefined)safe[key]=result[key];
 if(result.sandboxReceipts!==undefined){
  if(!Array.isArray(result.sandboxReceipts))throw new Error('Invalid sandbox audit metadata');
  safe.sandboxReceipts=parseSandboxReceipts(result.sandboxReceipts.map(receipt=>JSON.stringify(receipt)).join('\n'));
 }
 if(result.mcpReceipts!==undefined){
  if(!Array.isArray(result.mcpReceipts))throw new Error('Invalid MCP receipts');
  safe.mcpReceipts=result.mcpReceipts.map(value=>{
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid MCP receipt');
   const receipt=value as Record<string,unknown>;
   if(typeof receipt.callId!=='string'||!receipt.callId.trim()||receipt.callId.length>256||/[\x00-\x1f\x7f]/.test(receipt.callId)||typeof receipt.nonce!=='string'||!/^[a-f0-9]{32}$/i.test(receipt.nonce)||receipt.marker!=='hivemind-phase0-mcp-v1')throw new Error('Invalid MCP receipt');
   return {callId:receipt.callId,nonce:receipt.nonce,marker:receipt.marker};
  });
 }
 const safeProcess:Record<string,unknown>={};for(const key of ['status','exitCode','stdout','stderr','durationMs','truncated','startedAt','finishedAt'])if(process[key]!==undefined)safeProcess[key]=process[key];
 safe.process=safeProcess as unknown as ProcessResult;return safe as unknown as PublicRuntimeResult;
}
function checkedChecks(value:unknown,parent:JobRecord):ClientCheckResult[]{
 if(!Array.isArray(value)||!Array.isArray(parent.childIds)||!Array.isArray(parent.checks)||value.length!==parent.childIds.length)throw new Error('Invalid check result bindings');
 const seen=new Set<string>(),seenChecks=new Set<string>();
 return value.map(entry=>{
  const item=object(entry),child=checkedJob(item.job);
  if(child.kind!=='compute'||child.parentId!==parent.id||child.snapshotId!==parent.outputSnapshotId||!parent.childIds.includes(child.id)||seen.has(child.id)||typeof child.checkId!=='string'||seenChecks.has(child.checkId)||!parent.checks.some(check=>check.id===child.checkId))throw new Error('Check result binding does not match parent');
  seen.add(child.id);seenChecks.add(child.checkId);
  return {job:child,...(item.result===undefined?{}:{result:checkedRuntimeResult(item.result,child)})};
 });
}
async function responseJson(response:Response):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw new Error('Empty backend response');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16*1024*1024){await reader.cancel();throw new Error('Backend response exceeds size limit');}chunks.push(value);}}finally{reader.releaseLock();}
 const data=Buffer.concat(chunks);try{return JSON.parse(data.toString('utf8'));}catch{throw new Error('Invalid backend JSON response');}
}
export function createClient(baseUrl:string,controlToken:string,fetchImpl:typeof fetch=fetch){
 let url:URL;try{url=new URL(baseUrl);}catch{throw new Error('Invalid backend URL');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Backend URL must be an HTTP(S) origin without credentials');
 if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Backend URL requires HTTPS outside loopback');
 if(typeof controlToken!=='string'||!controlToken.trim()||controlToken.length>4096||/[\r\n]/.test(controlToken))throw new Error('Invalid backend control token');
 const request=async(path:string,method='GET',body?:unknown):Promise<unknown>=>{
  let serialized:string|undefined;if(body!==undefined){try{serialized=JSON.stringify(body);}catch{throw new Error('Invalid backend request payload');}}
  let response:Response;
  try{response=await fetchImpl(new URL(path,url),{method,headers:{authorization:`Bearer ${controlToken}`,...(body===undefined?{}:{'content-type':'application/json'})},body:serialized,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('Backend request could not complete');}
  if(!response.ok)throw new Error(`Backend request rejected (${response.status})`);
  return responseJson(response);
 };
 return {
  async upload(value:Snapshot):Promise<string>{const snapshot=validateSnapshot(value);const result=object(await request(`/v1/snapshots/${snapshot.digest}`,'PUT',snapshot));if(result.snapshotId!==snapshot.digest)throw new Error('Backend snapshot ID mismatch');return snapshot.digest;},
  async submit(spec:JobSpec):Promise<JobRecord>{return checkedJob(await request('/v1/jobs','POST',spec));},
  async get(id:string):Promise<JobRecord>{return checkedJob(await request(`/v1/jobs/${encodeURIComponent(jobId(id))}`),id);},
  async result(id:string):Promise<ClientJobResult>{
   const body=object(await request(`/v1/jobs/${encodeURIComponent(jobId(id))}/result`));const job=checkedJob(body.job,id),input=validateSnapshot(body.input),output=validateSnapshot(body.output);
   if(job.snapshotId!==input.digest||job.outputSnapshotId!==output.digest)throw new Error('Job result snapshot IDs do not match');
   return {input,output,job,...(body.result===undefined?{}:{result:checkedRuntimeResult(body.result,job)}),...(body.checks===undefined?{}:{checks:checkedChecks(body.checks,job)})};
  },
 };
}
function summary(job:JobRecord){return {id:job.id,status:job.status,attempt:job.attempt,snapshotId:job.snapshotId,outputSnapshotId:job.outputSnapshotId,createdAt:job.createdAt,startedAt:job.startedAt,finishedAt:job.finishedAt,errorCode:job.errorCode,childIds:job.childIds};}
export async function runClientCli(args:string[],env:NodeJS.ProcessEnv=process.env,print:(line:string)=>void=console.log,fetchImpl:typeof fetch=fetch):Promise<void>{
 const [command,a,b,c]=args;
 if(command==='snapshot'){
  if(!a||(b!==undefined&&(b!=='--out'||!c))||args.length>4)throw new Error('Usage: snapshot DIRECTORY [--out SNAPSHOT.json]');
  const snapshot=await readSnapshot(a);
  if(b==='--out')await writeFile(c!,JSON.stringify(snapshot)+'\n',{mode:0o600,flag:'wx'});
  print(JSON.stringify({snapshotId:snapshot.digest,fileCount:snapshot.files.length,files:snapshot.files.map(({path,sha256,executable})=>({path,sha256,executable}))}));return;
 }
 if(!['upload','submit','get','result','apply'].includes(command??''))throw new Error('Commands: snapshot, upload, submit, get, result, apply');
 if(!env.HIVEMIND_URL||!env.HIVEMIND_CONTROL_TOKEN)throw new Error('Set HIVEMIND_URL and HIVEMIND_CONTROL_TOKEN');
 const client=createClient(env.HIVEMIND_URL,env.HIVEMIND_CONTROL_TOKEN,fetchImpl);
 if(command==='upload'){if(!a||b)throw new Error('Usage: upload DIRECTORY');const snapshot=await readSnapshot(a);print(JSON.stringify({snapshotId:await client.upload(snapshot),fileCount:snapshot.files.length}));return;}
 if(command==='submit'){if(!a||b)throw new Error('Usage: submit JOB-SPEC.json');let spec:JobSpec;try{spec=JSON.parse(await readFile(a,'utf8'));}catch{throw new Error('Could not read a JSON job specification');}print(JSON.stringify(summary(await client.submit(spec))));return;}
 if(command==='get'){if(!a||b)throw new Error('Usage: get JOB-ID');print(JSON.stringify(summary(await client.get(a))));return;}
 if(command==='result'){
  if(!a||(b!==undefined&&(b!=='--out'||!c))||args.length>4)throw new Error('Usage: result JOB-ID [--out RESULT.json]');const result=await client.result(a);
  if(b==='--out')await writeFile(c!,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
  print(JSON.stringify({job:summary(result.job),inputSnapshotId:result.input.digest,outputSnapshotId:result.output.digest,fileCount:result.output.files.length,checks:result.checks?.map(check=>({id:check.job.id,checkId:check.job.checkId,status:check.job.status,exitCode:check.result?.process.exitCode,durationMs:check.result?.process.durationMs}))}));return;
 }
 if(!a||!b||c)throw new Error('Usage: apply JOB-ID DIRECTORY');
 const result=await client.result(a);if(result.job.status!=='SUCCEEDED')throw new Error('Only a SUCCEEDED job may be applied');
 await applySnapshot(b,result.input,result.output);print(JSON.stringify({jobId:result.job.id,status:'APPLIED',snapshotId:result.output.digest}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runClientCli(process.argv.slice(2)).catch(error=>{let text=error instanceof Error?error.message:'Client operation failed';const token=process.env.HIVEMIND_CONTROL_TOKEN;if(token)text=text.replaceAll(token,'[REDACTED]');console.error(text);process.exitCode=1;});
}
