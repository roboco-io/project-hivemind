import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,rm,mkdir,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAutonomousExternalRuntime} from '../src/autonomous-external.ts';
import {createExternalSqlStore} from '../../../packages/core/src/autonomous-external-sql.ts';
import {AutonomousService,type AutonomousStorage} from '../src/autonomous-service.ts';
import {Scheduler} from '../src/scheduler.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {sealCredential} from '../src/crypto.ts';
import {runAutonomousFromFile,writeNativePrivate,NATIVE_FILES} from '../src/runtime/autonomous-from-file.ts';
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {createNativeHttpAuthorizer,guardCanonicalNativePolicy} from '../src/runtime/autonomous-authorize.ts';
import {createNativeHttpReporter} from '../src/runtime/autonomous-reporter.ts';
import {handleAutonomousApi} from '../../../apps/control-plane/src/autonomous-api.ts';
import {EncryptedSessionStore} from '../../../packages/adapters/src/autonomous-session-store.ts';
import {R2PrivateBlobStore} from '../src/autonomous-session-objects.ts';
import {nativeJobKey,type NativeJobPrivate,type NativeCloudEnv} from '../src/cloudflare/autonomous-ports.ts';
import type {AutonomousCloudRecord} from '../src/autonomous-cloud.ts';
import type {AutonomousTask,AutonomousSpec} from '../../../packages/contracts/src/autonomous.ts';
import type {AutonomousCloudInput} from '../src/autonomous-cloud-protocol.ts';
import type {NativeClaudeRequest} from '../../../packages/contracts/src/autonomous-native.ts';
import {approveAutonomousWeb,validateAutonomousWebGrant} from '../src/runtime/autonomous-web.ts';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'),shortCircuit:true};return next(specifier,context);}});
const spec:AutonomousSpec={requestId:'synthetic-remaining',goal:'private integration fixture',provider:'claude',model:'operator-pinned-model',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:500000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:2,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'counter',argv:['node','check.mjs'],timeoutMs:10000}]}};
async function approveActorThroughHttp(storage:AutonomousStorage,env:NativeCloudEnv,task:Pick<AutonomousTask,'id'|'revision'>){
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');const pending:Promise<unknown>[]=[];
 const actor=new SchedulerDO({storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}} as never,env as never);await Promise.all(pending);
 const response=await actor.fetch(new Request(new URL(`/v1/autonomous-tasks/${task.id}/approve`,env.AUTONOMOUS_CONTROL_ORIGIN),{method:'POST',headers:{authorization:'Bearer '+env.CONTROL_TOKEN,'content-type':'application/json'},body:JSON.stringify({revision:task.revision,reason:'synthetic fixed source approval'})}));assert.equal(response.status,200,await response.text());
}

test('synthetic actor eviction completes two actual private-file/native iterations with one approval and zero real model calls',async t=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');let fakeProcesses=0;const realModelCalls=0;const runtimeStages:string[]=[];
 const rows=new Map<string,unknown>(),artifacts=new Map<string,Uint8Array<ArrayBuffer>>(),credentials=new Map<string,Uint8Array<ArrayBuffer>>(),events:string[]=[];
 let alarm:number|null=null;
 const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put<T>(key:string,value:T){rows.set(key,structuredClone(value));},async delete(key:string){rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const bucket=(map:Map<string,Uint8Array<ArrayBuffer>>)=>({async get(key:string){const bytes=map.get(key);return bytes?{size:bytes.length,async json(){return JSON.parse(new TextDecoder().decode(bytes));},async arrayBuffer(){return new Uint8Array(bytes).buffer;}}:null;},async put(key:string,value:string|Uint8Array<ArrayBuffer>,options?:{onlyIf?:{etagDoesNotMatch:string}}){if(options?.onlyIf&&map.has(key))return null;map.set(key,typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value));events.push('write:'+key);return {};}});
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),auth='sk-ant-oat01-platformfakeonly';
 const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker-role',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter-role',CONTROL_TOKEN:'fixture-operator-role',AUTH_STORAGE_KEY:Buffer.alloc(32,3).toString('base64'),AUTH_RETURN_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}).toString(),AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:bucket(artifacts),CREDENTIALS:bucket(credentials),RUNNER:{getByName:(name:string)=>runner(name)}};
 const initial=createSnapshot([]),service=new AutonomousService(storage);
 const created=await service.execute('create',{spec:{...spec,requestId:'actor-alarm',tools:['Bash'],endsAt:Date.now()+500000,execution:{...spec.execution!,snapshotId:initial.digest}}}) as AutonomousTask;
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:23,objectKey:'credentials/shared/g23.json',quarantined:false});
 await storage.put('state',scheduler.state);
 await env.ARTIFACTS.put('snapshots/'+initial.digest+'.json',JSON.stringify(initial));
 await env.CREDENTIALS.put('credentials/shared/g23.json',JSON.stringify(await sealCredential(auth,'shared',23,env.AUTH_STORAGE_KEY)));
 const inputs=new Map<string,AutonomousCloudInput>(),launched=new Set<string>();
 function runner(name:string){return {
  async ensure(){return {ready:true,lost:false,prepared:inputs.has(name),legacy:!inputs.has(name)};},
  async prepareNative(input:AutonomousCloudInput){assert.equal(input.claudeNestedCompatible,true,'compatibility mode comes from server configuration');inputs.set(name,structuredClone(input));events.push('prepare:'+name);},
  async launchNative(){launched.add(name);},
  async pollNative(){
   const input=inputs.get(name)!;assert.ok(launched.has(name));const sequence=input.request.session.sequence+1;
   if(sequence===2)assert.equal((input.request.session.data as {transcripts:unknown[]}).transcripts.length,1);
   const runtime=await mkdtemp(join(await realpath(tmpdir()),'remaining-native-'));t.after(()=>rm(runtime,{recursive:true,force:true}));
   await writeNativePrivate(join(runtime,NATIVE_FILES.input),input);
   const central:typeof fetch=async(url,init)=>{const response=await handleAutonomousApi(new Request(String(url),init),{operatorToken:env.CONTROL_TOKEN,workerToken:env.AUTONOMOUS_WORKER_TOKEN,reporterToken:env.AUTONOMOUS_REPORTER_TOKEN,service});runtimeStages.push(new URL(String(url)).pathname.split('/').at(-1)+':'+response.status);return response;};
   const home=join(runtime,'home'),workspace=join(runtime,'workspace');
   const result=await runAutonomousFromFile(runtime,{execute:(request,options)=>executeAutonomousClaude(request,{
    ...options,home,workspace,authorizer:createNativeHttpAuthorizer({url:env.AUTONOMOUS_CONTROL_ORIGIN,token:env.AUTONOMOUS_WORKER_TOKEN,fetchImpl:central}),
    reporter:createNativeHttpReporter({url:env.AUTONOMOUS_CONTROL_ORIGIN,token:env.AUTONOMOUS_REPORTER_TOKEN,fetchImpl:central}),
    verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux',verified:true,checkedAt:new Date().toISOString(),noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),
    runProcess:async(_argv,options)=>{
     fakeProcesses++;runtimeStages.push('process');assert.equal(options.env.AWS_ACCESS_KEY_ID,undefined);assert.equal(options.env.CONTROL_TOKEN,undefined);assert.equal(options.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN,undefined);
     runtimeStages.push('env-checked');const directory=autonomousProjectDirectory(home);await mkdir(directory,{recursive:true});await writeFile(join(directory,request.session.sessionId+'.jsonl'),'{"synthetic":"private-transcript"}\n');
     runtimeStages.push('transcript-written');return {status:'passed',exitCode:0,stderr:'',stdout:[{type:'system',subtype:'init',session_id:request.session.sessionId,model:request.model},{type:'result',subtype:'success',is_error:false,session_id:request.session.sessionId,result:JSON.stringify({outcome:sequence===1?'continue':'complete'}),usage:{input_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:1}}].map(x=>JSON.stringify(x)).join('\n'),durationMs:1,truncated:false};
    }
   })});
   runtimeStages.push('result:'+result?.ok);assert.equal(result?.ok,true);assert.equal(await runAutonomousFromFile(runtime,{execute:async()=>{throw Error('private runner replay');}}),undefined);
   return JSON.stringify({lost:false,state:{started:true},result});
  },
  async launch(){},async prepare(){},async cancel(){},
  async poll(){const state=await storage.get<import('../src/contracts.ts').SchedulerState>('state');const job=Object.values(state!.jobs).find(j=>name===j.id+':'+j.attempt)!;assert.equal(job.kind,'compute');events.push('compute:'+job.id);return JSON.stringify({lost:false,state:{started:true},result:{version:1,jobId:job.id,attempt:job.attempt,inputSnapshotId:job.snapshotId,process:{status:'passed',exitCode:0,stdout:'',stderr:'',durationMs:1,truncated:false},credentialsAbsent:true,sourceUnchanged:true,sandboxPolicy:'compute-workspace',boundary:{verified:true,platform:'linux',noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}}});},
  async stop(){events.push('stop:'+name);return true;}
 };}
 await approveActorThroughHttp(storage,env,created);
 for(let step=0;step<24;step++){
  const pending:Promise<unknown>[]=[];
  const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
  const actor=new SchedulerDO(ctx as never,env as never);
  await Promise.all(pending);await actor.alarm();
  const task=await service.execute('get',{id:created.id}) as AutonomousTask;
  if(task.status==='completed')break;
 }
 const task=await service.execute('get',{id:created.id}) as AutonomousTask;
 assert.equal(task.status,'completed',JSON.stringify({runtimeStages,fakeProcesses,status:task.status,reason:task.stopReason,phase:(await storage.get<AutonomousCloudRecord>('autonomous-cloud:'+created.id))?.phase,jobs:Object.values((await storage.get<import('../src/contracts.ts').SchedulerState>('state'))!.jobs).map(j=>({kind:j.kind,status:j.status,error:j.errorCode})),costs:[...inputs.values()].map(i=>i.jobId).map(id=>(rows.get(nativeJobKey(id)) as NativeJobPrivate)?.result?.costMicros)}));assert.equal(task.runs.length,2);assert.equal(inputs.size,2);
 const sessions=[...inputs.values()].map(i=>i.request.session.sessionId);assert.equal(sessions[0],sessions[1]);
 const final=await storage.get<import('../src/contracts.ts').SchedulerState>('state');assert.equal(final!.credentials.shared!.generation,25);
 assert.equal(final!.credentials.shared!.activeJobId,undefined);assert.ok(alarm);
 assert.deepEqual(task.runs.map(run=>run.costMicros),[null,null],'subscription cost remains unmeasured');
 assert.deepEqual(task.runs.map(run=>run.billingEvidence),['subscription_runtime','subscription_runtime']);
 for(const input of inputs.values()){
  const privateJob=await storage.get<NativeJobPrivate>(nativeJobKey(input.jobId));
  assert.equal(privateJob?.result?.costMicros,null,'actual completeNative result must preserve unknown billing');
  assert.ok(privateJob?.result?.checkpoint);
  assert.equal((await new EncryptedSessionStore({key:Buffer.from(env.AUTONOMOUS_SESSION_KEY,'base64'),blobs:new R2PrivateBlobStore({bucket:env.CREDENTIALS})}).load(created.id,privateJob!.result!.checkpoint!))?.sessionId,input.request.session.sessionId);
 }
 assert.equal(events.filter(e=>e.startsWith('compute:')).length,2);assert.equal(fakeProcesses,2);assert.equal(realModelCalls,0);assert.equal(task.interventions.filter(i=>i.kind==='approval').length,1);
 const stop=events.findIndex(e=>e.startsWith('stop:')),write=events.indexOf('write:credentials/shared/g24.json');assert.ok(stop>=0&&write>stop);
 for(const [name,bytes] of artifacts)assert.doesNotMatch(new TextDecoder().decode(bytes),/sk-ant-oat01|private-transcript|wrappedKey|fixture-worker-role|remaining-native-/,'public artifact '+name);
 const pending:Promise<unknown>[]=[],finalActor=new SchedulerDO({storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}} as never,env as never);await Promise.all(pending);
 const publicResponse=await finalActor.fetch(new Request(env.AUTONOMOUS_CONTROL_ORIGIN+'/v1/autonomous-tasks/'+created.id+'/cloud-result',{headers:{authorization:'Bearer '+env.CONTROL_TOKEN}}));assert.equal(publicResponse.status,200);const publicText=await publicResponse.text();
 for(const input of inputs.values())for(const secret of [input.request.executionLease.token,input.request.session.sessionId,auth,env.CONTROL_TOKEN,env.AUTONOMOUS_WORKER_TOKEN])assert.ok(!publicText.includes(secret));assert.doesNotMatch(publicText,/remaining-native-|private-transcript|objectKey/);
});

test('synthetic canonical WebFetch authority and restored per-container grants reject another task host',async()=>{
 const now=Date.now(),rows=new Map<string,unknown>(),storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));}};
 const service=new AutonomousService(storage),task=await service.execute('create',{spec:{...spec,execution:undefined,requestId:'remaining-web',endsAt:now+60000,tools:['Bash','WebFetch'],web:{allowedHosts:['docs.example.com']}}}) as AutonomousTask;
 await service.execute('approve',{id:task.id,revision:1,reason:'synthetic web approval'});const claim=await service.execute('claim',{id:task.id,workerId:'fixture'}) as {lease:import('../../../packages/contracts/src/autonomous.ts').AutonomousLease};
 const authorization=await service.execute('nativeStart',{lease:claim.lease,runtimeId:'web-runtime'}) as Awaited<ReturnType<import('../src/runtime/autonomous-authorize.ts').NativeAuthorizer['start']>>;
 const request:NativeClaudeRequest={version:1,taskId:task.id,executionLease:claim.lease,model:spec.model,subagentModel:spec.model,tools:['Bash','WebFetch'],web:{allowedHosts:['docs.example.com']},goal:spec.goal,session:{sessionId:crypto.randomUUID(),model:spec.model,sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-fixtureonlynotlive',maxRunMs:spec.maxRunMs,initialSnapshot:createSnapshot([])};
 guardCanonicalNativePolicy(request,authorization);assert.throws(()=>guardCanonicalNativePolicy({...request,web:{allowedHosts:['other.example.com']}},authorization));
 const env={AUTONOMOUS_WEB_ENABLED:'true',AUTONOMOUS_WEB_ALLOWED_HOSTS:'docs.example.com,other.example.com',AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'worker',AUTONOMOUS_REPORTER_TOKEN:'reporter',CONTROL_TOKEN:'operator',AUTH_STORAGE_KEY:'storage',AUTH_RETURN_PUBLIC_KEY:'public',AUTH_RETURN_PRIVATE_KEY:'private',CLAUDE_NESTED_APPROVED:'true'};
 const policy=approveAutonomousWeb(authorization.spec.web,env,env.AUTONOMOUS_CONTROL_ORIGIN)!;
 const job={id:'web-job',attempt:'web-attempt',kind:'agent',provider:'claude',autonomous:{taskId:task.id,runId:claim.lease.runId}};
 const grant={...policy,taskId:task.id,jobId:job.id,attempt:job.attempt,expiresAt:now+30000};validateAutonomousWebGrant(grant,job,env,env.AUTONOMOUS_CONTROL_ORIGIN,now);
 const pending:Promise<unknown>[]=[],props:unknown[]=[],binding={fetch:async()=>new Response('synthetic')};
 const ctx={storage,exports:{NativeClaudeOutbound(value:unknown){props.push(value);return binding;}},blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;},container:{running:true,async interceptAllOutboundHttp(){},async interceptOutboundHttps(){},getTcpPort(){return {async fetch(){return Response.json({ok:false});}};}}};
 const {RunnerDO,NativeClaudeOutbound}=await import('../src/cloudflare/worker.ts');const runner=new RunnerDO(ctx as never,env as never);await Promise.all(pending);await runner.ensure(job as never,grant);
 const restored=new RunnerDO(ctx as never,env as never);await pending.at(-1);await assert.rejects(restored.ensure(job as never,{...grant,allowedHosts:['other.example.com']}));assert.deepEqual(props[0],{props:{webGrant:grant}});
 const outbound=new NativeClaudeOutbound({props:{webGrant:grant}} as never,env as never);assert.equal((await outbound.fetch(new Request('https://unapproved.example.com'))).status,403);
});

test('REQUIRED actor external approval must succeed after concrete factory wiring',async t=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[],storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},async getAlarm(){return null;},async setAlarm(){}};
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const sql={exec(query:string,...bindings:(string|number|null)[]){const stmt=db.prepare(query);if(stmt.columns().length)return stmt.all(...bindings);stmt.run(...bindings);return [];},transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const snapshot=createSnapshot([]),externalProfile={id:'hf-profile',provider:'hf',enabled:true,target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit'],credentialRef:'hf-ref',maxLifetimeMs:10000,upperBoundMicros:100,maxActiveActions:1};
 const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:Buffer.alloc(32,3).toString('base64'),AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true',AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[externalProfile],providers:{hf:{enabled:true,repository:'owner/model',revision:'main'}}}),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'hf-ref':{provider:'hf',token:'SYNTHETIC_NOT_REAL_TOKEN'}}),ARTIFACTS:{async get(){return {async json(){return snapshot;},size:2,body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{}'));c.close();}})};}}};
 const service=new AutonomousService(storage),task=await service.execute('create',{spec:{...spec,execution:{...spec.execution!,snapshotId:snapshot.digest},requestId:'unwired-actor-proof',endsAt:Date.now()+500000,tools:['Bash','mcp__hivemind__action'],systems:['hf'],externalProfiles:['hf-profile']}}) as AutonomousTask;
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'synthetic/auth',quarantined:false});await storage.put('state',scheduler.state);
 const runtime=createAutonomousExternalRuntime({env,core:service,sql,artifacts:env.ARTIFACTS,fetch:async()=>{assert.fail('Approval must not call providers');}})!;
 const metadata=await runtime.service.profiles(task.id);assert.equal(metadata[0]?.enabled,true);const hashes=Object.fromEntries(metadata.map(p=>[p.id,p.profileHash]));
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts'),actor=new SchedulerDO({storage:{...storage,sql,transactionSync:sql.transactionSync},blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}} as never,env as never);await Promise.all(pending);
 const response=await actor.fetch(new Request('https://control.example/v1/autonomous-tasks/'+task.id+'/approve',{method:'POST',headers:{authorization:'Bearer fixture-operator','content-type':'application/json'},body:JSON.stringify({revision:1,reason:'synthetic approval',externalProfileHashes:hashes})}));
 assert.equal(response.status,200,'Required actor/factory seam is not yet wired; 503 is a blocker, not feature success');assert.equal((await service.execute('get',{id:task.id}) as AutonomousTask).status,'ready');
 assert.equal(createExternalSqlStore(sql).transaction(s=>Object.values(s.approvals).filter(a=>a.taskId===task.id).length),1);
});
