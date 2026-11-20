import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler} from '../src/scheduler.ts';
import type {JobSpec} from '../src/contracts.ts';
const spec:JobSpec={provider:'claude',credentialId:'claude',snapshotId:'a'.repeat(64),instructions:'Bounded native run',checks:[{id:'check',argv:['node','check.js'],timeoutMs:1000}],timeoutMs:120000,idempotencyKey:'native:run'};
function fixture(){const s=new Scheduler();s.registerCredential({id:'claude',provider:'claude',generation:23,objectKey:'credentials/claude/g23.json',quarantined:false});return s;}
import type {AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,1).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'worker',AUTONOMOUS_REPORTER_TOKEN:'reporter',CONTROL_TOKEN:'operator',AUTH_RETURN_PUBLIC_KEY:'public',AUTH_RETURN_PRIVATE_KEY:'private',AUTH_STORAGE_KEY:'storage',CLAUDE_NESTED_APPROVED:'true'};
const task={id:'task',spec:{provider:'claude',credentialIds:['claude'],model:'pinned-model',goal:'Bounded native run',maxRunMs:120000,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:spec.checks}},status:'ready'} as AutonomousTask;
import {registerHooks} from 'node:module';
import manifest from '../runtime-build.json' with {type:'json'};
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'),shortCircuit:true};return next(specifier,context);}});
const {SchedulerDO,RunnerDO}=await import('../src/cloudflare/worker.ts');
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';
import {openCredential,type StoredCredential} from '../src/crypto.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {nativeJobKey} from '../src/cloudflare/autonomous-ports.ts';
for(const failure of ['credential','artifact','completion','stop','stop-record','expired'] as const)test(failure==='expired'?'native pre-deadline result is collected and auth synced after web expiry within grace':`native completion recovers ${failure} failure across actor restart without re-execution`,async(t)=>{
 if(failure==='expired')t.mock.timers.enable({apis:['Date'],now:200000});
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),auth='sk-ant-oat01-fixture12345678';
 const config={...env,AUTH_RETURN_PUBLIC_KEY:pair.publicKey.export({format:'pem',type:'spki'}).toString(),AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTONOMOUS_WORKER_TOKEN:randomBytes(32).toString('hex'),AUTONOMOUS_REPORTER_TOKEN:randomBytes(32).toString('hex'),CONTROL_TOKEN:randomBytes(32).toString('hex')};
 const rows=new Map<string,unknown>(),credentials=new Map<string,Uint8Array|string>(),artifacts=new Map<string,string>(),trace:string[]=[],pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{if(fail&&failure==='stop-record'&&k.startsWith('autonomous-native-recovery:')&&(v as any).stopped){fail=false;throw Error('transient R2');}if(fail&&failure==='completion'&&k.startsWith('completion:')){fail=false;throw Error('transient R2');}rows.set(k,structuredClone(v));},delete:async(k:string)=>rows.delete(k)},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;}};
 let fail=true;
 const owner=new SchedulerDO(ctx as any,{...config,RUNNER:{getByName:()=>({ensure:async()=>{throw Error('must not execute');},stop:async()=>{trace.push('stop');if(fail&&failure==='stop'){fail=false;return false;}return true;}})},CREDENTIALS:{get:async(k:string)=>{const v=credentials.get(k);return v===undefined?null:{json:async()=>JSON.parse(v as string)};},put:async(k:string,v:Uint8Array|string)=>{trace.push(k.startsWith('credentials/')?'auth-write':'session-write');if(fail&&failure==='credential'&&k.startsWith('credentials/')){fail=false;throw Error('transient R2');}assert.equal(credentials.has(k),false);credentials.set(k,v);return {etag:'saved'};}},ARTIFACTS:{get:async(k:string)=>artifacts.has(k)?{json:async()=>JSON.parse(artifacts.get(k)!)}:null,put:async(k:string,v:string)=>{if(fail&&failure==='artifact'&&k.startsWith('results/')){fail=false;throw Error('transient R2');}assert.equal(artifacts.has(k),false);artifacts.set(k,v);return {};}}} as any) as any;
 await Promise.all(pending);owner.scheduler=fixture();const job=owner.scheduler.submit(spec,Date.now(),'native-fixed');owner.scheduler.state.jobs[job.id].autonomous={taskId:'task',runId:'run'};owner.scheduler.dispatch(Date.now());const active=owner.scheduler.get(job.id);
 const sessionId=crypto.randomUUID(),snapshot=createSnapshot([]),lease={taskId:'task',runId:'run',workerId:'driver',token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000};
 rows.set(nativeJobKey(job.id),{task,lease,runtimeId:crypto.randomUUID(),sessionId});
 const response={version:1,session:{sessionId,model:task.spec.model,sequence:1,data:{version:1,sessionId,model:task.spec.model,workspacePath:'/workspace',snapshot,transcripts:[{path:sessionId+'.jsonl',content:'{"type":"result"}\n'}]}},usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:2},outcome:'complete',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 await owner.save();
 const envelope={version:1,jobId:job.id,attempt:job.attempt,ok:true,response,authReturn:sealAuth(auth,config.AUTH_RETURN_PUBLIC_KEY)};
 if(failure==='expired'){
  const deadline=active.deadline,grant={allowedHosts:['example.com'],taskId:'task',jobId:job.id,attempt:job.attempt,expiresAt:deadline};
  const pinned=rows.get(nativeJobKey(job.id)) as any;pinned.task.spec.endsAt=deadline;pinned.webPolicy={allowedHosts:grant.allowedHosts};rows.set(nativeJobKey(job.id),pinned);
  Object.assign(owner.env,{AUTONOMOUS_WEB_ENABLED:'true',AUTONOMOUS_WEB_ALLOWED_HOSTS:'example.com'});
  const metadata={jobId:job.id,attempt:job.attempt,kind:'agent',native:true,prepared:true,launchIssued:true,stopped:false,webGrant:grant};
  const native=new RunnerDO({storage:{get:async()=>metadata},blockConcurrencyWhile:async(fn:any)=>fn(),container:{running:true,getTcpPort:()=>({fetch:async(r:Request)=>Response.json(new URL(r.url).pathname==='/autonomous/state'?{started:true,resultReady:true}:envelope)})}} as any,owner.env) as any;
  await new Promise(resolve=>setImmediate(resolve));
  owner.env.RUNNER={getByName:()=>({ensure:native.ensure.bind(native),pollNative:native.pollNative.bind(native),launchNative:async()=>{throw Error('duplicate execution');},stop:async()=>{trace.push('stop');return true;}})};
  t.mock.timers.setTime(deadline+5000);await owner.advanceNative(active);assert.equal(owner.scheduler.get(job.id).authSynced,true);
 }else{
  await assert.rejects(owner.completeNative(active,envelope),failure==='stop'?/stop not confirmed/:/transient R2/);
  assert.equal(owner.scheduler.state.credentials.claude.generation,23);
  const recovery=rows.get('autonomous-native-recovery:'+job.id) as any;assert.ok(recovery.sealedAuthReturn);assert.equal(recovery.stopped,failure!=='stop'&&failure!=='stop-record');assert.equal(JSON.stringify(recovery).includes(auth),false);
  assert.equal(owner.scheduler.state.credentials.claude.quarantined,false);
 }
 const restarted=new SchedulerDO(ctx as any,(owner as any).env) as any;await Promise.all(pending);
 if(failure!=='expired'){
 const credential=restarted.scheduler.state.credentials.claude;credential.generation=25;await restarted.advanceNative(restarted.scheduler.get(job.id));assert.equal(credential.generation,25);assert.equal(credential.activeJobId,job.id);credential.generation=23;
 await restarted.advanceNative(restarted.scheduler.get(job.id));
 }
 owner.scheduler=restarted.scheduler;
 assert.equal(owner.scheduler.get(job.id).status,failure==='expired'?'TIMED_OUT':'VERIFYING');assert.equal(owner.scheduler.state.credentials.claude.generation,24);assert.equal(owner.scheduler.state.credentials.claude.activeJobId,undefined);
 assert.equal([...credentials.keys()].filter(k=>k.startsWith('credentials/')).length,1);assert.equal(rows.has('autonomous-native-recovery:'+job.id),false);
 assert.ok(trace.indexOf('stop')<trace.indexOf('auth-write'));const encrypted=credentials.get('credentials/claude/g24.json') as string;
 assert.equal(await openCredential(JSON.parse(encrypted) as StoredCredential,'claude',24,config.AUTH_STORAGE_KEY),auth);
 for(const value of artifacts.values())for(const secret of [auth,lease.token,'transcripts','authReturn','checkpoint','workerToken'])assert.equal(value.includes(secret),false);
 const sessionBlob=[...credentials.entries()].find(([key])=>key.startsWith('autonomous-sessions/'))![1] as Uint8Array;assert.equal(Buffer.from(sessionBlob).includes(Buffer.from('transcripts')),false);
});

test('expired pinned web grant collects pre-deadline native result within grace but denies web and all new grants',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:100000});
 const {NativeClaudeOutbound}=await import('../src/cloudflare/worker.ts');
 const grant={taskId:'task',jobId:'native-fixed',attempt:crypto.randomUUID(),expiresAt:100000,allowedHosts:['example.com']};
 const config={...env,AUTONOMOUS_WEB_ENABLED:'true',AUTONOMOUS_WEB_ALLOWED_HOSTS:'example.com'};
 const job={id:grant.jobId,attempt:grant.attempt,kind:'agent',provider:'claude',deadline:100000,autonomous:{taskId:'task',runId:'run'}} as any;
 const rows=new Map<string,unknown>([['metadata',{jobId:job.id,attempt:job.attempt,kind:'agent',provider:'claude',native:true,prepared:true,launchIssued:true,stopped:false,runtimeRevision:manifest.digest,nativeBoundaryVerified:manifest.digest,webGrant:grant}]]);
 const pending:Promise<unknown>[]=[];let execs=0,polls=0;
 const result={version:1,jobId:job.id,attempt:job.attempt,ok:false,errorCode:'NATIVE_EXECUTION_FAILED'};
 const ctx={storage:{get:async(k:string)=>structuredClone(rows.get(k)),put:async(k:string,v:unknown)=>{rows.set(k,structuredClone(v));}},blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{const p=fn();pending.push(p);return p;},container:{running:true,exec:async()=>{execs++;throw Error('no launch');},start:()=>{throw Error('no restart');},getTcpPort:()=>({fetch:async(r:Request)=>{polls++;return Response.json(new URL(r.url).pathname==='/autonomous/state'?{started:true,resultReady:true}:result);}})}};
 const runner=new RunnerDO(ctx as any,config as any);await Promise.all(pending);
 t.mock.timers.setTime(105000);
 assert.equal((await runner.ensure(job,grant)).ready,true);
 await runner.launchNative();assert.deepEqual(JSON.parse(await runner.pollNative()).result,result);assert.equal(polls,2);assert.equal(execs,0);
 const outbound=new NativeClaudeOutbound({props:{webGrant:grant}} as any,config as any);
 assert.equal((await outbound.fetch(new Request('https://example.com/data'))).status,403);
 await assert.rejects(runner.ensure(job,{...grant,expiresAt:110000}));
 await assert.rejects(runner.ensure(job,{...grant,allowedHosts:['other.example']}));
 t.mock.timers.setTime(110001);await assert.rejects(runner.ensure(job,grant),/grace/);t.mock.timers.setTime(105000);
 const unlaunched={...(rows.get('metadata') as any),launchIssued:false};rows.set('metadata',unlaunched);
 pending.length=0;const fresh=new RunnerDO(ctx as any,config as any);await Promise.all(pending);await assert.rejects(fresh.ensure(job,grant));assert.equal(execs,0);
});
