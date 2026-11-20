import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousCloudController} from '../src/autonomous-cloud.ts';
import type {AutonomousCloudPorts,AutonomousCloudRecord,AutonomousCloudPoll,AutonomousCloudSubmission} from '../src/autonomous-cloud.ts';
import {AutonomousService,type AutonomousStorage} from '../src/autonomous-service.ts';
import type {AutonomousTask,AutonomousSpec,AutonomousRunResult} from '../../../packages/contracts/src/autonomous.ts';

const spec:AutonomousSpec={requestId:'server-only',goal:'increment pinned counter',provider:'claude',model:'operator-pinned-model',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:500000,budgetMicros:10,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:2,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'counter',argv:['node','check.mjs'],timeoutMs:10000}]}};
const usage={inputTokens:3,cacheReadTokens:2,cacheWriteTokens:0,outputTokens:1};

/** Real controller/core; only platform lifecycle and scheduler boundaries are faked. */
async function fixture(){
 const data=new Map<string,unknown>(),jobs=new Map<string,AutonomousCloudSubmission>(),trace:string[]=[];
 let now=1,ids=0,configured=true,legacyBusy=false,generation=23,lost=false;
 let poll:AutonomousCloudPoll={state:'pending'};
 const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put<T>(key:string,value:T){data.set(key,structuredClone(value));}};
 const service=()=>new AutonomousService(storage,()=>now);
 const task=await service().execute('create',{spec}) as AutonomousTask;
 await service().execute('approve',{id:task.id,revision:task.revision,reason:'operator approved pinned source'});
 const ports:AutonomousCloudPorts={
  async available(){return configured&&!legacyBusy&&!Array.from(jobs.keys()).some(id=>!trace.includes('released:'+id));},
  async submit(input){
   assert.equal(record()?.phase,'polling','intent saved before external side effect');
   assert.equal(record()?.jobId,input.jobId);assert.equal(jobs.has(input.jobId),false);
   jobs.set(input.jobId,structuredClone(input));trace.push('submit:'+input.jobId);
   if(lost)throw Error('fake accepted job; response lost');return {jobId:input.jobId};
  },
  async poll(id){assert.ok(jobs.has(id));trace.push('poll:'+id);return structuredClone(poll);},
  async cancel(id){trace.push('cancel:'+id);},async quarantine(_credential,id){trace.push('quarantine:'+id);}
 };
 const record=()=>data.get('autonomous-cloud:'+task.id) as AutonomousCloudRecord|undefined;
 // Each alarm reconstructs both service and controller, as after actor eviction.
 const alarm=()=>new AutonomousCloudController({storage,service:service(),ports,enabled:true,clock:()=>now,randomId:()=>`fixed-${++ids}`}).step(task.id);
 const current=()=>service().execute('get',{id:task.id}) as Promise<AutonomousTask>;
 async function launch(){for(let i=0;i<3;i++)await alarm();assert.equal(record()?.phase,'polling');}
 async function nativeFinished(outcome:'continue'|'complete'='complete',checksPassed=true){
  const lease=record()!.lease!,sequence=(await current()).iteration;
  await service().execute('nativeStart',{lease,runtimeId:'fake-runtime-'+sequence});
  await service().execute('recordNativeReceipt',{lease,receipt:{runId:lease.runId,runtimeId:'fake-runtime-'+sequence,sessionId:'same-private-session',model:spec.model,sequence,usage,stopped:true,outcome}});
  // Fake platform confirms actual stop first, then auth generation writeback, then compute.
  trace.push('stopped:'+lease.runId);generation++;trace.push('auth-generation:'+generation);trace.push('compute:'+checksPassed);
  const result:AutonomousRunResult={outcome,costMicros:null,usage,checkpoint:{sessionId:'same-private-session',model:spec.model,sequence,objectKey:'private/encrypted/'+sequence}};
  poll={state:'finished',stopped:true,authSynced:true,checksPassed,snapshotId:String(sequence).repeat(64),result};
  trace.push('released:'+record()!.jobId);
 }
 return {task,data,jobs,trace,record,alarm,current,launch,nativeFinished,service,setLost(){lost=true;},setConfigured(v:boolean){configured=v;},setLegacyBusy(v:boolean){legacyBusy=v;},setPoll(v:AutonomousCloudPoll){poll=v;},time(v:number){now=v;},generation:()=>generation};
}

test('server alarms alone restore job/lease/source and complete two iterations with one session',async()=>{
 const f=await fixture();
 for(let sequence=1;sequence<=2;sequence++){
  await f.launch();const bound=structuredClone(f.record()!);
  assert.equal(bound.snapshotId,sequence===1?'a'.repeat(64):'1'.repeat(64));
  const submitted=f.jobs.get(bound.jobId)!;assert.deepEqual(submitted.lease,bound.lease);
  assert.deepEqual(submitted.task.spec.execution,spec.execution);
  if(sequence===2)assert.equal(submitted.task.checkpoint?.sessionId,'same-private-session');
  await f.nativeFinished(sequence===1?'continue':'complete');
  await f.alarm();assert.equal(f.record()?.phase,'finishing');
  assert.equal((await f.current()).runs.length,sequence-1,'native result is not core completion');
  await f.alarm();assert.equal(f.record()?.phase,'done');assert.equal(f.generation(),23+sequence);
 }
 const task=await f.current();assert.equal(task.status,'completed');assert.equal(task.runs.length,2);
 assert.deepEqual(task.runs.map(r=>r.checkpoint?.sessionId),['same-private-session','same-private-session']);
 assert.equal(f.jobs.size,2);assert.deepEqual(task.spec.execution,spec.execution);
 assert.ok(f.trace.indexOf('stopped:fixed-1')<f.trace.indexOf('auth-generation:24'));
 assert.ok(f.trace.indexOf('auth-generation:24')<f.trace.indexOf('compute:true'));
 const status=await new AutonomousCloudController({storage:{async get<T>(k:string){return f.data.get(k) as T;},async put(){}},service:f.service(),ports:{} as AutonomousCloudPorts,enabled:false}).status(f.task.id);
 assert.doesNotMatch(JSON.stringify(status),/token|lease|private|checkpoint|session/);
});

test('accepted exec with lost response is polled after restart without resubmission',async()=>{
 const f=await fixture();f.setLost();await f.launch();const job=f.record()!.jobId,run=f.record()!.runId;
 for(let i=0;i<3;i++)await f.alarm();assert.equal(f.jobs.size,1);assert.equal(f.record()!.runId,run);
 await f.nativeFinished();await f.alarm();await f.alarm();
 assert.equal((await f.current()).status,'completed');assert.equal(f.trace.filter(x=>x==='submit:'+job).length,1);
});

for(const blocked of ['missing-config','legacy-busy'] as const)test(`${blocked} transfers no auth and creates no native job`,async()=>{
 const f=await fixture();if(blocked==='missing-config')f.setConfigured(false);else f.setLegacyBusy(true);
 for(let i=0;i<5;i++)await f.alarm();assert.equal(f.record(),undefined);assert.equal(f.jobs.size,0);assert.equal(f.generation(),23);
 assert.equal((await f.current()).iteration,0);
});

test('failed compute verifier commits failure and never auto-continues',async()=>{
 const f=await fixture();await f.launch();await f.nativeFinished('continue',false);await f.alarm();await f.alarm();
 assert.equal((await f.current()).status,'failed');for(let i=0;i<5;i++)await f.alarm();assert.equal(f.jobs.size,1);
 assert.equal((await f.current()).runs[0]?.outcome,'continue','verifier failure preserves the model outcome');
});

for(const proof of ['stop','auth'] as const)test(`unconfirmed ${proof} pauses and preserves old job/lane`,async()=>{
 const f=await fixture();await f.launch();await f.nativeFinished();
 const r=f.record()!;f.setPoll({state:'finished',stopped:proof!=='stop',authSynced:proof!=='auth',checksPassed:true,snapshotId:'b'.repeat(64),result:{outcome:'complete',costMicros:null,usage,checkpoint:{sessionId:'same-private-session',model:spec.model,sequence:1,objectKey:'private/encrypted/1'}}});
 await f.alarm();assert.equal(f.record()?.phase,'paused');assert.ok(f.trace.includes('cancel:'+r.jobId));assert.ok(f.trace.includes('quarantine:'+r.jobId));
 for(let i=0;i<3;i++)await f.alarm();assert.equal(f.jobs.size,1);assert.notEqual((await f.current()).status,'completed');
});

for(const boundary of ['cancel','timeout'] as const)test(`${boundary} before late native result cannot become success`,async()=>{
 const f=await fixture();await f.launch();const r=f.record()!;
 if(boundary==='cancel')await f.service().execute('cancel',{id:f.task.id,reason:'operator stop'});else f.time(r.lease!.expiresAt+1);
 await f.alarm();for(let i=0;i<3;i++)await f.alarm();
 assert.notEqual((await f.current()).status,'completed');assert.equal(f.jobs.size,1);
 assert.ok(f.trace.includes('cancel:'+r.jobId));
});

test('unknown result quarantines once and manual core resume cannot silently relaunch old controller',async()=>{
 const f=await fixture();await f.launch();f.setPoll({state:'unknown'});await f.alarm();
 const old=f.record()!.jobId;assert.equal(f.record()?.phase,'paused');
 f.time(10);
 await f.service().execute('reconcileRun',{id:f.task.id,runId:f.record()!.runId,actualCostMicros:0,reason:'fake execution only'});
 await f.service().execute('resume',{id:f.task.id,revision:1,reason:'core resume does not clear private pause'});
 await f.alarm();assert.equal(f.jobs.size,1);assert.equal(f.record()?.jobId,old);assert.equal(f.record()?.phase,'paused');
});

import {Scheduler,validateJobSpec} from '../src/scheduler.ts';
import {LegacyAutonomousCloudPorts,nativeJobKey,nativeApprovalKey,nativeConfigurationFingerprint,type NativeCloudEnv} from '../src/cloudflare/autonomous-ports.ts';
import runtimeManifest from '../runtime-build.json' with {type:'json'};
import type {NativeJobPrivate} from '../src/cloudflare/autonomous-ports.ts';

test('real legacy ports and scheduler persist two jobs and serialize shared credential through stop/auth/checks',async()=>{
 const rows=new Map<string,unknown>();
 const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put<T>(key:string,value:T){rows.set(key,structuredClone(value));}};
 let scheduler=new Scheduler(),ids=0;
 scheduler.registerCredential({id:'shared',provider:'claude',generation:23,objectKey:'credentials/shared/g23',quarantined:false});
 const service=new AutonomousService(storage,()=>10);
 const cloudSpec={...spec,requestId:'real-ports',execution:{...spec.execution!,snapshotId:'a'.repeat(64)}};
 const task=await service.execute('create',{spec:cloudSpec}) as AutonomousTask;
 await service.execute('approve',{id:task.id,revision:1,reason:'pinned integration fixture'});
 const ports=()=>new LegacyAutonomousCloudPorts({scheduler,storage,enabled:()=>true,sourceReady:async()=>true,save:()=>storage.put('legacy-state',scheduler.state)});
 const alarm=()=>new AutonomousCloudController({storage,service,ports:ports(),enabled:true,clock:()=>10,randomId:()=>`real-${++ids}`}).step(task.id);
 for(let sequence=1;sequence<=2;sequence++){
  for(let i=0;i<3;i++)await alarm();
  const record=(await storage.get<AutonomousCloudRecord>('autonomous-cloud:'+task.id))!;
  scheduler=new Scheduler((await storage.get('legacy-state'))!);
  const job=scheduler.dispatch(Date.now())[0]!;assert.equal(job.id,record.jobId);assert.equal(job.credentialGeneration,22+sequence);
  assert.equal(await ports().available(task),false,'shared credential owned by native agent');
  assert.deepEqual(job.autonomous,{taskId:task.id,runId:record.runId});
  assert.doesNotMatch(JSON.stringify(job),/lease|token|private-session/);
  const privateJob=(await storage.get<NativeJobPrivate>(nativeJobKey(job.id)))!;
  assert.deepEqual(privateJob.lease,record.lease);
  const outcome=sequence===1?'continue':'complete';
  await service.execute('nativeStart',{lease:record.lease,runtimeId:privateJob.runtimeId});
  await service.execute('recordNativeReceipt',{lease:record.lease,receipt:{runId:record.runId,runtimeId:privateJob.runtimeId,sessionId:'shared-private-session',model:spec.model,sequence,usage,stopped:true,outcome}});
  privateJob.result={outcome,costMicros:null,usage,checkpoint:{sessionId:'shared-private-session',model:spec.model,sequence,objectKey:'private/encrypted/'+sequence}};
  await storage.put(nativeJobKey(job.id),privateJob);
  assert.deepEqual(await ports().poll(job.id),{state:'pending'});
  assert.equal(scheduler.state.credentials.shared!.generation,22+sequence);
  // Platform fake supplies stop acknowledgement and immutable auth writeback receipt.
  scheduler.agentFinished(job.id,job.attempt,{outputSnapshotId:String(sequence).repeat(64),authGeneration:23+sequence,authObjectKey:`credentials/shared/g${23+sequence}`,containerStopped:true,success:true},Date.now());
  assert.equal(scheduler.state.credentials.shared!.generation,23+sequence);
  assert.equal(scheduler.state.credentials.shared!.activeJobId,undefined);
  assert.deepEqual(await ports().poll(job.id),{state:'pending'},'stop/auth alone cannot bypass compute');
  const checks=scheduler.dispatch(Date.now()).filter(j=>j.kind==='compute');assert.equal(checks.length,1);
  for(const check of checks)scheduler.computeFinished(check.id,check.attempt,{success:true,sourceUnchanged:true,containerStopped:true},Date.now());
  assert.equal((await ports().poll(job.id)).state,'finished');
  await alarm();await alarm();
  assert.equal((await service.execute('get',{id:task.id}) as AutonomousTask).runs.length,sequence);
 }
 assert.equal((await service.execute('get',{id:task.id}) as AutonomousTask).status,'completed');
 assert.equal(scheduler.list().filter(j=>j.kind==='agent').length,2);
 // A legacy owner blocks a new native task on the identical credential.
 scheduler.submit({provider:'claude',credentialId:'shared',snapshotId:'a'.repeat(64),instructions:'legacy',checks:spec.execution!.checks,timeoutMs:120000,idempotencyKey:'legacy-owner'},Date.now());
 assert.equal(await ports().available(task),false);scheduler.dispatch(Date.now());assert.equal(await ports().available(task),false);
});

import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {runAutonomousFromFile,writeNativePrivate,NATIVE_FILES} from '../src/runtime/autonomous-from-file.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {EncryptedSessionStore} from '../../../packages/adapters/src/autonomous-session-store.ts';
import type {PrivateSession} from '../../../packages/adapters/src/autonomous-runner.ts';
import type {BoundaryProbeReport} from '../src/runtime/autonomous-boundary-probe.ts';
import {R2PrivateBlobStore} from '../src/autonomous-session-objects.ts';
import type {AutonomousCloudInput} from '../src/autonomous-cloud-protocol.ts';
import {validateAutonomousCloudInput} from '../src/autonomous-cloud-protocol.ts';

test('real private file runner seals fake auth and restores encrypted R2 session in a fresh runtime without replay',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cloud-private-integration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const publicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString();
 const objects=new Map<string,Uint8Array<ArrayBuffer>>();
 const bucket={async get(key:string){const bytes=objects.get(key);return bytes?{size:bytes.length,async arrayBuffer(){return new Uint8Array(bytes).buffer;}}:null;},async put(key:string,bytes:Uint8Array<ArrayBuffer>,options:{onlyIf:{etagDoesNotMatch:string}}){assert.equal(options.onlyIf.etagDoesNotMatch,'*');assert.equal(objects.has(key),false);objects.set(key,new Uint8Array(bytes));return {};}};
 const key=crypto.getRandomValues(new Uint8Array(32));
 const sessions=()=>new EncryptedSessionStore({key,blobs:new R2PrivateBlobStore({bucket})});
 const taskId='private-task',sessionId=randomUUID(),model='operator-pinned-model';let calls=0;
 let session:PrivateSession={sessionId,model,sequence:0,data:null};
 for(let sequence=1;sequence<=2;sequence++){
  const dir=join(root,'runtime-'+sequence);await mkdir(dir,{mode:0o700});
  const input:AutonomousCloudInput={version:1,...(sequence===2?{claudeNestedCompatible:true}:{}),jobId:randomUUID(),attempt:randomUUID(),runtimeId:randomUUID(),control:{origin:'https://control.example',workerToken:'fake-worker-only',reporterToken:'fake-reporter-only'},authReturnPublicKey:publicKey,request:{version:1,taskId,executionLease:{taskId,runId:'run-'+sequence,workerId:'cloud-driver',token:'fake-lease-only',expiresAt:Date.now()+10000},model,tools:['Bash'],goal:'fixed fixture',session,subscriptionAuth:'sk-ant-oat01-fakeintegrationonly',maxRunMs:1000,...(sequence===1?{initialSnapshot:createSnapshot([])}:{})}};
  await writeNativePrivate(join(dir,NATIVE_FILES.input),input);
  assert.throws(()=>validateAutonomousCloudInput({...input,request:{...input.request,claudeNestedCompatible:true}}),'native request cannot choose server compatibility mode');
  const execute:NonNullable<Parameters<typeof runAutonomousFromFile>[1]>['execute']=async(request,options)=>{
   assert.equal(options?.nestedCompatible,sequence===2,'standalone default stays strict; only private server envelope selects compatibility');
   calls++;assert.equal(request.session.sessionId,sessionId);assert.equal(request.session.sequence,sequence-1);
   if(sequence===2)assert.deepEqual(request.session.data,{transcript:'private-parent-and-child',snapshot:'private-workspace'});
   return {version:1,session:{sessionId,model,sequence,data:{transcript:'private-parent-and-child',snapshot:'private-workspace'}},usage,outcome:sequence===1?'continue':'complete',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
  };
  const output=await runAutonomousFromFile(dir,{execute});assert.equal(output?.ok,true);assert.ok(output?.authReturn);
  assert.equal(output.attempt,input.attempt);assert.doesNotMatch(JSON.stringify(output),/sk-ant-oat01|fake-worker-only|fake-reporter-only|fake-lease-only/);
  assert.equal(await runAutonomousFromFile(dir,{execute}),undefined);assert.equal(calls,sequence);
  const cp=await sessions().save(taskId,output.response!.session);
  session=(await sessions().load(taskId,cp))!;
  await assert.rejects(sessions().load('different-task',cp));
  const persisted=await readFile(join(dir,NATIVE_FILES.result),'utf8');assert.equal(JSON.parse(persisted).attempt,input.attempt);
 }
 assert.equal(objects.size,2);
 for(const bytes of objects.values()){assert.equal(Buffer.from(bytes).includes(Buffer.from('private-parent-and-child')),false);assert.equal(Buffer.from(bytes).includes(Buffer.from('private-workspace')),false);}
});

import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(specifier,context);}});
import {sealCredential} from '../src/crypto.ts';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';

/** Exercise operator approval and its durable configuration pin before reconstructing actors. */
async function approveActorThroughHttp(storage:AutonomousStorage,env:NativeCloudEnv,task:Pick<AutonomousTask,'id'|'revision'>){
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
 const pending:Promise<unknown>[]=[];
 const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const work=fn();pending.push(work);return work;}};
 const actor=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);
 assert.equal(await storage.get(nativeApprovalKey(task.id)),undefined,'direct service creation must not manufacture an approval pin');
 const response=await actor.fetch(new Request(new URL(`/v1/autonomous-tasks/${task.id}/approve`,env.AUTONOMOUS_CONTROL_ORIGIN),{method:'POST',headers:{authorization:`Bearer ${env.CONTROL_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({revision:task.revision,reason:'operator approval through actor HTTP fixture'})}));
 assert.equal(response.status,200,await response.text());
 assert.deepEqual(await storage.get(nativeApprovalKey(task.id)),{revision:task.revision,fingerprint:nativeConfigurationFingerprint(env,runtimeManifest.digest)});
}

test('SchedulerDO alarms alone run two native iterations after actor eviction with platform fakes',async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
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
   const outcome=sequence===1?'continue':'complete';
   events.push('fake-native-start');await service.execute('nativeStart',{lease:input.request.executionLease,runtimeId:input.runtimeId});
   events.push('fake-native-receipt');await service.execute('recordNativeReceipt',{lease:input.request.executionLease,receipt:{runId:input.request.executionLease.runId,runtimeId:input.runtimeId,sessionId:input.request.session.sessionId,model:input.request.model,sequence,usage,stopped:true,outcome}});
   events.push('fake-native-result');const session={...input.request.session,sequence,data:{version:1,sessionId:input.request.session.sessionId,model:input.request.model,workspacePath:'/workspace',snapshot:initial,transcripts:[{path:input.request.session.sessionId+'.jsonl',content:JSON.stringify({private:'fake-transcript'})+'\n'}]}};
   return JSON.stringify({lost:false,state:{started:true},result:{version:1,jobId:input.jobId,attempt:input.attempt,ok:true,authReturn:sealAuth(auth,env.AUTH_RETURN_PUBLIC_KEY),response:{version:1,session,usage,outcome,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}}}});
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
 assert.equal(task.status,'completed',JSON.stringify({status:task.status,reason:task.stopReason,phase:(await storage.get<AutonomousCloudRecord>('autonomous-cloud:'+created.id))?.phase,jobs:Object.values((await storage.get<import('../src/contracts.ts').SchedulerState>('state'))!.jobs).map(j=>({kind:j.kind,status:j.status,error:j.errorCode})),costs:[...inputs.values()].map(i=>i.jobId).map(id=>(rows.get(nativeJobKey(id)) as NativeJobPrivate)?.result?.costMicros)}));assert.equal(task.runs.length,2);assert.equal(inputs.size,2);
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
 assert.equal(events.filter(e=>e.startsWith('compute:')).length,2);
 const stop=events.findIndex(e=>e.startsWith('stop:')),write=events.indexOf('write:credentials/shared/g24.json');assert.ok(stop>=0&&write>stop);
 for(const [name,bytes] of artifacts)assert.doesNotMatch(new TextDecoder().decode(bytes),/sk-ant-oat01|fake-transcript|wrappedKey|fixture-worker-role/,'public artifact '+name);
});

for(const {healthMatches,proofPass} of [{healthMatches:false,proofPass:false},{healthMatches:true,proofPass:false},{healthMatches:true,proofPass:true}])test(`native provider input requires runtime-bound proof (manifest=${healthMatches}, proof=${proofPass})`,async()=>{
 const {RunnerDO}=await import('../src/cloudflare/worker.ts');
 const {default:manifest}=await import('../runtime-build.json',{with:{type:'json'}});
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[],paths:string[]=[];let modelExecs=0,probeExecs=0;
 const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fake-worker-proof',AUTONOMOUS_REPORTER_TOKEN:'fake-reporter-proof',CONTROL_TOKEN:'fake-operator-proof',AUTH_STORAGE_KEY:'fake-storage-proof',AUTH_RETURN_PUBLIC_KEY:'fake-public-proof',AUTH_RETURN_PRIVATE_KEY:'fake-private-proof',CLAUDE_NESTED_APPROVED:'true'};
 const ctx={exports:{NativeClaudeOutbound:{}},storage:{async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put<T>(key:string,value:T){rows.set(key,structuredClone(value));}},blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;},container:{running:false,images:{runtime:'fake-image'},start(){ctx.container.running=true;},async interceptAllOutboundHttp(){},async interceptOutboundHttps(){},getTcpPort(){return {async fetch(request:Request){const path=new URL(request.url).pathname;paths.push(path);return path==='/health'?Response.json({ok:true,runtimeRevision:healthMatches?manifest.digest:'f'.repeat(64)}):Response.json({prepared:true});}};},async destroy(){ctx.container.running=false;},async exec(argv:string[]){if(argv.some(arg=>arg.includes('autonomous-from-file'))){modelExecs++;return {pid:123};}probeExecs++;if(!proofPass)throw Error('Fake probe unsupported');const report:BoundaryProbeReport={passed:true,workspaceWrite:true,outsideWriteDenied:true,runtimeReadDenied:true,claudeReadDenied:true,parentProcDenied:true,authEnvironmentAbsent:true,namespaceGuardActive:true,cleanup:true,errorCategory:'none'};return {pid:122,async output(){return {exitCode:0,stdout:new TextEncoder().encode(JSON.stringify(report)),stderr:new Uint8Array()};}};}}};
 const runner=new RunnerDO(ctx as never,env as never);await Promise.all(pending);
 const job={id:randomUUID(),attempt:randomUUID(),kind:'agent',provider:'claude',autonomous:{taskId:'proof-task',runId:'proof-run'}};
 try{await runner.ensure(job as never);}catch{/* A failed no-model proof may fail ensure itself. */}
 const input:AutonomousCloudInput={version:1,jobId:job.id,attempt:job.attempt,runtimeId:randomUUID(),control:{origin:env.AUTONOMOUS_CONTROL_ORIGIN,workerToken:env.AUTONOMOUS_WORKER_TOKEN,reporterToken:env.AUTONOMOUS_REPORTER_TOKEN},authReturnPublicKey:generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString(),request:{version:1,taskId:'proof-task',executionLease:{taskId:'proof-task',runId:'proof-run',workerId:'proof-worker',token:'fake-proof-lease',expiresAt:Date.now()+10000},model:'pinned-proof-model',tools:['Bash'],goal:'fixed proof fixture',session:{sessionId:randomUUID(),model:'pinned-proof-model',sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-fakeproofonly',maxRunMs:1000,initialSnapshot:createSnapshot([])}};
 if(proofPass){
  assert.equal(modelExecs,0);assert.equal(probeExecs,1);assert.deepEqual(paths,['/health']);
  assert.equal((rows.get('metadata') as {nativeBoundaryVerified:string}).nativeBoundaryVerified,manifest.digest);
  await runner.prepareNative(input);await runner.launchNative();await runner.launchNative();assert.equal(modelExecs,1);
  const restored=new RunnerDO(ctx as never,env as never);await pending.at(-1);await restored.ensure(job as never);
  assert.equal(probeExecs,1,'persisted proof is reused only for the pinned runtime');await restored.launchNative();assert.equal(modelExecs,1);
  return;
 }
 await assert.rejects(runner.prepareNative(input),'provider input requires an independently passed boundary proof');
 await assert.rejects(runner.launchNative());
 assert.deepEqual(paths,['/health'],'no provider input crosses native prepare before proof passes');
 assert.equal(modelExecs,0);if(!healthMatches)assert.equal(probeExecs,0,'manifest mismatch precedes even no-model probe');
});

import {createPilotPlan} from '../scripts/autonomous-pilot.ts';
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';

test('unmodified generated pilot plan passes real core create approve cloud claim and native authorization',()=>{
 const plan=createPilotPlan({provider:'claude',model:'claude-opus-5-5',requestId:'t5-generated-plan',now:1000});
 const engine=new AutonomousEngine();
 const task=engine.create(plan.draft,1000,'generated-plan');
 engine.approve(task.id,task.revision,'operator-pinned generated plan',1001);
 assert.equal(engine.claim(task.id,'ordinary-worker','ordinary-token','ordinary-run',1002),null);
 const lease=engine.claimCloud(task.id,'cloud-driver','private-token','cloud-run',1002);assert.ok(lease);
 const authorization=engine.nativeStart(lease,'fixed-runtime',1003);
 assert.deepEqual(authorization.spec,task.spec);
 assert.deepEqual(authorization.spec.tools,['Bash']);assert.ok(authorization.spec.budgetMicros>0);
 assert.equal(authorization.spec.execution?.snapshotId,plan.snapshot.digest);
 assert.deepEqual(authorization.spec.execution?.checks,plan.draft.execution.checks);
 assert.equal(plan.remoteMutation,false);
});

test('trusted unstarted poll finishes failed at known zero without native start or retry',async()=>{
 const f=await fixture();await f.launch();
 f.setPoll({state:'unstarted',stopped:true,authSynced:true});
 await f.alarm();assert.equal(f.record()?.phase,'finishing-unstarted');
 await f.alarm();assert.equal(f.record()?.phase,'done');
 const task=await f.current();assert.equal(task.status,'failed');assert.equal(task.runs.length,1);
 assert.equal(task.runs[0]?.costMicros,0);assert.equal(task.runs[0]?.outcome,'failed');
 assert.deepEqual(task.runs[0]?.usage,{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0});
 assert.equal(task.runs[0]?.billingEvidence,undefined);assert.equal(task.checkpoint,undefined);
 assert.equal(f.generation(),23);assert.equal(f.trace.some(e=>e.startsWith('quarantine:')),false);
 for(let i=0;i<4;i++)await f.alarm();assert.equal(f.jobs.size,1,'preflight failure never automatically retries');
});

test('unstarted zero proof after nativeStart is rejected and retains unknown execution accounting',async()=>{
 const f=await fixture();await f.launch();const record=f.record()!;
 await f.service().execute('nativeStart',{lease:record.lease,runtimeId:'already-native-started'});
 f.setPoll({state:'unstarted',stopped:true,authSynced:true});await f.alarm();await f.alarm();
 assert.equal(f.record()?.phase,'paused');assert.ok(f.trace.includes('quarantine:'+record.jobId));
 const task=await f.current();assert.notEqual(task.status,'completed');assert.equal(task.runs[0]?.costMicros,null);
 for(let i=0;i<4;i++)await f.alarm();assert.equal(f.jobs.size,1);
});

for(const lifecycle of ['proved-unstarted','unknown','launched'] as const)test(`actual actor preflight failure with ${lifecycle} proof preserves the credential accounting boundary`,async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
 const rows=new Map<string,unknown>();let alarm:number|null=null,authReads=0,modelCalls=0;
 const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put<T>(key:string,value:T){rows.set(key,structuredClone(value));},async delete(key:string){rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const snapshot=createSnapshot([]),service=new AutonomousService(storage);
 const task=await service.execute('create',{spec:{...spec,requestId:'unstarted-'+lifecycle,endsAt:Date.now()+500000,execution:{...spec.execution!,snapshotId:snapshot.digest}}}) as AutonomousTask;
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:23,objectKey:'credentials/shared/g23.json',quarantined:false});await storage.put('state',scheduler.state);
 const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'unstarted-worker-role',AUTONOMOUS_REPORTER_TOKEN:'unstarted-reporter-role',CONTROL_TOKEN:'unstarted-operator-role',AUTH_STORAGE_KEY:'unstarted-storage',AUTH_RETURN_PUBLIC_KEY:'unstarted-public',AUTH_RETURN_PRIVATE_KEY:'unstarted-private',CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:{async get(){return {async json(){return snapshot;}};}},CREDENTIALS:{async get(){authReads++;throw Error('provider auth must remain untouched');}},RUNNER:{getByName(){return {async ensure(){throw Error('Fake unsupported boundary probe');},async stop(){return true;},async nativeLifecycle(){if(lifecycle==='unknown')throw Error('lost lifecycle response');return {native:true,prepared:false,neverLaunched:lifecycle==='proved-unstarted',containerStopped:true};},async prepareNative(){modelCalls++;throw Error('unexpected provider transfer');},async launchNative(){modelCalls++;throw Error('unexpected model call');},async cancel(){}};}}};
 await approveActorThroughHttp(storage,env,task);
 for(let step=0;step<8;step++){
  const pending:Promise<unknown>[]=[];const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
  const actor=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);await actor.alarm();
 }
 const state=(await storage.get<import('../src/contracts.ts').SchedulerState>('state'))!,credential=state.credentials.shared!,job=Object.values(state.jobs).find(j=>j.kind==='agent')!;
 const finished=await service.execute('get',{id:task.id}) as AutonomousTask;
 assert.equal(authReads,0);assert.equal(modelCalls,0);assert.equal(credential.generation,23);
 assert.equal(Object.values(state.jobs).filter(j=>j.kind==='agent').length,1,'no automatic model retry');
 if(lifecycle==='proved-unstarted'){
  assert.equal(job.authDisposition,'unchanged_unstarted');assert.equal(job.authSynced,true);assert.equal(job.containerStopped,true);
  assert.equal(credential.activeJobId,undefined);assert.equal(credential.quarantined,false);
  assert.equal(finished.status,'failed');assert.equal(finished.runs[0]?.costMicros,0);
  assert.deepEqual(finished.runs[0]?.usage,{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0});
  const resumedScheduler=new Scheduler(state);
  const legacy=resumedScheduler.submit({provider:'claude',credentialId:'shared',snapshotId:snapshot.digest,instructions:'new explicitly submitted legacy job',checks:spec.execution!.checks,timeoutMs:120000,idempotencyKey:'after-unstarted'},Date.now());
  const dispatched=resumedScheduler.dispatch(Date.now());assert.equal(dispatched[0]?.id,legacy.id);assert.equal(dispatched[0]?.credentialGeneration,23);
 }else{
  assert.equal(credential.quarantined,true);assert.equal(credential.activeJobId,job.id);assert.equal(job.authDisposition,undefined);
  assert.equal(job.authSynced,false);assert.equal(finished.runs[0]?.costMicros,null);
 }
});

test('unstarted scheduler proof never releases another stream owner or generation',()=>{
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:23,objectKey:'credentials/shared/g23.json',quarantined:false});
 const job=scheduler.submit({provider:'claude',credentialId:'shared',snapshotId:'a'.repeat(64),instructions:'fixed native',checks:spec.execution!.checks,timeoutMs:120000,idempotencyKey:'unstarted-owner'},1000,'native-owner');
 scheduler.state.jobs[job.id]!.autonomous={taskId:'fixed-task',runId:'fixed-run'};scheduler.dispatch(1001);
 for(const change of ['owner','generation'] as const){
  const restarted=new Scheduler(scheduler.state);if(change==='owner')restarted.state.credentials.shared!.activeJobId='different-stream';else restarted.state.credentials.shared!.generation=24;
  const before=structuredClone(restarted.state);
  assert.throws(()=>restarted.failUnstartedNative(job.id,job.attempt,'PROBE_UNSUPPORTED',1002,{containerStopped:true,neverLaunched:true}));
  assert.deepEqual(restarted.state,before);
 }
 const running=new Scheduler(scheduler.state);running.running(job.id,job.attempt,1002);const before=structuredClone(running.state);
 assert.throws(()=>running.failUnstartedNative(job.id,job.attempt,'PROBE_UNSUPPORTED',1003,{containerStopped:true,neverLaunched:true}));assert.deepEqual(running.state,before);
});


test('public autonomous and legacy job schemas reject private nested compatibility selection',()=>{
 const plan=createPilotPlan({provider:'claude',model:'claude-opus-5-5',requestId:'private-setting',now:1000});
 for(const compatibility of [false,true]){
  assert.throws(()=>new AutonomousEngine().create({...plan.draft,claudeNestedCompatible:compatibility} as AutonomousSpec,1000,'private-mode'));
  assert.throws(()=>new AutonomousEngine().create({...plan.draft,execution:{...plan.draft.execution,claudeNestedCompatible:compatibility}} as AutonomousSpec,1000,'private-mode'));
  assert.throws(()=>validateJobSpec({provider:'claude',credentialId:'shared',snapshotId:plan.snapshot.digest,instructions:'fixed task',checks:plan.draft.execution.checks,timeoutMs:120000,idempotencyKey:'private-mode',claudeNestedCompatible:compatibility}));
 }
});
