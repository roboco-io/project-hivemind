import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AutonomousNativeReceipt} from '../packages/contracts/src/autonomous.js';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Server} from 'node:http';
import {buildApp} from '../apps/control-plane/src/app.js';
import type {NativeClaudeRequest} from '../packages/contracts/src/autonomous-native.js';
import {createAutonomousHttpClient} from '../packages/adapters/src/autonomous-runner.js';
import {runAutonomousLoop} from '../packages/adapters/src/autonomous-loop.js';
import {EncryptedSessionStore} from '../packages/adapters/src/autonomous-session-store.js';
import {FilePrivateBlobStore} from '../packages/adapters/src/autonomous-session-file.js';
import {createClaudeAutonomousExecutor,createClaudeRuntimeHttpPort} from '../packages/adapters/src/autonomous-claude.js';

const operator='local-development-only',worker='local-worker-only',reporterKey='synthetic-separate-reporter-key',ingress='synthetic-private-runtime-key';
test('one approval: native HTTP reporter + encrypted restart + wait + completion, synthetic CLI only',async t=>{
 const backend=(path:string)=>import(pathToFileURL(resolve('cloudflare/backend/src',path)).href);
 const {createAutonomousBootstrap}=await backend('runtime/autonomous-bootstrap.ts');
 const {executeAutonomousClaude}=await backend('runtime/autonomous-claude.ts');
 const {createNativeHttpAuthorizer}=await backend('runtime/autonomous-authorize.ts');
 const {createNativeHttpReporter}=await backend('runtime/autonomous-reporter.ts');
 const {autonomousProjectDirectory}=await backend('runtime/autonomous-session.ts');
 const {createSnapshot,sha256}=await backend('snapshot.ts');
 const root=await realpath(await mkdtemp(join(tmpdir(),'subscription-http-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const dbPath=join(root,'control.sqlite'),blobs=join(root,'blobs'),key=crypto.getRandomValues(new Uint8Array(32));
 let app=buildApp({dbPath,nativeReporterToken:reporterKey});t.after(()=>app.close());
 let apiUrl=await app.listen({host:'127.0.0.1',port:0});
 const operatorPaths:string[]=[];
 async function call(path:string,body?:unknown){
  operatorPaths.push(path);
  const response=await fetch(apiUrl+'/v1/autonomous-tasks'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(response.ok,`${response.status}: ${await response.clone().text()}`);return response.json() as Promise<any>;
 }
 const model='claude-fixed',auth='sk-ant-oat01-synthetic-only-token';
 const task=await call('',{requestId:'subscription-native-http',goal:'synthetic local continuity',provider:'claude',model,subagentModel:'child-fixed',endsAt:Date.now()+60000,maxRunMs:10000,maxIterations:6,budgetMicros:10,tools:['Bash','Agent'],systems:[],credentialIds:['subscription'],billingPolicy:{model:'subscription',budget:'external_actions'}});
 await call(`/${task.id}/approve`,{revision:task.revision,reason:'one explicit synthetic approval'});
 const initialSnapshot=createSnapshot([{path:'work.txt',content:Buffer.from('initial').toString('base64'),sha256:sha256('initial'),executable:false}]);
 const seen:NativeClaudeRequest[]=[],reportRoutes:string[]=[],receipts:AutonomousNativeReceipt[]=[];
 let cliCalls=0,wakeAt=0;
 const server:Server=createAutonomousBootstrap({token:ingress,execute:async(request:NativeClaudeRequest,signal:AbortSignal)=>{
  // Fresh directory + explicit identity simulate a fresh container; no provisioning occurs.
  const runtimeId=randomUUID();
  const iteration=seen.length;seen.push(structuredClone(request));
  const home=join(root,`runtime-${iteration}`,'home'),workspace=join(root,`runtime-${iteration}`,'workspace');
  return executeAutonomousClaude(request,{home,workspace,signal,runtimeId,authorizer:createNativeHttpAuthorizer({url:apiUrl,token:worker}),
   reporter:createNativeHttpReporter({url:apiUrl,token:reporterKey,fetchImpl:async(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{
    assert.equal((init?.headers as Record<string,string>).authorization,`Bearer ${reporterKey}`);
    const route=new URL(String(input)).pathname.split('/').at(-1)!;reportRoutes.push(route);
    if(route==='native-receipt')receipts.push(JSON.parse(String(init?.body)).receipt);
    return fetch(input,init);
   }}),verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),noNewPrivs:1,verified:true,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),
   runProcess:async(argv:string[],options:{env:NodeJS.ProcessEnv})=>{
    cliCalls++;const id=request.session.sessionId,project=autonomousProjectDirectory(home),parent=join(project,id+'.jsonl'),child=join(project,id,'subagents','agent-child.jsonl');
    assert.equal(argv[0],'/usr/local/bin/claude');assert.equal(argv[argv.indexOf('--model')+1],model);assert.equal(JSON.parse(argv[argv.indexOf('--agents')+1]!).worker.model,'child-fixed');
    assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN,auth);assert.equal(options.env.HIVEMIND_NATIVE_REPORTER_TOKEN,undefined);assert.equal(options.env.CONTROL_TOKEN,undefined);
    if(iteration===0){
     assert.equal(argv[argv.indexOf('--session-id')+1],id);assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'initial');
     await mkdir(join(project,id,'subagents'),{recursive:true});await writeFile(parent,'{"kind":"synthetic-parent-private"}\n');await writeFile(child,'{"kind":"synthetic-child-private"}\n');await writeFile(join(workspace,'work.txt'),'synthetic-private-work');
    }else{
     assert.equal(argv[argv.indexOf('--resume')+1],id);assert.equal(await readFile(parent,'utf8'),'{"kind":"synthetic-parent-private"}\n');assert.equal(await readFile(child,'utf8'),'{"kind":"synthetic-child-private"}\n');assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'synthetic-private-work');
    }
    if(iteration===1)wakeAt=Date.now()+500;
    const outcome=iteration===0?{outcome:'continue'}:iteration===1?{outcome:'wait',wakeAt}:{outcome:'complete'};
    return {status:'passed',exitCode:0,stderr:'',durationMs:1,truncated:false,stdout:JSON.stringify({type:'system',subtype:'init',session_id:id,model})+'\n'+JSON.stringify({type:'result',session_id:id,subtype:'success',is_error:false,result:JSON.stringify(outcome),usage:{input_tokens:12,cache_read_input_tokens:iteration?7:0,cache_creation_input_tokens:3,output_tokens:2}})};
   }});
 }});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
 const runtime=createClaudeRuntimeHttpPort({url:`http://127.0.0.1:${(server.address() as {port:number}).port}/iteration`,token:ingress});
 const options=(first:boolean)=>({client:createAutonomousHttpClient({apiUrl,workerToken:worker}),taskId:task.id,workerId:first?'first-worker':'restarted-worker',sessions:new EncryptedSessionStore({key,blobs:new FilePrivateBlobStore({root:blobs})}),executor:createClaudeAutonomousExecutor({runtime,...(first?{initialSnapshot}:{})}),nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async(ids:readonly string[])=>{assert.deepEqual(ids,['subscription']);return {claudeSubscription:auth};},maxIterations:first?2:4,maxIdlePolls:100,pollMs:10});
 assert.deepEqual(await runAutonomousLoop(options(true)),{iterations:2,reason:'iteration_limit'});
 const paused=await call(`/${task.id}`);assert.equal(paused.status,'waiting');assert.equal(paused.nextRunAt,wakeAt);assert.equal(cliCalls,2);
 await app.close();app=buildApp({dbPath,nativeReporterToken:reporterKey});apiUrl=await app.listen({host:'127.0.0.1',port:0});
 assert.deepEqual(await runAutonomousLoop(options(false)),{iterations:1,reason:'completed'});
 const finished=await call(`/${task.id}`);
 assert.equal(cliCalls,3);assert.deepEqual(seen.map(r=>r.session.sequence),[0,1,2]);assert.equal(new Set(seen.map(r=>r.session.sessionId)).size,1);assert.equal(seen[2]!.initialSnapshot,undefined);
 assert.deepEqual(finished.runs.map((r:any)=>r.costMicros),[null,null,null]);assert.deepEqual(finished.runs.map((r:any)=>r.billingEvidence),['subscription_runtime','subscription_runtime','subscription_runtime']);assert.equal(finished.spentMicros,0);
 assert.equal(finished.interventions.filter((i:any)=>i.kind==='approval').length,1);assert.equal(finished.counts.humanInterventions,1);assert.equal(operatorPaths.some(p=>/reconcile|resume/.test(p)),false);
 assert.equal(new Set(receipts.map(r=>r.runtimeId)).size,3);
 assert.deepEqual(receipts.map(r=>r.sequence),[1,2,3]);assert.deepEqual(receipts.map(r=>r.outcome),['continue','wait','complete']);assert.deepEqual(receipts.map(r=>r.wakeAt),[undefined,wakeAt,undefined]);
 assert.deepEqual(reportRoutes,['native-ready','native-receipt','native-ready','native-receipt','native-ready','native-receipt']);
 assert.doesNotMatch(JSON.stringify(finished),/synthetic-parent-private|synthetic-child-private|synthetic-private-work|synthetic-separate-reporter-key|sk-ant-oat01|objectKey/);
 for(const name of await readdir(blobs)){const bytes=await readFile(join(blobs,name));assert.equal(bytes.includes(Buffer.from('synthetic-parent-private')),false);assert.equal(bytes.includes(Buffer.from('synthetic-private-work')),false);}
});

test('synthetic 24h core clock restores subscription wait without human reconciliation',async()=>{
 const {AutonomousEngine}=await import('../packages/core/src/autonomous.js');
 const day=24*60*60*1000;let now=1,engine=new AutonomousEngine();
 const spec={requestId:'synthetic-24h',goal:'virtual time only; no CLI or cache proof',provider:'claude' as const,model:'fixed-model',endsAt:day*2,budgetMicros:1,tools:['Bash'],systems:[],credentialIds:['subscription'],maxRunMs:1000,maxIterations:5,billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}};
 engine.create(spec,0,'task');engine.approve('task',1,'one synthetic approval',0);
 // This fixture exercises loop/core persistence, not runtime or artifact storage.
 const {MemorySessionStore}=await import('../packages/adapters/src/autonomous-runner.js');
 const memory=new MemorySessionStore();let calls=0,sleeps=0;
 const client={
  workerState:async()=>{engine.tick(now);return engine.workerState('task');},
  claim:async()=>{const lease=engine.claim('task','worker','private',`run-${calls}`,now);return lease?{lease,task:engine.get('task')}:null;},
  heartbeat:async(lease:import('../packages/contracts/src/autonomous.js').AutonomousLease)=>engine.heartbeat(lease,now),
  finish:async(lease:import('../packages/contracts/src/autonomous.js').AutonomousLease,result:import('../packages/contracts/src/autonomous.js').AutonomousRunResult)=>engine.finish(lease,result,now),
  reserve:async()=>{throw Error('unused');},settle:async()=>{throw Error('unused');},
 };
 const options={client,taskId:'task',workerId:'worker',sessions:{durable:true,load:memory.load.bind(memory),save:memory.save.bind(memory)},nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async()=>({}),maxIterations:1,maxIdlePolls:2,pollMs:60000,now:()=>now,
  wait:async(ms:number)=>{assert.equal(ms,60000);sleeps++;assert.equal(calls,1);now+=day;},
  executor:async(context:import('../packages/adapters/src/autonomous-runner.js').AutonomousExecutionContext)=>{
   calls++;const outcome=calls===1?'wait' as const:'complete' as const,usage={inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};
   engine.nativeStart(context.executionLease,'synthetic-runtime',now);engine.nativeReady(context.executionLease,'synthetic-runtime',now);
   engine.recordNativeReceipt(context.executionLease,{runId:context.executionLease.runId,runtimeId:'synthetic-runtime',sessionId:context.session.sessionId,model:context.model,sequence:context.session.sequence+1,usage,stopped:true,outcome,...(calls===1?{wakeAt:now+day}:{})},now);
   return {outcome,usage,costMicros:null,session:{...context.session,sequence:context.session.sequence+1},...(calls===1?{wakeAt:now+day}:{})};
  }};
 assert.deepEqual(await runAutonomousLoop(options),{iterations:1,reason:'iteration_limit'});
 engine=new AutonomousEngine(engine.snapshot());
 assert.deepEqual(await runAutonomousLoop({...options,maxIterations:2}),{iterations:1,reason:'completed'});
 assert.equal(sleeps,1);assert.equal(now,day+1);assert.equal(calls,2);assert.equal(engine.get('task').counts!.humanInterventions,1);assert.deepEqual(engine.get('task').runs.map(r=>r.costMicros),[null,null]);
});
