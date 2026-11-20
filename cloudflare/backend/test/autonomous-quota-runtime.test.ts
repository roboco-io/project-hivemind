import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeAutonomousClaude,type AutonomousClaudeOptions} from '../src/runtime/autonomous-claude.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {NativeClaudeRequest} from '../../../packages/contracts/src/autonomous-native.ts';
import type {NativeAuthorizer} from '../src/runtime/autonomous-authorize.ts';
const sessionId='12345678-1234-4234-8234-123456789abc',model='Fable-1';
const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const usage={input_tokens:12,cache_read_input_tokens:7,cache_creation_input_tokens:3,output_tokens:2};
// All blocked/error cases in this file are synthetic, not actual CLI captures.
const errorResult=()=>({type:'result',subtype:'error_during_execution',is_error:true,session_id:sessionId,uuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',terminal_reason:'api_error',duration_ms:1,duration_api_ms:1,num_turns:1,stop_reason:null,total_cost_usd:0,usage,modelUsage:{},permission_denials:[],errors:['synthetic error']});
interface Scenario {schedule?:boolean;enabled?:boolean;reporterEnabled?:boolean;transcript?:boolean;error?:string;result?:Record<string,unknown>;model?:string;session?:string;status?:string;terminationReason?:string;truncated?:boolean;rejectReport?:boolean;beforeExit?:()=>Promise<void>}
async function run(s:Scenario={}){
 const root=await mkdtemp(join(await realpath(tmpdir()),'quota-synthetic-')),home=join(root,'home'),workspace=join(root,'workspace');let receipt:any,stopped=false;
 const reset=Math.floor(Date.now()/1000)+30;
 const request:NativeClaudeRequest={version:1,taskId:'synthetic-task',executionLease:{taskId:'synthetic-task',runId:'synthetic-run',workerId:'synthetic-worker',token:'synthetic-lease',expiresAt:Date.now()+60000},model,subagentModel:model,tools:['Bash'],goal:'synthetic quota test',session:{sessionId,model,sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-quota-test',maxRunMs:10000,initialSnapshot:createSnapshot([])};
 const authorizer:NativeAuthorizer={start:async()=>({taskId:request.taskId,spec:{requestId:'synthetic',goal:request.goal,provider:'claude',model,tools:['Bash'],systems:[],credentialIds:['synthetic'],maxRunMs:10000,maxIterations:10,endsAt:Date.now()+60000,budgetMicros:0,billingPolicy:{model:'subscription',budget:'external_actions'},...(s.schedule?{schedule:{kind:'daily' as const,timeZone:'UTC',localTime:'09:00'}}:{})},deadline:Date.now()+10000}),heartbeat:async lease=>lease};
 try{
 const response=await executeAutonomousClaude(request,{
  quotaPauseEnabled:s.enabled??true,authorizer,home,workspace,
  reporter:{quotaPauseEnabled:s.reporterEnabled??true,ready:async()=>{},record:async(_lease,r)=>{assert.equal(stopped,true);if(s.rejectReport)throw Error('synthetic receipt refused');receipt=r;}},
  boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),verified:true,noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),verifyPrerequisites:async()=>{},
  runProcess:async()=>{
   if(s.transcript!==false){const p=autonomousProjectDirectory(home);await mkdir(p,{recursive:true});await writeFile(join(p,sessionId+'.jsonl'),JSON.stringify({type:'synthetic-transcript',sessionId})+'\n');}
   const records:unknown[]=[{type:'system',subtype:'init',session_id:s.session??sessionId,model:s.model??model},{type:'rate_limit_event',uuid,session_id:sessionId,rate_limit_info:{status:'rejected',resetsAt:reset}}];
   if(s.error)records.push({type:'assistant',session_id:sessionId,uuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',parent_tool_use_id:null,error:s.error,message:{role:'assistant',content:[]}});
   if(s.result)records.push(s.result);
   if(s.beforeExit)await s.beforeExit();stopped=true;
   return {status:s.status??'failed',exitCode:1,terminationReason:s.terminationReason??'exit',signal:null,stdout:records.map(r=>JSON.stringify(r)).join('\n'),stderr:'',truncated:s.truncated??false,durationMs:1} as any;
  }
 } as AutonomousClaudeOptions);
 return {response,receipt,reset};
 }finally{await rm(root,{recursive:true,force:true});}
}
test('synthetic quota pause collects actual files and reports unmeasured zero placeholders',async()=>{
 const {response,receipt,reset}=await run();
 assert.equal(response.outcome,'wait');assert.equal(response.wakeAt,reset*1000);assert.equal(response.session.sequence,1);
 assert.equal(response.usageUnavailable,true);assert.deepEqual(response.usage,{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0});
 assert.equal((response.session.data as any).transcripts[0].content,JSON.stringify({type:'synthetic-transcript',sessionId})+'\n');
 assert.deepEqual(receipt.quota,response.quota);assert.equal(receipt.usageUnavailable,true);assert.equal(receipt.stopped,true);
});
test('synthetic typed rate-limit error result preserves trusted usage',async()=>{
 const {response}=await run({error:'rate_limit',result:errorResult()});assert.equal(response.usageUnavailable,undefined);assert.deepEqual(response.usage,{inputTokens:12,cacheReadTokens:7,cacheWriteTokens:3,outputTokens:2});
});
test('synthetic auth failures and unclassified terminal errors never become quota pauses',async()=>{
 for(const s of [{error:'authentication_failed'},{error:'rate_limit',result:{...errorResult(),errors:['authentication_failed']}},{result:errorResult()},{error:'rate_limit',result:{...errorResult(),startup_failure_reason:'unknown'}},{error:'rate_limit',result:{...errorResult(),usage:{}}}])await assert.rejects(run(s));
});
test('synthetic quota requires explicit runtime and reporter gates and actual transcript',async()=>{
 for(const s of [{enabled:false},{reporterEnabled:false},{transcript:false},{rejectReport:true},{model:'other'},{session:'87654321-1234-4234-8234-123456789abc'},{truncated:true},{terminationReason:'signal'},{status:'timed_out'}])await assert.rejects(run(s));
});
test('synthetic response waits for child completion before collection and receipt',async()=>{
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;}),stop=new Promise<void>(r=>{release=r;});let settled=false;
 const pending=run({beforeExit:async()=>{started();await stop;}}).then(r=>{settled=true;return r;});await ready;await new Promise<void>(r=>setImmediate(r));assert.equal(settled,false);release();assert.equal((await pending).response.outcome,'wait');
});
import {AutonomousCloudController,type AutonomousCloudRecord} from '../src/autonomous-cloud.ts';
import {AutonomousService} from '../src/autonomous-service.ts';
import type {AutonomousTask,AutonomousSpec} from '../../../packages/contracts/src/autonomous.ts';
async function dailyFixture(){
 const wake=Date.parse('2026-11-20T09:00:00Z');let now=wake-1000,id=0;
 const data=new Map<string,unknown>();const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put<T>(key:string,value:T){data.set(key,structuredClone(value));}};
 const transactional={...storage,async transaction<T>(callback:(tx:typeof storage)=>Promise<T>):Promise<T>{const saved=structuredClone(data);try{return await callback(storage);}catch(error){data.clear();for(const [k,v] of saved)data.set(k,v);throw error;}}};
 const service=()=>new AutonomousService(transactional,()=>now);
 const spec:AutonomousSpec={requestId:'daily-synthetic',goal:'daily',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'},endsAt:wake+3*86400000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['synthetic'],maxRunMs:120000,maxIterations:10,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:1000}]}};
 const task=await service().execute('create',{spec}) as AutonomousTask;await service().execute('approve',{id:task.id,revision:1,reason:'approved'});
 const controller=()=>new AutonomousCloudController({storage,service:service(),ports:{available:async()=>true,submit:async i=>({jobId:i.jobId}),poll:async()=>({state:'pending'}),cancel:async()=>{},quarantine:async()=>{}},enabled:true,clock:()=>now,randomId:()=>`synthetic-${++id}`});
 return {wake,task,service,controller,time:(v:number)=>{now=v;},record:()=>data.get('autonomous-cloud:'+task.id) as AutonomousCloudRecord};
}
test('P1 actual cloud controller claims scheduled occurrence after two-second alarm gap and restores real start',async()=>{
 const f=await dailyFixture();f.time(f.wake);await f.controller().step(f.task.id);assert.equal(f.record().phase,'claiming');f.time(f.wake+2000);await f.controller().step(f.task.id);const lease=f.record().lease!;assert.ok(lease);
 await f.controller().step(f.task.id);const live=await f.service().execute('get',{id:f.task.id}) as AutonomousTask;assert.equal(live.iteration,1);
 await f.service().execute('nativeStart',{lease,runtimeId:'runtime'});
 await f.service().execute('recordNativeReceipt',{lease,receipt:{runId:lease.runId,runtimeId:'runtime',sessionId,model:'pinned',sequence:1,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},stopped:true,outcome:'continue'}});
 f.time(f.wake+3000);await f.service().execute('finishCloud',{lease,result:{outcome:'continue',costMicros:null,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},checkpoint:{sessionId,model:'pinned',sequence:1,objectKey:'synthetic-collected'}},checksPassed:true});
 const restored=await f.service().execute('get',{id:f.task.id}) as AutonomousTask;assert.equal(restored.runs[0]!.startedAt,f.wake+2000);assert.equal(restored.runs[0]!.scheduledAt,f.wake);assert.equal(restored.nextRunAt,f.wake+86400000);assert.equal(restored.iteration,1);
});
test('P1 dispatch beyond five-minute grace reschedules without expiring or catchup',async()=>{
 const f=await dailyFixture();f.time(f.wake);await f.controller().step(f.task.id);f.time(f.wake+300001);await f.controller().step(f.task.id);const task=await f.service().execute('get',{id:f.task.id}) as AutonomousTask;assert.equal(task.iteration,0);assert.equal(task.status,'waiting');assert.equal(task.nextRunAt,f.wake+86400000);
});
import {createClaudeRuntimeHttpPort} from '../../../packages/adapters/src/autonomous-claude.ts';
import {validateAutonomousCloudOutput} from '../src/autonomous-cloud-protocol.ts';
test('private quota port and envelope retain only strict wait proof and reject inconsistent placeholders',async()=>{
 const request:NativeClaudeRequest={version:1,taskId:'synthetic-task',executionLease:{taskId:'synthetic-task',runId:'run',workerId:'worker',token:'synthetic-lease',expiresAt:Date.now()+60000},model,subagentModel:model,tools:['Bash'],goal:'synthetic',session:{sessionId,model,sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-quota-test',maxRunMs:1000,initialSnapshot:createSnapshot([])};
 const wakeAt=Date.now()+30000;
 const response={version:1,session:{sessionId,model,sequence:1,data:{version:1,sessionId,model,workspacePath:'/workspace',snapshot:createSnapshot([]),transcripts:[{path:sessionId+'.jsonl',content:'{"type":"synthetic"}\n'}]}},usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},quota:{kind:'rejected',resetsAt:wakeAt,evidence:'claude_rate_limit_event'},usageUnavailable:true,outcome:'wait',wakeAt,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 const execute=(r:unknown)=>createClaudeRuntimeHttpPort({url:'http://127.0.0.1:4321',token:'synthetic-port-token',fetchImpl:async()=>Response.json(r)}).execute(request,new AbortController().signal);
 assert.deepEqual(await execute(response),response);
 const envelope=(r:unknown)=>({version:1,jobId:'synthetic',attempt:sessionId,ok:true,response:r});assert.deepEqual(validateAutonomousCloudOutput(envelope(response)).response,response);
 for(const patch of [{outcome:'complete'},{wakeAt:wakeAt+1},{quota:{...response.quota,private:'bad'}},{quota:undefined},{usageUnavailable:false},{usage:{...response.usage,inputTokens:1}},{session:{...response.session,data:null}},{wakeAt:0,quota:{...response.quota,resetsAt:0}}]){
  const bad={...response,...patch};await assert.rejects(execute(bad));assert.throws(()=>validateAutonomousCloudOutput(envelope(bad)));
 }
 await assert.rejects(execute({...response,session:{...response.session,sequence:2}}));
});
test('synthetic schema success with is_error true is classified only with typed rate-limit assistant',async()=>{
 const terminal={...errorResult(),subtype:'success',result:'synthetic quota error'};delete (terminal as any).errors;
 const {response}=await run({error:'rate_limit',result:terminal});assert.equal(response.outcome,'wait');assert.equal(response.usage.inputTokens,12);
 await assert.rejects(run({error:'authentication_failed',result:terminal}));
});

test('runtime preserves quota reset when canonical authorization also has daily schedule',async()=>{const {response,receipt,reset}=await run({schedule:true});assert.equal(response.wakeAt,reset*1000);assert.equal(receipt.wakeAt,reset*1000);assert.deepEqual(response.quota,receipt.quota);});
