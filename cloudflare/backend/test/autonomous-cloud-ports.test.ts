import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler,validateJobSpec,SchedulerError} from '../src/scheduler.ts';
import type {JobSpec} from '../src/contracts.ts';
const spec:JobSpec={provider:'claude',credentialId:'claude',snapshotId:'a'.repeat(64),instructions:'Bounded native run',checks:[{id:'check',argv:['node','check.js'],timeoutMs:1000}],timeoutMs:120000,idempotencyKey:'native:run'};
function fixture(){const s=new Scheduler();s.registerCredential({id:'claude',provider:'claude',generation:23,objectKey:'credentials/claude/g23.json',quarantined:false});return s;}
test('internal native submit persists fixed identity and replays after restart without a new credential lane',()=>{
 const s=fixture(),fixed='cb37bead-4ecf-4859-a370-b1e1beed5eaa';
 const job=s.submit(spec,1000,fixed);assert.equal(job.id,fixed);assert.equal(job.model,undefined);assert.equal(job.effort,undefined);
 const restarted=new Scheduler(s.state);assert.equal(restarted.submit(spec,1100,fixed).id,fixed);
 assert.throws(()=>restarted.submit(spec,1100,'different'),/identity|idempotency/i);
 restarted.dispatch(1200);assert.equal(restarted.state.credentials.claude!.activeJobId,fixed);assert.equal(restarted.get(fixed).credentialGeneration,23);
});
test('internal fixed identity rejects collisions and invalid IDs without mutation',()=>{
 const s=fixture();s.submit(spec,1000,'native-one');const before=structuredClone(s.state);
 for(const fixed of ['native-one','__proto__','bad/id'])assert.throws(()=>s.submit({...spec,idempotencyKey:'other'},1100,fixed));
 assert.deepEqual(s.state,before);
});
test('public JobSpec rejects autonomous binding and fixed job identity',()=>{
 for(const extra of [{autonomous:{taskId:'task',runId:'run'}},{jobId:'native-one'}])assert.throws(()=>validateJobSpec({...spec,...extra}),/Unexpected/);
});

import {cloudReadiness,allowNativeControl,LegacyAutonomousCloudPorts} from '../src/cloudflare/autonomous-ports.ts';
import type {AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,1).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'worker',AUTONOMOUS_REPORTER_TOKEN:'reporter',CONTROL_TOKEN:'operator',AUTH_RETURN_PUBLIC_KEY:'public',AUTH_RETURN_PRIVATE_KEY:'private',AUTH_STORAGE_KEY:'storage',CLAUDE_NESTED_APPROVED:'true'};
const task={id:'task',spec:{provider:'claude',credentialIds:['claude'],model:'pinned-model',goal:'Bounded native run',maxRunMs:120000,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:spec.checks}},status:'ready'} as AutonomousTask;
test('readiness fails closed and never exposes configuration values',()=>{
 assert.equal(cloudReadiness(env).ready,true);
 for(const change of [{AUTONOMOUS_CLOUD_ENABLED:undefined},{AUTONOMOUS_CONTROL_ORIGIN:'http://control.example'},{AUTONOMOUS_SESSION_KEY:'bad'},{AUTONOMOUS_REPORTER_TOKEN:'worker'}])assert.equal(cloudReadiness({...env,...change}).ready,false);
 assert.equal(JSON.stringify(cloudReadiness(env)).includes('control.example'),false);
});
test('native control allows exact HTTPS origin POST paths and token roles only',()=>{
 const request=(path:string,token='worker',method='POST',origin='https://control.example')=>new Request(origin+path,{method,headers:{authorization:'Bearer '+token}});
 assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/native-start'),env),true);
 assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/native-receipt','reporter'),env),true);
 for(const r of [request('/v1/autonomous-tasks/task/native-receipt'),request('/v1/autonomous-tasks/task/claim'),request('/v1/autonomous-tasks/task/heartbeat','operator'),request('/v1/autonomous-tasks/task/heartbeat','worker','GET'),request('/v1/autonomous-tasks/task/heartbeat','worker','POST','http://control.example'),request('/v1/autonomous-tasks/task/heartbeat?x=1')])assert.equal(allowNativeControl(r,env),false);
});
test('native control also allows tool-call reports (reporter token) and large uploads (worker token, external enabled only)',()=>{
 const request=(path:string,token='worker',method='POST',origin='https://control.example')=>new Request(origin+path,{method,headers:{authorization:'Bearer '+token}});
 assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/tool-calls','reporter'),env),true);
 for(const token of ['worker','operator',''])assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/tool-calls',token),env),false);
 assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/tool-calls','reporter','GET'),env),false);
 const external={...env,AUTONOMOUS_EXTERNAL_ENABLED:'true'};
 for(const step of ['begin','part','complete','abort','manifest']){
  const path='/v1/autonomous-tasks/task/external-large/'+step;
  assert.equal(allowNativeControl(request(path),external),true);assert.equal(allowNativeControl(request(path),env),false);
  for(const token of ['reporter','operator'])assert.equal(allowNativeControl(request(path,token),external),false);
 }
 assert.equal(allowNativeControl(request('/v1/autonomous-tasks/task/external-large/other'),external),false);
});
test('ports defer to queued legacy jobs and existing credential and global pool ownership',async()=>{
 const s=fixture();const rows=new Map<string,unknown>();const ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async<T>(key:string)=>rows.get(key) as T,put:async(key,value)=>{rows.set(key,value);}},enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
 assert.equal(await ports.available(task),true);s.submit({...spec,idempotencyKey:'legacy'},1000);assert.equal(await ports.available(task),false);
 const lease={taskId:'task',runId:'run',workerId:'worker',token:'private',expiresAt:999999};
 // Submission still uses the validated legacy contract, omitting model and effort.
 const submitted=await ports.submit({task,lease,jobId:'native-fixed',idempotencyKey:'native:task:run',snapshotId:spec.snapshotId});
 assert.equal(submitted.jobId,'native-fixed');const job=s.get(submitted.jobId);assert.deepEqual(job.autonomous,{taskId:'task',runId:'run'});assert.equal(job.model,undefined);
 assert.equal(JSON.stringify(job).includes('private'),false);assert.deepEqual(await ports.poll(job.id),{state:'pending'});
});

import {registerHooks} from 'node:module';
import manifest from '../runtime-build.json' with {type:'json'};
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(specifier,context);}});
const boundaryReport={passed:true,namespaceGuardActive:true,workspaceWrite:true,outsideWriteDenied:true,runtimeReadDenied:true,claudeReadDenied:true,parentProcDenied:true,authEnvironmentAbsent:true,cleanup:true,errorCategory:'none'};
const {RunnerDO}=await import('../src/cloudflare/worker.ts');
test('native Runner fences private prepare, gates start environment and persists one cap-dropped launch',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[],starts:any[]=[],execs:any[]=[],paths:string[]=[],intercepts:string[]=[];let revision='f'.repeat(64);
 const ctx={exports:{NativeClaudeOutbound:{}},storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;},container:{running:false,images:{runtime:'fixture'},start:(v:unknown)=>{starts.push(v);ctx.container.running=true;},exec:async(...v:unknown[])=>{execs.push(v);return {pid:123,exitCode:Promise.resolve(0),output:async()=>({exitCode:0,stdout:new TextEncoder().encode(JSON.stringify(boundaryReport)).buffer,stderr:new ArrayBuffer(0)})};},interceptAllOutboundHttp:async()=>{intercepts.push('http');},interceptOutboundHttps:async()=>{intercepts.push('https');},getTcpPort:()=>({fetch:async(r:Request)=>{const path=new URL(r.url).pathname;paths.push(path);if(path==='/health')return Response.json({ok:true,runtimeRevision:revision});assert.ok(r.headers.get('x-hivemind-native'));return Response.json({prepared:true});}})}};
 const runner=new RunnerDO(ctx as any,env as any);await Promise.all(pending);
 const job={id:'native-fixed',attempt:'attempt',kind:'agent',provider:'claude',autonomous:{taskId:'task',runId:'run'}} as any;
 await runner.ensure(job);await assert.rejects(runner.prepareNative({jobId:job.id,attempt:job.attempt} as any),/revision/i);assert.deepEqual(paths,['/health']);
 revision=manifest.digest;await runner.ensure(job);
 // Validator rejects malformed private input even when the runtime revision matches.
 await assert.rejects(runner.prepareNative({jobId:job.id,attempt:job.attempt} as any));
 assert.deepEqual(Object.keys(starts[0].env),['HIVEMIND_NATIVE_GATE_TOKEN']);assert.equal(starts[0].enableInternet,false);assert.deepEqual(intercepts,['http','https','http','https']);
 const metadata=rows.get('metadata') as any;metadata.prepared=true;rows.set('metadata',metadata);
 const restored=new RunnerDO(ctx as any,env as any);await pending.at(-1);await restored.ensure(job);await restored.launchNative();await restored.launchNative();assert.equal((await restored.nativeLifecycle()).neverLaunched,false);
 assert.equal(execs.length,2);assert.ok(execs[0][0].includes('/opt/hivemind/backend/src/runtime/autonomous-boundary-probe.ts'));assert.equal(execs[0][1].stdout,'pipe');assert.equal((rows.get('metadata') as any).nativeBoundaryVerified,manifest.digest);assert.ok(execs[1][0].includes('--bounding-set=-all'));assert.ok(execs[1][0].includes('/opt/hivemind/backend/src/runtime/autonomous-from-file.ts'));assert.equal(execs[1][1].stdout,'ignore');assert.equal(execs[1][1].stderr,'ignore');
});
const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
test('operator readiness/status are safe and private routes require operator token',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const owner=new SchedulerDO(ctx as any,env as any);await Promise.all(pending);
 for(const path of ['/v1/autonomous-readiness','/v1/autonomous-tasks/task/cloud-status','/v1/autonomous-tasks/task/cloud-result']){
 const denied=await owner.fetch(new Request('https://control.example'+path,{headers:{authorization:'Bearer worker'}}));assert.equal(denied.status,401);
 }
 const r=await owner.fetch(new Request('https://control.example/v1/autonomous-readiness',{headers:{authorization:'Bearer operator'}}));assert.equal(r.status,200);assert.equal((await r.json() as any).ready,true);
});
test('native completion cannot release credential or expose private data without stopped container',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let stops=0;
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},delete:async(k:string)=>rows.delete(k)},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const owner=new SchedulerDO(ctx as any,{...env,RUNNER:{getByName:()=>({ensure:async()=>({ready:true,prepared:true}),pollNative:async()=>JSON.stringify({lost:false,result:{version:1,jobId:'native-fixed',attempt:'wrong',ok:false,errorCode:'NATIVE_EXECUTION_FAILED'}}),launchNative:async()=>{},stop:async()=>{stops++;return false;}})}} as any) as any;await Promise.all(pending);
 owner.scheduler=fixture();const job=owner.scheduler.submit(spec,Date.now(),'native-fixed');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());
 await owner.advance(owner.scheduler.get(job.id));assert.equal(stops,1);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,job.id);assert.equal(owner.scheduler.state.credentials.claude.quarantined,true);assert.equal(owner.scheduler.get(job.id).authSynced,false);
});

import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';
import {openCredential,type StoredCredential} from '../src/crypto.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {nativeJobKey} from '../src/cloudflare/autonomous-ports.ts';
test('complete native result encrypts session, stops before auth adoption, then requires real legacy compute success',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),auth='sk-ant-oat01-fixture12345678';
 const config={...env,AUTH_RETURN_PUBLIC_KEY:pair.publicKey.export({format:'pem',type:'spki'}).toString(),AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTONOMOUS_WORKER_TOKEN:randomBytes(32).toString('hex'),AUTONOMOUS_REPORTER_TOKEN:randomBytes(32).toString('hex'),CONTROL_TOKEN:randomBytes(32).toString('hex')};
 const rows=new Map<string,unknown>(),credentials=new Map<string,Uint8Array|string>(),artifacts=new Map<string,string>(),trace:string[]=[],pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},delete:async(k:string)=>rows.delete(k)},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const owner=new SchedulerDO(ctx as any,{...config,RUNNER:{getByName:()=>({stop:async()=>{trace.push('stop');return true;}})},CREDENTIALS:{get:async(k:string)=>{const v=credentials.get(k);return v===undefined?null:{json:async()=>JSON.parse(v as string)};},put:async(k:string,v:Uint8Array|string)=>{trace.push(k.startsWith('credentials/')?'auth-write':'session-write');assert.equal(credentials.has(k),false);credentials.set(k,v);return {etag:'saved'};}},ARTIFACTS:{get:async(k:string)=>artifacts.has(k)?{json:async()=>JSON.parse(artifacts.get(k)!)}:null,put:async(k:string,v:string)=>{artifacts.set(k,v);return {};}}} as any) as any;
 await Promise.all(pending);owner.scheduler=fixture();const job=owner.scheduler.submit(spec,Date.now(),'native-fixed');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());const active=owner.scheduler.get(job.id);
 const sessionId=crypto.randomUUID(),snapshot=createSnapshot([]),lease={taskId:'task',runId:'run',workerId:'driver',token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000};
 rows.set(nativeJobKey(job.id),{task,lease,runtimeId:crypto.randomUUID(),sessionId});
 const response={version:1,session:{sessionId,model:task.spec.model,sequence:1,data:{version:1,sessionId,model:task.spec.model,workspacePath:'/workspace',snapshot,transcripts:[{path:sessionId+'.jsonl',content:'{"type":"result"}\n'}]}},usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:2},outcome:'complete',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 await owner.completeNative(active,{version:1,jobId:job.id,attempt:job.attempt,ok:true,response,authReturn:sealAuth(auth,config.AUTH_RETURN_PUBLIC_KEY)});
 assert.equal(owner.scheduler.get(job.id).status,'VERIFYING');assert.equal(owner.scheduler.state.credentials.claude.generation,24);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,undefined);
 assert.ok(trace.indexOf('stop')<trace.indexOf('auth-write'));const encrypted=credentials.get('credentials/claude/g24.json') as string;
 assert.equal(await openCredential(JSON.parse(encrypted) as StoredCredential,'claude',24,config.AUTH_STORAGE_KEY),auth);
 for(const value of artifacts.values())for(const secret of [auth,lease.token,'transcripts','authReturn','checkpoint','workerToken'])assert.equal(value.includes(secret),false);
 const sessionBlob=[...credentials.entries()].find(([key])=>key.startsWith('autonomous-sessions/'))![1] as Uint8Array;assert.equal(Buffer.from(sessionBlob).includes(Buffer.from('transcripts')),false);
 const ports=new LegacyAutonomousCloudPorts({scheduler:owner.scheduler,storage:ctx.storage as any,enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});assert.deepEqual(await ports.poll(job.id),{state:'pending'});
 const checks=owner.scheduler.dispatch(Date.now());assert.equal(checks.length,1);owner.scheduler.computeFinished(checks[0].id,checks[0].attempt,{success:true,containerStopped:true,sourceUnchanged:true},Date.now());
 const poll=await ports.poll(job.id);assert.equal(poll.state,'finished');if(poll.state==='finished'){assert.equal(poll.checksPassed,true);assert.equal(poll.result.checkpoint?.sequence,1);
 const core=new AutonomousEngine();core.create({...task.spec,requestId:'native-billing-regression',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:500000,budgetMicros:100,tools:['Bash'],systems:[],maxIterations:2},0,'task');core.approve('task',1,'approved',1);
 const coreLease=core.claimCloud('task','driver',lease.token,'run',2)!;const runtimeId=(rows.get(nativeJobKey(job.id)) as any).runtimeId;
 core.nativeStart(coreLease,runtimeId,3);core.recordNativeReceipt(coreLease,{runId:'run',runtimeId,sessionId,model:task.spec.model,sequence:1,usage:response.usage,stopped:true,outcome:'complete'},4);
 const finished=core.finishCloud(coreLease,poll.result,poll.checksPassed,5);assert.equal(finished.status,'completed');assert.equal(finished.runs[0]?.costMicros,null);
 }
});
test('cancel after native return never quarantines the released lane or its next legacy owner',async()=>{
 const s=fixture(),rows=new Map<string,unknown>();const ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async<T>(k:string)=>rows.get(k) as T,put:async(k,v)=>{rows.set(k,v);}},enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
 const job=s.submit(spec,1000,'native-returned');s.dispatch(1100);const active=s.get(job.id);
 s.agentFinished(job.id,job.attempt,{success:true,outputSnapshotId:'b'.repeat(64),authGeneration:24,authObjectKey:'credentials/claude/g24.json',containerStopped:true},1200);
 const next=s.submit({...spec,idempotencyKey:'next-legacy'},1300);s.dispatch(1400);assert.equal(s.state.credentials.claude!.activeJobId,next.id);
 await ports.cancel(job.id);await ports.quarantine('claude',job.id);
 assert.equal(s.state.credentials.claude!.activeJobId,next.id);assert.equal(s.state.credentials.claude!.quarantined,false);assert.equal(s.get(next.id).status,'STARTING');assert.equal(active.credentialGeneration,23);
});
test('failed native envelope never adopts authentication or releases the stream',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let authWrites=0;
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 let active:any;const runner={ensure:async()=>({ready:true,prepared:true}),launchNative:async()=>{},pollNative:async()=>JSON.stringify({lost:false,result:{version:1,jobId:active.id,attempt:active.attempt,ok:false,errorCode:'NATIVE_EXECUTION_FAILED',authReturn:sealAuth('sk-ant-oat01-fixture1234',pair.publicKey.export({format:'pem',type:'spki'}).toString())}}),stop:async()=>true};
 const owner=new SchedulerDO(ctx as any,{...env,AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),RUNNER:{getByName:()=>runner},CREDENTIALS:{get:async()=>null,put:async()=>{authWrites++;return {};}}} as any) as any;await Promise.all(pending);owner.scheduler=fixture();const j=owner.scheduler.submit(spec,Date.now(),'native-failed');owner.scheduler.state.jobs[j.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());active=owner.scheduler.get(j.id);rows.set(nativeJobKey(j.id),{task,lease:{},sessionId:crypto.randomUUID(),runtimeId:crypto.randomUUID()});
 await owner.advance(active);assert.equal(authWrites,0);assert.equal(owner.scheduler.state.credentials.claude.quarantined,true);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,j.id);assert.equal(owner.scheduler.get(j.id).authSynced,false);
});
test('paused cloud controller rejects operator resume before changing core state',async()=>{
 const rows=new Map<string,unknown>([['autonomous-cloud:task',{taskId:'task',phase:'paused',jobId:'old-job'}]]),pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const owner=new SchedulerDO(ctx as any,env as any);await Promise.all(pending);
 const r=await owner.fetch(new Request('https://control.example/v1/autonomous-tasks/task/resume',{method:'POST',headers:{authorization:'Bearer operator','content-type':'application/json'},body:JSON.stringify({revision:1,reason:'resume'})}));assert.equal(r.status,409);assert.match((await r.json() as any).error,/new task/);assert.equal(rows.has('autonomous-state'),false);
});
test('availability fails closed for missing or oversized source before any core claim',async()=>{
 const s=fixture(),ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async()=>undefined,put:async()=>{}},enabled:()=>true,sourceReady:async()=>false,save:async()=>{}});
 assert.equal(await ports.available(task),false);await assert.rejects(ports.submit({task,lease:{} as any,jobId:'fixed',snapshotId:spec.snapshotId,idempotencyKey:'blocked'}));assert.equal(s.list().length,0);
});
test('failed, oversized or uncertain boundary probe stops once and never permits private prepare or model replay',async()=>{
 for(const mode of ['failed','namespace-false','namespace-missing','unknown-field','metadata-only','oversized','nonzero','uncertain']){
  const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[],paths:string[]=[];let execs=0,stops=0;
  const ctx={exports:{NativeClaudeOutbound:{}},storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;},container:{running:true,exec:async()=>{execs++;assert.equal((rows.get('metadata') as any).nativeBoundaryAttempted,manifest.digest);if(mode==='uncertain')throw Error('lost exec response');return {output:async()=>({exitCode:mode==='nonzero'?1:0,stdout:new TextEncoder().encode(mode==='oversized'?'x'.repeat(4097):JSON.stringify(mode==='metadata-only'?{passed:true}:mode==='failed'?{...boundaryReport,parentProcDenied:false}:mode==='namespace-false'?{...boundaryReport,namespaceGuardActive:false}:mode==='namespace-missing'?Object.fromEntries(Object.entries(boundaryReport).filter(([key])=>key!=='namespaceGuardActive')):mode==='unknown-field'?{...boundaryReport,unexpected:true}:boundaryReport)).buffer,stderr:new ArrayBuffer(0)})};},destroy:async()=>{stops++;ctx.container.running=false;},interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async(r:Request)=>{paths.push(new URL(r.url).pathname);return Response.json({ok:true,runtimeRevision:manifest.digest});}})}};
  const job={id:'job',attempt:'attempt',kind:'agent',provider:'claude',autonomous:{taskId:'task',runId:'run'}} as any;
  const runner=new RunnerDO(ctx as any,env as any);await Promise.all(pending);await assert.rejects(runner.ensure(job),/boundary/i);
  assert.equal(stops,1);assert.equal(execs,1);assert.equal((rows.get('metadata') as any).nativeBoundaryVerified,undefined);await assert.rejects(runner.prepareNative({} as any));await assert.rejects(runner.launchNative());
  const restored=new RunnerDO(ctx as any,env as any);await pending.at(-1);assert.equal((await restored.ensure(job)).lost,true);assert.equal(execs,1);assert.deepEqual(paths,['/health']);
 }
});
test('single native pilot slot spans distinct credentials through queued, running and verifying parents',async()=>{
 const s=fixture();s.registerCredential({id:'claude-second',provider:'claude',generation:23,objectKey:'credentials/claude-second/g23.json',quarantined:false});
 const secondTask={...task,spec:{...task.spec,credentialIds:['claude-second']}};
 const ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async()=>undefined,put:async()=>{}},enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
 const first=s.submit(spec,1000,'first-native');s.state.jobs[first.id]!.autonomous={taskId:'first-task',runId:'first-run'};
 assert.equal(await ports.available(secondTask),false,'queued native retains pilot slot');
 s.dispatch(1100);s.running(first.id,first.attempt,1150);
 assert.equal(await ports.available(secondTask),false,'running native with another credential retains pilot slot');
 s.agentFinished(first.id,first.attempt,{success:true,outputSnapshotId:'b'.repeat(64),authGeneration:24,authObjectKey:'credentials/claude/g24.json',containerStopped:true},1200);
 assert.equal(s.get(first.id).status,'VERIFYING');assert.equal(s.state.credentials.claude!.activeJobId,undefined);
 assert.equal(await ports.available(secondTask),false,'stopped and auth-synced native still owns pilot slot during checks');
 await assert.rejects(ports.submit({task:secondTask,lease:{taskId:'second-task',runId:'second-run',workerId:'driver',token:'private',expiresAt:999999},jobId:'second-native',snapshotId:spec.snapshotId,idempotencyKey:'second-native'}),/pilot/i);
 assert.equal(s.list().filter(j=>j.autonomous).length,1);
 const [check]=s.dispatch(1300);s.computeFinished(check!.id,check!.attempt,{success:true,containerStopped:true,sourceUnchanged:true},1400);
 assert.equal(s.get(first.id).status,'SUCCEEDED');assert.equal(await ports.available(secondTask),true,'confirmed terminal native releases pilot slot');
 // Legacy agent concurrency continues to use the existing pool.
 const legacy=s.submit({...spec,idempotencyKey:'legacy-after-native'},1500);s.dispatch(1600);
 assert.equal(s.get(legacy.id).status,'STARTING');assert.equal(await ports.available(secondTask),true,'one active legacy job leaves the second existing agent slot available');
});
import {sealCredential} from '../src/crypto.ts';
test('native prepare rejects actual secrets in goal, resumed data and decoded source before any transfer',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),auth='sk-ant-oat01-'+randomBytes(24).toString('hex');
 const config={...env,CONTROL_TOKEN:randomBytes(32).toString('hex'),AUTONOMOUS_WORKER_TOKEN:randomBytes(32).toString('hex'),AUTONOMOUS_REPORTER_TOKEN:randomBytes(32).toString('hex'),AUTONOMOUS_SESSION_KEY:randomBytes(32).toString('base64'),AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),AUTH_RETURN_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
 const secrets=[config.CONTROL_TOKEN,config.AUTONOMOUS_WORKER_TOKEN,config.AUTONOMOUS_REPORTER_TOKEN,config.AUTONOMOUS_SESSION_KEY,config.AUTH_STORAGE_KEY,config.AUTH_RETURN_PRIVATE_KEY,auth];
 const sealed=await sealCredential(auth,'claude',23,config.AUTH_STORAGE_KEY);
 for(const mode of ['goal','session','snapshot','session-snapshot','safe'])for(const secret of mode==='safe'?['']:secrets){
  const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let transfers=0,launches=0;
  const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
  const content=(mode==='snapshot'||mode==='session-snapshot')?Buffer.concat([Buffer.from([0xff]),Buffer.from(secret),Buffer.from([0xfe])]):Buffer.from('CONTROL_TOKEN AUTONOMOUS_WORKER_TOKEN AUTH_STORAGE_KEY');
  const snapshot=createSnapshot([{path:'counter.txt',content:content.toString('base64'),sha256:(await import('../src/snapshot.ts')).sha256(content),executable:false}]);
  const runner={ensure:async()=>({ready:true,prepared:false,launchIssued:false}),prepareNative:async(input:any)=>{transfers++;assert.equal(input.request.subscriptionAuth,auth);assert.equal(input.control.workerToken,config.AUTONOMOUS_WORKER_TOKEN);assert.equal(input.claudeNestedCompatible,true);assert.equal(input.request.claudeNestedCompatible,undefined);},launchNative:async()=>{launches++;},stop:async()=>true};
  const owner=new SchedulerDO(ctx as any,{...config,RUNNER:{getByName:()=>runner},CREDENTIALS:{get:async()=>({json:async()=>sealed})},ARTIFACTS:{get:async()=>({json:async()=>snapshot})}} as any) as any;await Promise.all(pending);owner.scheduler=fixture();const job=owner.scheduler.submit({...spec,snapshotId:snapshot.digest},Date.now(),'privacy-job');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());
  const sessionId=crypto.randomUUID(),checkpoint=mode.startsWith('session')?{sessionId,model:task.spec.model,sequence:1,objectKey:'private/fixture'}:undefined;
  rows.set(nativeJobKey(job.id),{task:{...task,spec:{...task.spec,claudeNestedCompatible:false,tools:['Bash'],goal:mode==='goal'?'Inspect '+secret:'Inspect CONTROL_TOKEN identifier safely'}},lease:{taskId:'task',runId:'run',workerId:'driver',token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000},sessionId,runtimeId:crypto.randomUUID(),...(checkpoint?{checkpoint}:{})});
  if(checkpoint)owner.sessionStore=()=>({load:async()=>({sessionId,model:task.spec.model,sequence:1,data:mode==='session-snapshot'?{snapshot,transcripts:[{content:'Safe transcript'}]}:{transcripts:[{content:'Nested material '+secret}]}})});
  await owner.advance(owner.scheduler.get(job.id));assert.equal(transfers,mode==='safe'?1:0,mode+' must be checked before private transfer');assert.equal(launches,0);
  assert.equal(owner.scheduler.state.credentials.claude.quarantined,mode!=='safe');
  if(mode!=='safe'){assert.equal(owner.scheduler.get(job.id).errorCode,'NATIVE_EXECUTION_UNCERTAIN');assert.equal(owner.scheduler.state.credentials.claude.activeJobId,job.id);}
 }
});
test('trusted unstarted native failure returns unchanged credential generation and safe poll discriminator',async()=>{
 const s=fixture(),job=s.submit(spec,1000,'unstarted-native');s.state.jobs[job.id]!.autonomous={taskId:'task',runId:'run'};s.dispatch(1100);
 const failed=s.failUnstartedNative(job.id,job.attempt,'NATIVE_BOUNDARY_FAILED',1200,{containerStopped:true,neverLaunched:true});
 assert.equal(failed.status,'FAILED');assert.equal(failed.containerStopped,true);assert.equal(failed.authSynced,true);assert.equal(failed.authDisposition,'unchanged_unstarted');assert.equal(s.state.credentials.claude!.generation,23);assert.equal(s.state.credentials.claude!.activeJobId,undefined);assert.equal(s.state.credentials.claude!.quarantined,false);
 const ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async()=>undefined,put:async()=>{}},enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
 assert.deepEqual(await ports.poll(job.id),{state:'unstarted',stopped:true,authSynced:true});
});
test('unstarted failure proof rejects launched, running, cancelled, stale and different-owner cases without releasing lane',()=>{
 for(const mode of ['launched','not-stopped','running','cancel-race','other-owner','generation-changed','legacy','wrong-attempt']){
  const s=fixture(),job=s.submit(spec,1000,'unstarted-native');if(mode!=='legacy')s.state.jobs[job.id]!.autonomous={taskId:'task',runId:'run'};s.dispatch(1100);
  if(mode==='running')s.running(job.id,job.attempt,1150);if(mode==='cancel-race')s.requestCancel(job.id,1150);if(mode==='other-owner')s.state.credentials.claude!.activeJobId='another-job';if(mode==='generation-changed')s.state.credentials.claude!.generation++;
  const before=structuredClone(s.state);assert.throws(()=>s.failUnstartedNative(job.id,mode==='wrong-attempt'?'wrong':job.attempt,'BOUNDARY_FAILED',1200,{containerStopped:mode!=='not-stopped',neverLaunched:mode!=='launched'} as any),SchedulerError,mode);assert.deepEqual(s.state,before,mode);
 }
});
test('actual Runner boundary rejection releases only stopped never-launched native lane without auth read',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let reads=0,execs=0;
 const storage={get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}};
 const runnerCtx={storage,exports:{NativeClaudeOutbound:{}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;},container:{running:true,exec:async()=>{execs++;return {output:async()=>({exitCode:1,stdout:new TextEncoder().encode(JSON.stringify({...boundaryReport,passed:false})).buffer,stderr:new ArrayBuffer(0)})};},destroy:async()=>{runnerCtx.container.running=false;},interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async()=>Response.json({ok:true,runtimeRevision:manifest.digest})})}};
 const runner=new RunnerDO(runnerCtx as any,env as any);await Promise.all(pending);
 const ownerCtx={storage,blockConcurrencyWhile:runnerCtx.blockConcurrencyWhile};const owner=new SchedulerDO(ownerCtx as any,{...env,RUNNER:{getByName:()=>runner},CREDENTIALS:{get:async()=>{reads++;return null;}}} as any) as any;await Promise.all(pending);owner.scheduler=fixture();const job=owner.scheduler.submit(spec,Date.now(),'actual-unstarted');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());
 await owner.advance(owner.scheduler.get(job.id));assert.equal(execs,1);assert.equal(reads,0);assert.deepEqual(await runner.nativeLifecycle(),{native:true,prepared:false,neverLaunched:true,containerStopped:true});assert.equal(owner.scheduler.get(job.id).authDisposition,'unchanged_unstarted');assert.equal(owner.scheduler.state.credentials.claude.generation,23);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,undefined);assert.equal(owner.scheduler.state.credentials.claude.quarantined,false);
});
test('native secret prefilter covers other configured provider credentials before transfer',async()=>{
 const pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async()=>undefined},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const config={...env,GEMINI_BENCHMARK_KEY:'fake-gemini-private-value',TERRA_BENCHMARK_AUTH:JSON.stringify({access:'fake-terra-access',accountId:'fake-account',requestId:'fake-request',expires:Date.now()+60000})};
 const owner=new SchedulerDO(ctx as any,config as any) as any;await Promise.all(pending);
 for(const secret of [config.GEMINI_BENCHMARK_KEY,config.TERRA_BENCHMARK_AUTH,'fake-terra-access'])assert.throws(()=>owner.assertNativeModelDataSafe('Do '+secret,null,undefined,'fake-claude-auth','fake-lease-token'),/rejected/);
});
test('native completion rejects stale credential ownership before unsealing or writing any result',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let writes=0,stops=0;
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async()=>{writes++;}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});const key=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const owner=new SchedulerDO(ctx as any,{...env,AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),RUNNER:{getByName:()=>({stop:async()=>{stops++;return true;}})}} as any) as any;await Promise.all(pending);owner.scheduler=fixture();
 const job=owner.scheduler.submit(spec,Date.now(),'stale-native');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());
 const active=owner.scheduler.get(job.id);owner.scheduler.state.credentials.claude.activeJobId='next-owner';
 const sessionId=crypto.randomUUID(),snapshot=createSnapshot([]);
 rows.set(nativeJobKey(job.id),{task,lease:{token:'private-lease'},sessionId});
 owner.sessionStore=()=>({save:async()=>{writes++;return {sessionId,model:task.spec.model,sequence:1,objectKey:'private/checkpoint'};}});
 owner.putSnapshot=async()=>{writes++;};owner.storeCredential=async()=>{writes++;};owner.queueCompletion=async()=>{writes++;};
 const response={version:1,session:{sessionId,model:task.spec.model,sequence:1,data:{version:1,sessionId,model:task.spec.model,workspacePath:'/workspace',snapshot,transcripts:[{path:sessionId+'.jsonl',content:'{}\n'}]}},usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},outcome:'complete',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 await assert.rejects(owner.completeNative(active,{version:1,jobId:job.id,attempt:job.attempt,ok:true,response,authReturn:sealAuth('sk-ant-oat01-fixture1234',key)}),/ownership/i);
 assert.equal(writes,0);assert.equal(stops,0);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,'next-owner');
});
test('quarantine rejects stale same-ID generation without touching the current credential',()=>{
 const s=fixture(),job=s.submit(spec,1000,'native-generation');s.dispatch(1100);s.state.credentials.claude!.generation++;
 const before=structuredClone(s.state);assert.throws(()=>s.quarantine(job.id,job.attempt,'UNCERTAIN',1200,true),/ownership/i);assert.deepEqual(s.state,before);
});
test('operator cloud approval pins configuration and blocks a changed origin before claim',async()=>{
 const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];
 const storage={get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));},getAlarm:async()=>null,setAlarm:async()=>{}};
 const ctx={storage,blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 const config={...env};const owner=new SchedulerDO(ctx as any,config as any) as any;await Promise.all(pending);owner.scheduler=fixture();owner.nativeSourceReady=async()=>true;
 const draft={...task.spec,requestId:'approved-config',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:Date.now()+600000,budgetMicros:1,tools:['Bash'],systems:[],maxIterations:2};
 const created=await owner.autonomy.execute('create',{spec:draft});
 assert.equal(await owner.cloudPorts().available(created),false,'no approval stamp cannot authorize a claim');
 const response=await owner.fetch(new Request(`https://control.example/v1/autonomous-tasks/${created.id}/approve`,{method:'POST',headers:{authorization:'Bearer operator','content-type':'application/json'},body:JSON.stringify({revision:created.revision,reason:'fixed target'})}));assert.equal(response.status,200);
 const approved=await owner.autonomy.execute('get',{id:created.id});
 assert.equal(await owner.cloudPorts().available(approved),true);
 config.AUTONOMOUS_CONTROL_ORIGIN='https://changed.example';
 assert.equal(cloudReadiness(config).ready,true);assert.equal(await owner.cloudPorts().available(approved),false);
 assert.equal(owner.scheduler.list().length,0);
 config.AUTONOMOUS_CONTROL_ORIGIN=env.AUTONOMOUS_CONTROL_ORIGIN;
 const submitted=await owner.cloudPorts().submit({task:approved,lease:{taskId:approved.id,runId:'run',workerId:'worker',token:'private-lease',expiresAt:Date.now()+30000},jobId:'approved-native',snapshotId:spec.snapshotId,idempotencyKey:'approved-native'});
 const privateRow=rows.get(nativeJobKey(submitted.jobId)) as any;assert.match(privateRow.configurationFingerprint,/^[a-f0-9]{64}$/);
 owner.scheduler.dispatch(Date.now());let authReads=0;
 const nativeEnv=(owner as any).env;nativeEnv.CREDENTIALS={get:async()=>{authReads++;throw Error('must not read auth');}};
 nativeEnv.RUNNER={getByName:()=>({ensure:async()=>({ready:true,prepared:false,launchIssued:false}),stop:async()=>false})};
 config.AUTONOMOUS_WORKER_TOKEN='changed-worker-role';
 await owner.advance(owner.scheduler.get(submitted.jobId));assert.equal(authReads,0);assert.equal(owner.scheduler.state.credentials.claude.quarantined,true);
});
test('readiness rejects execution role tokens that equal container-forbidden management or session secrets',()=>{
 for(const field of ['AUTH_STORAGE_KEY','AUTH_RETURN_PRIVATE_KEY','AUTONOMOUS_SESSION_KEY'] as const)for(const role of ['AUTONOMOUS_WORKER_TOKEN','AUTONOMOUS_REPORTER_TOKEN'] as const){
  assert.equal(cloudReadiness({...env,[field]:env[role]}).ready,false,role+' must not alias '+field);
 }
 assert.equal(cloudReadiness({...env,AUTH_STORAGE_KEY:env.AUTONOMOUS_SESSION_KEY}).ready,false);
});
test('private submission storage failure cannot turn the queued native job into a legacy model job',async()=>{
 for(const failure of ['read','write']){
  const s=fixture();const ports=new LegacyAutonomousCloudPorts({scheduler:s,storage:{get:async()=>{if(failure==='read')throw Error('private read unavailable');return undefined;},put:async()=>{throw Error('private write unavailable');}},enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
  const lease={taskId:task.id,runId:'native-run',workerId:'driver',token:'private-lease',expiresAt:999999};
  await assert.rejects(ports.submit({task,lease,jobId:'storage-failed-native',snapshotId:spec.snapshotId,idempotencyKey:'storage-failed-native'}));
  const [dispatched]=s.dispatch(1000);assert.deepEqual(dispatched?.autonomous,{taskId:task.id,runId:lease.runId},'a partially submitted job must retain the native-only execution path');
 }
});
