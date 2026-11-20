import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/control-plane/src/app.js';

const operator='local-development-only',worker='local-worker-only';
const spec={requestId:'native-lane',goal:'synthetic credential serialization',provider:'claude',model:'claude-fixed',endsAt:100000,budgetMicros:10,tools:['Bash'],systems:[],credentialIds:['shared-subscription'],maxRunMs:1000,maxIterations:3};
test('HTTP central claim quarantines shared native credentials through abandoned lease and reconciliation',async t=>{
 let now=1;const app=buildApp({now:()=>now});t.after(()=>app.close());
 const url=await app.listen({host:'127.0.0.1',port:0});
 async function call(path:string,body?:unknown,token=operator){
  const r=await fetch(url+'/v1/autonomous-tasks'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json() as Promise<any>;
 }
 const owner=await call('',spec),other=await call('',{...spec,requestId:'native-other'});
 for(const task of [owner,other])await call(`/${task.id}/approve`,{revision:task.revision,reason:'synthetic policy approval'});
 const {lease}=await call(`/${owner.id}/claim`,{workerId:'one'},worker);
 assert.equal(await call(`/${other.id}/claim`,{workerId:'two'},worker),null);
 now=lease.expiresAt+1;
 assert.equal(await call(`/${other.id}/claim`,{workerId:'two'},worker),null);
 const abandoned=await call(`/${owner.id}`);assert.equal(abandoned.status,'awaiting_input');
 assert.equal(abandoned.runs[0].costMicros,null);
 await call(`/${owner.id}/reconcile-run`,{runId:lease.runId,actualCostMicros:0,reason:'synthetic abandoned run; no provider call occurred'});
 assert.ok((await call(`/${other.id}/claim`,{workerId:'two'},worker)).lease);
 assert.equal((await call(`/${owner.id}`)).status,'awaiting_input');
});

import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Server} from 'node:http';
import type {NativeClaudeRequest} from '../packages/contracts/src/autonomous-native.js';
import {createAutonomousHttpClient,runAutonomousIteration} from '../packages/adapters/src/autonomous-runner.js';
import {EncryptedSessionStore} from '../packages/adapters/src/autonomous-session-store.js';
import {FilePrivateBlobStore} from '../packages/adapters/src/autonomous-session-file.js';

test('synthetic native HTTP restores encrypted parent/child transcripts and workspace in fresh runtimes',async t=>{
 // Dynamic source imports keep backend .ts modules outside the root emitted build.
 const backend=(path:string)=>import(pathToFileURL(resolve('cloudflare/backend/src',path)).href);
 const {createAutonomousBootstrap}=await backend('runtime/autonomous-bootstrap.ts');
 const {executeAutonomousClaude}=await backend('runtime/autonomous-claude.ts');
 const {createNativeHttpAuthorizer}=await backend('runtime/autonomous-authorize.ts');
 const {autonomousProjectDirectory}=await backend('runtime/autonomous-session.ts');
 const {createSnapshot,sha256}=await backend('snapshot.ts');
 const adapterUrl=new URL('../packages/adapters/src/autonomous-claude.js',import.meta.url);
 const {createClaudeAutonomousExecutor,createClaudeRuntimeHttpPort}=await import(adapterUrl.href);
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-http-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const blobs=join(root,'blobs'),key=crypto.getRandomValues(new Uint8Array(32)),auth='sk-ant-oat01-synthetic-only-token';
 const app=buildApp({dbPath:join(root,'control.sqlite')});t.after(()=>app.close());
 const apiUrl=await app.listen({host:'127.0.0.1',port:0});
 async function call(path:string,body?:unknown){
  const r=await fetch(apiUrl+'/v1/autonomous-tasks'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json() as Promise<any>;
 }
 const task=await call('',{...spec,requestId:'native-restore',goal:'synthetic local restoration',tools:['Bash','Agent'],subagentModel:'child-fixed',endsAt:Date.now()+60000,maxRunMs:10000});
 await call(`/${task.id}/approve`,{revision:task.revision,reason:'synthetic native test approval'});
 const initialSnapshot=createSnapshot([{path:'work.txt',content:Buffer.from('initial').toString('base64'),sha256:sha256('initial'),executable:false}]);
 const seen:NativeClaudeRequest[]=[];
 for(let iteration=0;iteration<2;iteration++){
  const home=join(root,`runtime-${iteration}`,'home'),workspace=join(root,`runtime-${iteration}`,'workspace');
  const server:Server=createAutonomousBootstrap({token:'synthetic-runtime-private-token',execute:async(request:NativeClaudeRequest,signal:AbortSignal)=>{
   seen.push(structuredClone(request));assert.equal(request.taskId,task.id);assert.notEqual(request.taskId,request.session.sessionId);
   return executeAutonomousClaude(request,{home,workspace,signal,authorizer:createNativeHttpAuthorizer({url:apiUrl,token:worker}),runtimeId:`12345678-1234-4234-8234-123456789ab${iteration}`,verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),noNewPrivs:1,verified:true,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),runProcess:async(argv:string[],options:{env:NodeJS.ProcessEnv})=>{
    // Trusted fake CLI + fake Linux boundary: no provider process is spawned.
    const id=request.session.sessionId,project=autonomousProjectDirectory(home),parent=join(project,id+'.jsonl'),child=join(project,id,'subagents','agent-child.jsonl');
    assert.equal(argv[0],'/usr/local/bin/claude');assert.equal(argv[argv.indexOf('--model')+1],spec.model);
    assert.equal(JSON.parse(argv[argv.indexOf('--agents')+1]!).worker.model,'child-fixed');
    assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN,auth);assert.equal(options.env.CONTROL_TOKEN,undefined);
    if(iteration===0){
     assert.equal(argv[argv.indexOf('--session-id')+1],id);assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'initial');
     await mkdir(join(project,id,'subagents'),{recursive:true});await writeFile(parent,'{"kind":"parent-private"}\n');await writeFile(child,'{"kind":"child-private"}\n');await writeFile(join(workspace,'work.txt'),'restored-private-work');
    }else{
     assert.equal(argv[argv.indexOf('--resume')+1],id);assert.equal(argv.includes('--session-id'),false);
     assert.equal(await readFile(parent,'utf8'),'{"kind":"parent-private"}\n');assert.equal(await readFile(child,'utf8'),'{"kind":"child-private"}\n');
     assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'restored-private-work');
    }
    return {status:'passed',exitCode:0,stderr:'',durationMs:1,truncated:false,stdout:JSON.stringify({type:'system',subtype:'init',session_id:id,model:request.model})+'\n'+JSON.stringify({type:'result',session_id:id,subtype:'success',is_error:false,result:'{"outcome":"continue"}',usage:{input_tokens:12,cache_read_input_tokens:iteration?7:0,cache_creation_input_tokens:3,output_tokens:2}})};
   }});
  }});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
  try{
   const runtime=createClaudeRuntimeHttpPort({url:`http://127.0.0.1:${address.port}/iteration`,token:'synthetic-runtime-private-token'});
   const sessions=new EncryptedSessionStore({key,blobs:new FilePrivateBlobStore({root:blobs})});
   const options={client:createAutonomousHttpClient({apiUrl,workerToken:worker}),taskId:task.id,workerId:`fresh-${iteration}`,sessions,executor:createClaudeAutonomousExecutor({runtime,...(iteration===0?{initialSnapshot}:{})}),nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async(ids:readonly string[])=>{assert.deepEqual(ids,spec.credentialIds);return {claudeSubscription:auth};}};
   assert.equal(await runAutonomousIteration(options),true);
   const paused=await call(`/${task.id}`);assert.equal(paused.status,'awaiting_input');assert.equal(paused.runs[iteration].costMicros,null);
   assert.equal(await runAutonomousIteration(options),false);assert.equal(seen.length,iteration+1);
   assert.doesNotMatch(JSON.stringify(paused),/parent-private|child-private|restored-private-work|synthetic-runtime-private-token|sk-ant-oat01|127\.0\.0\.1|objectKey/);
   await call(`/${task.id}/reconcile-run`,{runId:paused.runs[iteration].runId,actualCostMicros:0,reason:'Synthetic fake CLI only; no paid provider execution'});
   assert.equal((await call(`/${task.id}`)).status,'awaiting_input');
   await call(`/${task.id}/resume`,{revision:task.revision,reason:'Explicit synthetic iteration resume'});
  }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
 }
 assert.equal(seen[0]!.session.sessionId,seen[1]!.session.sessionId);assert.equal(seen[1]!.session.sequence,1);
 assert.equal(seen[1]!.session.model,spec.model);assert.equal(seen[1]!.initialSnapshot,undefined);
 const finished=await call(`/${task.id}`);assert.deepEqual(finished.runs.map((r:any)=>r.usage.cacheReadTokens),[0,7]);
 for(const name of await readdir(blobs)){const bytes=await readFile(join(blobs,name));assert.equal(bytes.includes(Buffer.from('parent-private')),false);assert.equal(bytes.includes(Buffer.from('restored-private-work')),false);}
});

test('HTTP native-start binds a claimed lease to one runtime and returns canonical policy',async t=>{
 const app=buildApp({now:()=>1});t.after(()=>app.close());
 const apiUrl=await app.listen({host:'127.0.0.1',port:0});
 const post=async(path:string,body:unknown,token:string)=>fetch(apiUrl+'/v1/autonomous-tasks'+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const created=await post('',{...spec,requestId:'native-binding'},operator);assert.equal(created.status,201);const task=await created.json() as any;
 const unclaimed={taskId:task.id,workerId:'unclaimed',runId:'unclaimed',token:'not-a-claim',expiresAt:1001};
 assert.equal((await post(`/${task.id}/native-start`,{lease:unclaimed,runtimeId:'fresh-0'},worker)).status,409);
 assert.equal((await post(`/${task.id}/approve`,{revision:task.revision,reason:'approved test scope'},operator)).status,200);
 const claimed=await post(`/${task.id}/claim`,{workerId:'runtime-worker'},worker);const {lease}=await claimed.json() as any;
 const started=await post(`/${task.id}/native-start`,{lease,runtimeId:'fresh-0'},worker);assert.equal(started.status,200);
 const authorization=await started.json() as any;assert.equal(authorization.taskId,task.id);assert.deepEqual(authorization.spec,task.spec);assert.equal(authorization.deadline,1001);
 assert.equal((await post(`/${task.id}/native-start`,{lease,runtimeId:'fresh-1'},worker)).status,409);
});

for(const changed of ['goal','tools'] as const)test(`direct private runtime refuses forged ${changed} with a real claim before fake CLI`,async t=>{
 const backend=(path:string)=>import(pathToFileURL(resolve('cloudflare/backend/src',path)).href);
 const {createAutonomousBootstrap}=await backend('runtime/autonomous-bootstrap.ts');
 const {executeAutonomousClaude}=await backend('runtime/autonomous-claude.ts');
 const {createNativeHttpAuthorizer}=await backend('runtime/autonomous-authorize.ts');
 const {createSnapshot}=await backend('snapshot.ts');
 const {createClaudeRuntimeHttpPort}=await import(new URL('../packages/adapters/src/autonomous-claude.js',import.meta.url).href);
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-forged-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=buildApp();t.after(()=>app.close());const apiUrl=await app.listen({host:'127.0.0.1',port:0});
 const post=async(path:string,body:unknown,token=operator)=>{
  const response=await fetch(apiUrl+'/v1/autonomous-tasks'+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.ok(response.ok,`${response.status}: ${await response.clone().text()}`);return response.json() as Promise<any>;
 };
 const task=await post('',{...spec,requestId:`forged-${changed}`,subagentModel:spec.model,endsAt:Date.now()+60000,maxRunMs:10000});
 let cliCalls=0;const controlStatuses:number[]=[];
 const server:Server=createAutonomousBootstrap({token:'synthetic-private-runtime-token',execute:(request:NativeClaudeRequest,signal:AbortSignal)=>executeAutonomousClaude(request,{
  authorizer:createNativeHttpAuthorizer({url:apiUrl,token:worker,fetchImpl:async(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1])=>{const response=await fetch(input,init);controlStatuses.push(response.status);return response;}}),runtimeId:'12345678-1234-4234-8234-123456789abc',home:join(root,'home'),workspace:join(root,'workspace'),signal,
  verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),noNewPrivs:1,verified:true,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),
  runProcess:async()=>{cliCalls++;throw Error('Unexpected fake CLI invocation');},
 })});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
 const runtime=createClaudeRuntimeHttpPort({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:'synthetic-private-runtime-token'});
 const request:NativeClaudeRequest={version:1,taskId:task.id,executionLease:{taskId:task.id,workerId:'unclaimed',runId:'unclaimed',token:'not-central-claim-token',expiresAt:Date.now()+10000},model:spec.model,subagentModel:spec.model,tools:['Bash'],goal:spec.goal,session:{sessionId:'12345678-1234-4234-8234-123456789abc',model:spec.model,sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-auth-token',maxRunMs:10000,initialSnapshot:createSnapshot([])};
 await assert.rejects(runtime.execute(request,new AbortController().signal));assert.equal(cliCalls,0);
 await post(`/${task.id}/approve`,{revision:task.revision,reason:'synthetic approval'});
 const {lease}=await post(`/${task.id}/claim`,{workerId:'claimed-worker'},worker);
 request.executionLease=lease;
 if(changed==='goal')request.goal='unapproved goal';else request.tools=['Bash','Agent'];
 await assert.rejects(runtime.execute(request,new AbortController().signal));assert.equal(cliCalls,0);
 assert.deepEqual(controlStatuses,[409,200]);
});
