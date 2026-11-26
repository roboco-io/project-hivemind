import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAutonomousStore} from '../packages/core/src/autonomous-store.js';
import {createAutonomousApiService,handleAutonomousApi} from '../apps/control-plane/src/autonomous-api.js';
import {handleAutonomousExternalApi} from '../apps/control-plane/src/autonomous-external-api.js';
import type {ExternalSqlPort} from '../packages/core/src/autonomous-external-sql.ts';
import {createAutonomousExternalRuntime,type ExternalRuntimeOptions} from '../cloudflare/backend/src/autonomous-external.ts';
import {createActionMcpServer} from '../cloudflare/backend/src/runtime/autonomous-action-mcp.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createHivemindMcpServer} from '../apps/mcp-server/src/server.js';
import {createAutonomousCloudProxy} from '../apps/control-plane/src/autonomous-cloud-proxy.ts';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {AutonomousSpec,AutonomousTask,AutonomousLease} from '../packages/contracts/src/autonomous.js';
import type {ExternalProfile} from '../packages/contracts/src/autonomous-external.js';
import type {AwsTtlGuardRequest} from '../packages/adapters/src/autonomous-external.ts';

// All credentials and cloud responses below are synthetic fixture data.
const worker='remaining-fixture-worker',operator='remaining-fixture-operator';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};
const usage={inputTokens:3,cacheReadTokens:2,cacheWriteTokens:0,outputTokens:1};
const profile={id:'aws-profile',enabled:true,provider:'aws',target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixture'},operations:['aws.spot.start','aws.spot.inspect'],credentialRef:'aws-ref',maxLifetimeMs:60000,upperBoundMicros:100,maxActiveActions:1} satisfies ExternalProfile;
function sqlPort(db:DatabaseSync):ExternalSqlPort{return {
 exec(query,...bindings){const s=db.prepare(query);if(s.columns().length)return s.all(...bindings);s.run(...bindings);return [];},
 transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}},
};}
function fixture(t:{after(fn:()=>unknown):void},external=true){
 const root=mkdtempSync(join(tmpdir(),'remaining-sql-'));let now=Date.now();
 const db=new DatabaseSync(join(root,'broker.sqlite')),sql=sqlPort(db);let coreStore=createAutonomousStore(join(root,'core.sqlite'));
 const core=()=>createAutonomousApiService(coreStore,()=>now);t.after(()=>{coreStore.close();db.close();rmSync(root,{recursive:true,force:true});});
 let terminated=false;let start:URLSearchParams|undefined;let providerCalls=0,creates=0;const providerActions:string[]=[];const realModelCalls=0;
 const guardArn='arn:aws:events:ap-northeast-2:123456789012:rule/fixture';
 const config={version:1,profiles:[structuredClone(profile)],providers:{aws:{enabled:true,...profile.target,imageId:'ami-1234',instanceType:'t3.micro',subnetId:'subnet-1234',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/fixture',maxLifetimeMs:60000,credentialRef:'aws-ref',maxUpperBoundMicros:100,billingPolicy:'reserved_ceiling_only'}},ttlGuard:{guardArn}};
 const runtimeOptions=():ExternalRuntimeOptions=>({core:core(),sql,now:()=>now,env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'aws-ref':{provider:'aws',accessKeyId:'SYNTHETIC_ACCESS',secretAccessKey:'SYNTHETIC_PRIVATE'}})},artifacts:{async get(){assert.fail('Spot actions never load a model artifact');}},
 awsTtlGuard:{async attest(r:Readonly<AwsTtlGuardRequest>){return {kind:'preexisting_termination_guard',guardArn,evidenceId:'synthetic-guard',bindingHash:digest(r),installedAt:0,observedAt:now,validUntil:r.expiresAt,maxExposureMicros:r.maxExposureMicros};},async arm(r){return {kind:'owned_expiry_timer',guardArn,timerArn:'arn:aws:scheduler:ap-northeast-2:123456789012:schedule/fixture/hm-'+digest(r).slice(0,48),evidenceId:'synthetic-timer',bindingHash:digest(r),expiresAt:r.expiresAt};}},
 fetch:async(url,init)=>{
  providerCalls++;assert.ok(['ec2.ap-northeast-2.amazonaws.com','sts.ap-northeast-2.amazonaws.com'].includes(new URL(String(url)).hostname));const body=new URLSearchParams(String(init?.body)),action=body.get('Action');providerActions.push(action??'missing');
  if(action==='GetCallerIdentity')return new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/fixture</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');
  if(action==='RunInstances'){creates++;start=body;return new Response('<RunInstancesResponse><requestId>fixture-create</requestId><instancesSet><item><instanceId>i-1234abcd</instanceId></item></instancesSet></RunInstancesResponse>');}
  if(action==='DescribeVolumes')return new Response('<DescribeVolumesResponse><requestId>fixture-volumes</requestId><volumeSet></volumeSet></DescribeVolumesResponse>');
  if(action==='TerminateInstances'){terminated=true;return new Response('<TerminateInstancesResponse><requestId>fixture-stop</requestId></TerminateInstancesResponse>');}
  assert.equal(action,'DescribeInstances');const tags=start?[...start.keys()].filter(k=>/TagSpecification\.1\.Tag\.\d+\.Key/.test(k)).map(k=>`<item><key>${start!.get(k)}</key><value>${start!.get(k.replace(/Key$/,'Value'))}</value></item>`).join(''):'';
  return new Response('<DescribeInstancesResponse><requestId>fixture-describe</requestId><reservationSet>'+(start?`<item><ownerId>123456789012</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${start.get('ClientToken')}</clientToken><instanceState><name>${terminated?'terminated':'running'}</name></instanceState><tagSet>${tags}</tagSet></item></instancesSet></item>`:'')+'</reservationSet></DescribeInstancesResponse>');
 }});
 const runtime=()=>createAutonomousExternalRuntime(runtimeOptions())!;

 const spec:AutonomousSpec={requestId:randomUUID(),goal:'synthetic remaining integration',provider:'claude',model:'operator-pinned-model',endsAt:now+600000,budgetMicros:200,tools:external?['Bash','mcp__hivemind__action']:['Bash'],systems:external?['aws']:[],credentialIds:['subscription-ref'],...(external?{externalProfiles:['aws-profile']}:{}),maxRunMs:60000,maxIterations:10,billingPolicy:{model:'subscription',budget:'external_actions'}};
 return {core,spec,runtime,sql,config,time:(n:number)=>{now=n;},now:()=>now,restart(){coreStore.close();coreStore=createAutonomousStore(join(root,'core.sqlite'));},counts:()=>({providerCalls,creates,realModelCalls,providerActions}),terminated:()=>terminated};
}
async function approve(f:ReturnType<typeof fixture>){const task=await f.core().execute('create',{spec:f.spec}) as AutonomousTask,runtime=f.runtime();const metadata=await runtime.service.profiles(task.id),hashes=Object.fromEntries(metadata.map(p=>[p.id,p.profileHash]));await runtime.service.assertApproval(task.id,1,hashes);await f.core().execute('approve',{id:task.id,revision:1,reason:'synthetic fixed scope approval'});await runtime.service.approve(task.id,hashes);return {task,runtime};}
async function claim(f:ReturnType<typeof fixture>,id:string){return (await f.core().execute('claim',{id,workerId:'synthetic-worker'}) as {lease:AutonomousLease}).lease;}
async function finishWait(f:ReturnType<typeof fixture>,lease:AutonomousLease,runtimeId:string,sequence:number,wakeAt:number){
 const result={outcome:'wait' as const,wakeAt,usage,costMicros:null,checkpoint:{sessionId:'synthetic-private-session',model:f.spec.model,sequence,objectKey:'private/synthetic/'+sequence}};
 await f.core().execute('recordNativeReceipt',{lease,receipt:{runId:lease.runId,runtimeId,sessionId:result.checkpoint.sessionId,model:f.spec.model,sequence,usage,stopped:true,outcome:'wait',wakeAt}});await f.core().execute('finish',{lease,result});
}

test('synthetic concrete SQL factory accepts owned Spot once, waits and continues without new approval',async t=>{
 const f=fixture(t),{task,runtime}=await approve(f),lease=await claim(f,task.id),runtimeId=randomUUID();await f.core().execute('nativeStart',{lease,runtimeId});
 const request={profileId:'aws-profile',requestId:'spot-one',operation:'aws.spot.start' as const,parameters:{lifetimeMs:10000}};
 const first=await runtime.service.execute(task.id,{lease,runtimeId,request});assert.equal(first.status,'succeeded',JSON.stringify(f.counts()));assert.equal(first.verifiedCostMicros,null);
 assert.doesNotMatch(JSON.stringify(first),/ownershipToken|idempotencyKey|SYNTHETIC_PRIVATE|checkpoint|private\/synthetic/);
 await runtime.service.execute(task.id,{lease,runtimeId,request});assert.equal(f.counts().creates,1);
 const wake=f.now()+10;await finishWait(f,lease,runtimeId,1,wake);f.restart();const waiting=await f.core().execute('get',{id:task.id}) as AutonomousTask;
 assert.equal(waiting.status,'waiting');assert.equal(waiting.actions[0]?.status,'accepted');assert.equal(waiting.reservedMicros,100);assert.equal(waiting.spentMicros,0);assert.equal(waiting.resources[0]?.status,'active');
 assert.equal(await f.core().execute('claim',{id:task.id,workerId:'synthetic-worker'}),null);f.time(wake);const second=await claim(f,task.id);assert.ok(second);
 await f.core().execute('nativeStart',{lease:second,runtimeId:'second-runtime'});await f.core().execute('recordNativeReceipt',{lease:second,receipt:{runId:second.runId,runtimeId:'second-runtime',sessionId:'synthetic-private-session',model:f.spec.model,sequence:2,usage,stopped:true,outcome:'continue'}});
 await f.core().execute('finish',{lease:second,result:{outcome:'continue',usage,costMicros:null,checkpoint:{sessionId:'synthetic-private-session',model:f.spec.model,sequence:2,objectKey:'private/synthetic/2'}}});
 const continued=await f.core().execute('get',{id:task.id}) as AutonomousTask;assert.equal(continued.runs.length,2);assert.equal(continued.interventions.filter(i=>i.kind==='approval').length,1);assert.equal(continued.actions[0]?.status,'accepted');assert.equal(continued.reservedMicros,100);assert.equal(f.counts().realModelCalls,0);
});

test('synthetic lease-independent cancel/absence and late verified billing finalize exactly once after restart',async t=>{
 const f=fixture(t),{task,runtime}=await approve(f),lease=await claim(f,task.id),runtimeId=randomUUID();await f.core().execute('nativeStart',{lease,runtimeId});
 const request={profileId:'aws-profile',requestId:'owned-one',operation:'aws.spot.start' as const,parameters:{lifetimeMs:10000}};await runtime.service.execute(task.id,{lease,runtimeId,request});
 const earlyInvoice={actualCostMicros:25,evidenceRef:'invoice_fixture_25',reason:'Synthetic user invoice',revision:task.revision};
 const invoiceRequest=(token:string)=>new Request('https://control.example/v1/autonomous-tasks/'+task.id+'/external-actions/'+request.requestId+'/billing',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(earlyInvoice)});
 assert.equal((await handleAutonomousExternalApi(invoiceRequest(worker),{operatorToken:operator,workerToken:worker,service:runtime.service})).status,401);
 assert.equal((await handleAutonomousExternalApi(invoiceRequest(operator),{operatorToken:operator,workerToken:worker,service:runtime.service})).status,409);
 assert.equal((await f.core().execute('get',{id:task.id}) as AutonomousTask).interventions.filter(i=>i.kind==='reconciliation').length,0);

 await finishWait(f,lease,runtimeId,1,f.now()+1000);await runtime.service.beforeCoreMutation(task.id,'cancel');await f.core().execute('cancel',{id:task.id,reason:'synthetic operator stop'});f.time(lease.expiresAt+1);f.restart();
 const restarted=f.runtime();await restarted.recover();await restarted.service.cleanup(task.id,request.requestId);assert.equal(f.terminated(),true);assert.equal((await f.core().execute('get',{id:task.id}) as AutonomousTask).status,'stopping');
 await assert.rejects(restarted.service.execute(task.id,{lease,runtimeId,request:{...request,requestId:'blocked-new'}}));assert.equal(f.counts().creates,1);
 const localOperator='local-invoice-fixture';
 const proxy=createAutonomousCloudProxy({baseUrl:'https://control.example',controlToken:operator},{localTokens:[localOperator],fetch:async(url,init)=>handleAutonomousExternalApi(new Request(String(url),init),{operatorToken:operator,workerToken:worker,service:restarted.service})});
 const server=createHivemindMcpServer({apiUrl:'http://127.0.0.1:4310',operatorToken:localOperator,fetchImpl:async(url,init)=>{assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+localOperator);return proxy.forward(new Request(String(url),init));}});
 const client=new Client({name:'actual-operator-invoice-fixture',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
 const billingArgs={taskId:task.id,requestId:request.requestId,revision:task.revision,actualCostMicros:25,evidenceRef:'invoice_fixture_25',reason:'Synthetic user verified final invoice and provider-confirmed absence'};
 const result=await client.callTool({name:'hivemind_autonomous_record_external_cost',arguments:billingArgs});assert.equal(result.isError,undefined,JSON.stringify(result));const reported=result.structuredContent as {action:Record<string,unknown>};assert.equal(reported.action.billingSource,'operator_attested');assert.equal(reported.action.revision,task.revision);assert.equal(reported.action.evidenceRef,billingArgs.evidenceRef);assert.equal(reported.action.verifiedCostMicros,25);assert.ok(Number.isSafeInteger(reported.action.attestedAt));assert.equal(reported.action.resourceId,'i-1234abcd');assert.equal(reported.action.profileId,'aws-profile');assert.deepEqual(reported.action.approvedTarget,profile.target);assert.match(String(reported.action.approvedProfileHash),/^[a-f0-9]{64}$/);
 assert.equal((await client.callTool({name:'hivemind_autonomous_record_external_cost',arguments:billingArgs})).isError,undefined);
 for(const secret of [worker,lease.token,'SYNTHETIC_PRIVATE','ownershipToken','idempotencyKey'])assert.ok(!JSON.stringify(result).includes(secret));
 const final=await f.core().execute('get',{id:task.id}) as AutonomousTask;assert.equal(final.status,'cancelled');assert.equal(final.spentMicros,25);assert.equal(final.reservedMicros,0);assert.equal(final.resources[0]?.status,'cleaned');assert.equal(final.interventions.filter(i=>i.kind==='reconciliation').length,1);assert.equal(f.counts().creates,1);
});

test('actual factory profile hash change rejects stale approval preflight with 409 before any effect',async t=>{
 const f=fixture(t),task=await f.core().execute('create',{spec:f.spec}) as AutonomousTask,shown=await f.runtime().service.profiles(task.id);
 f.config.profiles[0]!.upperBoundMicros=90;const changed=f.runtime();await assert.rejects(changed.service.assertApproval(task.id,1,{[shown[0]!.id]:shown[0]!.profileHash}),(e:unknown)=>(e as {statusCode:number}).statusCode===409);assert.equal((await f.core().execute('get',{id:task.id}) as AutonomousTask).status,'awaiting_approval');assert.equal(f.counts().providerCalls,0);
});

test('real SQLite summary/history HTTP pages preserve counts/highwater and omit private execution state',async t=>{
 const f=fixture(t,false),task=await f.core().execute('create',{spec:f.spec}) as AutonomousTask;for(let i=0;i<21;i++)await f.core().execute('message',{id:task.id,message:'synthetic message '+i});
 const get=(suffix:string)=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks/'+task.id+suffix,{headers:{authorization:'Bearer '+operator}}),{operatorToken:operator,workerToken:worker,service:f.core()});
 const summary=await (await get('?view=summary')).json() as Record<string,any>;assert.equal(summary.counts.humanInterventions,21);assert.equal(summary.runs,undefined);assert.equal(summary.interventions,undefined);
 const first=await (await get('/history?kind=interventions&limit=10')).json() as any;assert.equal(first.items.length,10);assert.ok(first.nextCursor);await f.core().execute('message',{id:task.id,message:'outside highwater'});
 const second=await (await get('/history?kind=interventions&limit=10&cursor='+encodeURIComponent(first.nextCursor))).json() as any;assert.equal(second.items.length,10);assert.ok(!JSON.stringify(second).includes('outside highwater'));assert.doesNotMatch(JSON.stringify({summary,first,second}),/lease|checkpoint|nativeRuntime|SYNTHETIC_PRIVATE/);
 const third=await (await get('/history?kind=interventions&limit=10&cursor='+encodeURIComponent(second.nextCursor))).json() as any;assert.equal(third.items.length,1);assert.equal(third.nextCursor,undefined);assert.ok(!JSON.stringify(third).includes('outside highwater'));
});

test('real SQLite quota/daily schedule prevents dispatch before the effective daily wake after restart',async t=>{
 const f=fixture(t,false),wake=Date.parse('2026-11-20T09:00:00Z'),reset=wake+3600000;f.time(wake-1000);
 const task=await f.core().execute('create',{spec:{...f.spec,endsAt:wake+3*86400000,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'}}}) as AutonomousTask;await f.core().execute('approve',{id:task.id,revision:1,reason:'synthetic daily approval'});
 assert.equal(await f.core().execute('claim',{id:task.id,workerId:'worker'}),null);f.time(wake+2000);const lease=await claim(f,task.id);await f.core().execute('nativeStart',{lease,runtimeId:'quota-runtime'});
 const quota={kind:'rejected',resetsAt:reset,evidence:'claude_rate_limit_event'},result={outcome:'wait',wakeAt:reset,quota,usageUnavailable:true,usage:zero,costMicros:null,checkpoint:{sessionId:'quota-session',model:f.spec.model,sequence:1,objectKey:'private/quota'}};
 await f.core().execute('recordNativeReceipt',{lease,receipt:{runId:lease.runId,runtimeId:'quota-runtime',sessionId:'quota-session',model:f.spec.model,sequence:1,usage:zero,stopped:true,outcome:'wait',wakeAt:reset,quota,usageUnavailable:true}});await f.core().execute('finish',{lease,result});f.restart();f.time(reset);
 assert.equal(await f.core().execute('claim',{id:task.id,workerId:'worker'}),null);f.time(wake+86400000+2000);assert.ok(await claim(f,task.id));assert.equal(f.counts().realModelCalls,0);
});

test('actual SDK action through canonical C3 HTTP creates an owned synthetic job once without authority leakage',async t=>{
 const f=fixture(t),{task,runtime}=await approve(f),service=runtime.service;const lease=await claim(f,task.id),runtimeId=randomUUID();const approval=await f.core().execute('nativeStart',{lease,runtimeId}) as {deadline:number};
 const statuses:number[]=[],producer:Record<string,unknown>[]=[];const fetcher:typeof fetch=async(url,init)=>{const response=await handleAutonomousExternalApi(new Request(String(url),init),{operatorToken:operator,workerToken:worker,service});statuses.push(response.status);producer.push(await response.clone().json() as Record<string,unknown>);return response;};
 const server=createActionMcpServer({version:1,runtimeId,executionDeadline:approval.deadline,request:{taskId:task.id,executionLease:lease,maxRunMs:60000,externalProfiles:['aws-profile']},control:{origin:'https://control.example',workerToken:worker}},{fetchImpl:fetcher});
 const client=new Client({name:'remaining-real-action-client',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
 const arguments_={profileId:'aws-profile',requestId:'model-request',operation:'aws.spot.start',parameters:{lifetimeMs:10000}};
 const result=await client.callTool({name:'action',arguments:arguments_});assert.equal(result.isError,undefined);const duplicate=await client.callTool({name:'action',arguments:arguments_});assert.equal(duplicate.isError,undefined);
 const projected=result.structuredContent as Record<string,unknown>;assert.deepEqual(statuses,[200,200]);assert.equal(projected.requestId,'model-request');assert.equal(projected.phase,'broker');assert.equal(projected.verifiedCostMicros,null);for(const key of ['upperBoundMicros','reservedMicros','verifiedCostMicros','billingFinal']){assert.equal(projected[key],producer[0]![key]);if(!Object.hasOwn(producer[0]!,key))assert.equal(Object.hasOwn(projected,key),false);}
 for(const secret of [worker,lease.token,runtimeId,'SYNTHETIC_PRIVATE','ownershipToken','idempotencyKey','evidenceId'])assert.ok(!JSON.stringify(result).includes(secret));assert.equal(f.counts().realModelCalls,0);assert.equal(f.counts().creates,1);
 const current=await f.core().execute('get',{id:task.id}) as AutonomousTask;assert.equal(current.actions[0]?.status,'accepted');assert.equal(current.resources[0]?.status,'active');
});
