import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {validateAutonomousCloudOutput} from '../src/autonomous-cloud-protocol.ts';
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';
import {createClaudeAutonomousExecutor,createClaudeRuntimeHttpPort} from '../../../packages/adapters/src/autonomous-claude.ts';
import {MemorySessionStore} from '../../../packages/adapters/src/autonomous-runner.ts';
import type {NativeClaudeRequest,NativeClaudeResponse} from '../../../packages/contracts/src/autonomous-native.ts';
const sessionId='12345678-1234-4234-8234-123456789abc',runtimeId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',model='pinned-latency';
const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};
const auth='sk-ant-oat01-synthetic-latency-test';
// Synthetic CLI output and real temporary session files. No CLI, network or credentials.
async function harness(t:TestContext,mode:'report'|'collect'|'unreported'|'failed-report'|'initially-past'){
 const start=Date.UTC(2026,10,20),reset=start+2000,endsAt=start+3600000;
 t.mock.timers.enable({apis:['Date'],now:start});
 const root=await fs.mkdtemp(join(await fs.realpath(tmpdir()),'quota-latency-')),home=join(root,'home'),workspace=join(root,'workspace');
 const snapshot=createSnapshot([]),engine=new AutonomousEngine();let stopped=false,ready=false,receipt:any,request!:NativeClaudeRequest,observedFuture=false;let receiptRecordedAt:number|undefined;
 const spec={requestId:'synthetic-latency',goal:'synthetic latency test',provider:'claude' as const,model,subagentModel:model,endsAt,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['synthetic'],maxRunMs:60000,maxIterations:5,billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}};
 engine.create(spec,start,'task');engine.approve('task',1,'synthetic explicit approval',start);const lease=engine.claim('task','worker','synthetic-lease','run',start)!;
 const authorizer={async start(r:NativeClaudeRequest,id:string){request=r;return engine.nativeStart(lease,id,Date.now());},async heartbeat(){return engine.heartbeat(lease,Date.now());}};
 const reporter={quotaPauseEnabled:true,async ready(){engine.nativeReady(lease,runtimeId,Date.now());ready=true;},async record(_lease:unknown,value:any){
  assert.equal(ready,true);assert.equal(stopped,true);receipt=structuredClone(value);
  if(mode==='failed-report')throw Error('synthetic report refused');
  if(mode==='report'){
   assert.ok(Date.now()<reset);engine.recordNativeReceipt(lease,value,Date.now());receiptRecordedAt=Date.now();t.mock.timers.setTime(reset+500);
  }else{
   if(mode==='unreported')t.mock.timers.setTime(reset+500);
   assert.ok(Date.now()>reset);
   if(mode==='collect'){engine.recordNativeReceipt(lease,value,Date.now());receiptRecordedAt=Date.now();}
  }
 }};
 const transcript=join(autonomousProjectDirectory(home),sessionId+'.jsonl');
 if(mode==='collect'){
  const original=fs.open;
  t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{if(String(args[0])===transcript){assert.equal(observedFuture,true);t.mock.timers.setTime(reset+500);}return original(...args);});syncBuiltinESMExports();
 }
 try{
 const response=await executeAutonomousClaude({version:1,taskId:'task',executionLease:lease,model,subagentModel:model,tools:['Bash'],goal:spec.goal,session:{sessionId,model,sequence:0,data:null},subscriptionAuth:auth,maxRunMs:60000,initialSnapshot:snapshot},{quotaPauseEnabled:true,runtimeId,authorizer,reporter,home,workspace,verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux',verified:true,noNewPrivs:1,checkedAt:new Date().toISOString(),capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),runProcess:async()=>{
  await fs.mkdir(autonomousProjectDirectory(home),{recursive:true});await fs.writeFile(transcript,'{"type":"synthetic-session-fixture"}\n');stopped=true;observedFuture=Date.now()<reset;
  return {status:'failed',exitCode:1,terminationReason:'exit',signal:null,stderr:'',durationMs:1,truncated:false,stdout:[{type:'system',subtype:'init',model,session_id:sessionId},{type:'rate_limit_event',uuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',session_id:sessionId,rate_limit_info:{status:'rejected',resetsAt:(mode==='initially-past'?start-1000:reset)/1000}}].map(v=>JSON.stringify(v)).join('\n')};
 }});
 return {response,receipt,request,engine,spec,lease,snapshot,reset,receiptRecordedAt};
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
}
async function verifyCompleteFlow(h:Awaited<ReturnType<typeof harness>>){
 assert.ok(Date.now()>h.reset);assert.equal(h.response.quota!.resetsAt,h.reset);assert.equal(h.response.wakeAt,h.reset);assert.equal(h.response.usageUnavailable,true);assert.deepEqual(h.response.usage,zero);
 assert.deepEqual(validateAutonomousCloudOutput({version:1,jobId:'fixture',attempt:runtimeId,ok:true,response:h.response}).response,h.response);
 const runtime=createClaudeRuntimeHttpPort({url:'http://127.0.0.1:4321',token:'synthetic-http-token',fetchImpl:async()=>Response.json(h.response)});
 const executor=createClaudeAutonomousExecutor({runtime,initialSnapshot:h.snapshot});
 const raw=await executor({taskId:'task',spec:h.spec,model,subagentModel:model,session:h.request.session,executionLease:h.lease,credentials:{claudeSubscription:auth},signal:new AbortController().signal,actions:{reserve:async()=>{throw Error();},settle:async()=>{throw Error();}}});
 const store=new MemorySessionStore(),checkpoint=await store.save('task',raw.session);const {session,...result}=raw;
 assert.deepEqual((await store.load('task',checkpoint))!.data,session.data);
 const finished=h.engine.finish(h.lease,{...result,checkpoint},Date.now());assert.equal(finished.status,'waiting');assert.equal(finished.nextRunAt,h.reset);assert.equal(finished.runs[0]!.wakeAt,h.reset);assert.equal(finished.runs[0]!.quota!.resetsAt,h.reset);assert.equal(finished.runs[0]!.usageUnavailable,true);assert.equal(finished.runs[0]!.billingEvidence,'subscription_runtime');assert.deepEqual(finished.runs[0]!.usage,zero);
 const restored=new AutonomousEngine(h.engine.snapshot());restored.tick(Date.now()+1);assert.equal(restored.get('task').status,'ready');assert.equal(restored.get('task').checkpoint!.sequence,1);assert.equal(restored.get('task').checkpoint!.objectKey,checkpoint.objectKey);
}
test('trusted report delay crosses reset through runtime protocol adapter core finish and next tick',async t=>{
 try{const h=await harness(t,'report');assert.ok(h.receiptRecordedAt!<h.reset);await verifyCompleteFlow(h);}finally{t.mock.timers.reset();}
});
test('first actual core receipt AFTER collect delay crosses reset completes protocol adapter finish and next tick',async t=>{
 try{const h=await harness(t,'collect');assert.ok(h.receiptRecordedAt!>h.reset);assert.equal(h.receipt.stopped,true);await verifyCompleteFlow(h);}finally{t.mock.timers.reset();}
});
test('unreported serialized quota still cannot obtain central billing authority after reset',async t=>{
 try{const h=await harness(t,'unreported');assert.equal(h.receiptRecordedAt,undefined);assert.throws(()=>h.engine.finish(h.lease,{outcome:'wait',usage:zero,costMicros:null,quota:h.response.quota,usageUnavailable:true,wakeAt:h.reset,checkpoint:{sessionId,model,sequence:1,objectKey:'unreported-checkpoint'}},Date.now()));}finally{t.mock.timers.reset();}
});
test('failed report or initially expired CLI reset never produces a quota response',async t=>{
 for(const mode of ['failed-report','initially-past'] as const){try{await assert.rejects(harness(t,mode));}finally{t.mock.timers.reset();}}
});
test('ordinary model past wait remains invalid in protocol and private adapter',async()=>{
 const reset=Date.now()-1000;const response:NativeClaudeResponse={version:1,session:{sessionId,model,sequence:1,data:{version:1,sessionId,model,workspacePath:'/workspace',snapshot:createSnapshot([]),transcripts:[{path:sessionId+'.jsonl',content:'{"type":"synthetic"}\n'}]}},usage:zero,outcome:'wait',wakeAt:reset,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 assert.throws(()=>validateAutonomousCloudOutput({version:1,jobId:'fixture',attempt:runtimeId,ok:true,response}));
 const request:NativeClaudeRequest={version:1,taskId:'task',executionLease:{taskId:'task',runId:'run',workerId:'worker',token:'synthetic-lease',expiresAt:Date.now()+30000},model,subagentModel:model,tools:['Bash'],goal:'synthetic',session:{sessionId,model,sequence:0,data:null},subscriptionAuth:auth,maxRunMs:60000,initialSnapshot:createSnapshot([])};
 await assert.rejects(createClaudeRuntimeHttpPort({url:'http://127.0.0.1:4321',token:'synthetic-http-token',fetchImpl:async()=>Response.json(response)}).execute(request,new AbortController().signal));
});
test('elapsed serialized quota cannot escape executor task endsAt',async t=>{
 try{
  const h=await harness(t,'report');const runtime=createClaudeRuntimeHttpPort({url:'http://127.0.0.1:4321',token:'synthetic-http-token',fetchImpl:async()=>Response.json(h.response)});
  const executor=createClaudeAutonomousExecutor({runtime,initialSnapshot:h.snapshot});
  await assert.rejects(executor({taskId:'task',spec:{...h.spec,endsAt:h.reset},model,subagentModel:model,session:h.request.session,executionLease:h.lease,credentials:{claudeSubscription:auth},signal:new AbortController().signal,actions:{reserve:async()=>{throw Error();},settle:async()=>{throw Error();}}}));
 }finally{t.mock.timers.reset();}
});
