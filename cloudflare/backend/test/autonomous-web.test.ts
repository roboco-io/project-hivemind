import test from 'node:test';
import assert from 'node:assert/strict';
import {approveAutonomousWeb,validateWebHosts,dispatchAutonomousWeb,type AutonomousWebTransport} from '../src/runtime/autonomous-web.ts';
const env={AUTONOMOUS_WEB_ENABLED:'true',AUTONOMOUS_WEB_ALLOWED_HOSTS:'docs.example.com,other.example.com'};
const control='https://control.example.com';
test('web approval requires explicit server enablement and upper allowlist',()=>{
 for(const settings of [{},{...env,AUTONOMOUS_WEB_ENABLED:'TRUE'},{...env,AUTONOMOUS_WEB_ALLOWED_HOSTS:''}])assert.throws(()=>approveAutonomousWeb({allowedHosts:['docs.example.com']},settings,control));
 assert.equal(approveAutonomousWeb(undefined,{},control),undefined);
 assert.deepEqual(approveAutonomousWeb({allowedHosts:['docs.example.com']},env,control),{allowedHosts:['docs.example.com']});
 assert.throws(()=>approveAutonomousWeb({allowedHosts:['unapproved.example.com']},env,control));
});
test('exact DNS policy rejects local IP encodings provider control and wildcard aliases',()=>{
 for(const host of ['127.0.0.1','127.1','2130706433','0x7f000001','[::1]','10.0.0.1','localhost','a.local','a.internal','a.localdomain','a.private','a.corp','metadata.google.internal','169.254.169.254','*.example.com','docs.example.com:443','https://docs.example.com','user@docs.example.com','docs.example.com.','doc%73.example.com','a_b.example.com','api.anthropic.com','x.api.anthropic.com','claude.ai','auth.openai.com','control.example.com','a.control.example.com','127.0.0.1.nip.io','localtest.me'])assert.throws(()=>validateWebHosts([host],control),host);
 assert.deepEqual(validateWebHosts(['DOCS.example.com'],control),['docs.example.com']);
});
function transport(onFetch?:(request:Request)=>void):AutonomousWebTransport{return {async resolve(){return {addresses:['93.184.216.34'],aliases:[]};},async fetch(request,route){assert.deepEqual(route.addresses,['93.184.216.34']);onFetch?.(request);return new Response('synthetic');}};}
test('default transport is closed and no caller header grants web authority',async()=>{
 const req=new Request('https://docs.example.com/a',{headers:{'x-hivemind-web-hosts':'docs.example.com'}});
 assert.equal((await dispatchAutonomousWeb(req,{allowedHosts:['docs.example.com']},control)).status,403);
 assert.equal((await dispatchAutonomousWeb(req,{allowedHosts:[]},control,transport(()=>assert.fail('No request')))).status,403);
});
test('synthetic web forwarding uses public resolved address and removes credentials',async()=>{
 let forwarded=false;const req=new Request('https://docs.example.com/a',{headers:{authorization:'Bearer fixture',cookie:'fixture=1','x-hivemind-native':'fixture',accept:'text/plain'}});
 const response=await dispatchAutonomousWeb(req,{allowedHosts:['docs.example.com']},control,transport(request=>{forwarded=true;assert.equal(request.redirect,'manual');const headers:Record<string,string>={};request.headers.forEach((value,key)=>{headers[key]=value;});assert.deepEqual(headers,{accept:'text/plain'});}));
 assert.equal(await response.text(),'synthetic');assert.equal(forwarded,true);
});
test('DNS private results mixed answers and indirect aliases never reach transport fetch',async()=>{
 for(const result of [{addresses:['127.0.0.1']},{addresses:['93.184.216.34','10.0.0.1']},{addresses:['::ffff:127.0.0.1']},{addresses:['2001:db8::1']},{addresses:[]},{addresses:['93.184.216.34'],aliases:['control.example.com']},{addresses:['93.184.216.34'],aliases:['api.anthropic.com']},{addresses:['93.184.216.34'],aliases:['unapproved.example.com']}]){
  const t:AutonomousWebTransport={async resolve(){return result;},async fetch(){assert.fail('DNS must fail closed');}};
  assert.equal((await dispatchAutonomousWeb(new Request('https://docs.example.com'),{allowedHosts:['docs.example.com']},control,t)).status,403);
 }
});
test('redirects and mismatched HTTPS hosts methods and ports cannot escape policy',async()=>{
 for(const url of ['http://docs.example.com','https://other.example.com','https://sub.docs.example.com','https://docs.example.com:444','https://127.0.0.1'])assert.equal((await dispatchAutonomousWeb(new Request(url),{allowedHosts:['docs.example.com']},control,transport(()=>assert.fail('Denied URL')))).status,403);
 assert.equal((await dispatchAutonomousWeb(new Request('https://docs.example.com',{method:'POST'}),{allowedHosts:['docs.example.com']},control,transport(()=>assert.fail('Denied method')))).status,403);
 for(const location of ['https://docs.example.com/next','https://127.0.0.1','https://control.example.com']){let calls=0;const t=transport();t.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location}});};assert.equal((await dispatchAutonomousWeb(new Request('https://docs.example.com'),{allowedHosts:['docs.example.com']},control,t)).status,403);assert.equal(calls,1);}
});
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'),shortCircuit:true};return next(specifier,context);}});
const nativeEnv={...env,AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:control,AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:'fixture-storage',AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true'};
test('Runner pins separate trusted props for each native container and restores them',async()=>{
 const {RunnerDO}=await import('../src/cloudflare/worker.ts');
 for(const [index,host] of ['docs.example.com','other.example.com'].entries()){
  const rows=new Map<string,unknown>(),props:unknown[]=[],intercepts:unknown[]=[],pending:Promise<unknown>[]=[];
  const binding={fetch:async()=>new Response('fixture')};
  const ctx={storage:{async get(key:string){return structuredClone(rows.get(key));},async put(key:string,value:unknown){rows.set(key,structuredClone(value));}},exports:{NativeClaudeOutbound(options:unknown){props.push(options);return binding;}},blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;},container:{running:true,async interceptAllOutboundHttp(handler:unknown){intercepts.push(handler);},async interceptOutboundHttps(_host:string,handler:unknown){intercepts.push(handler);},getTcpPort(){return {async fetch(){return Response.json({ok:false});}};}}};
  const job={id:`job${index}`,attempt:`attempt${index}`,kind:'agent',provider:'claude',autonomous:{taskId:`task${index}`,runId:'run'}};
  const grant={taskId:`task${index}`,jobId:job.id,attempt:job.attempt,expiresAt:Date.now()+60000,allowedHosts:[host]};
  const runner=new RunnerDO(ctx as never,nativeEnv as never);await Promise.all(pending);
  await runner.ensure(job as never,grant);
  assert.deepEqual(props,[{props:{webGrant:grant}}]);assert.deepEqual(intercepts,[binding,binding]);
  const restored=new RunnerDO(ctx as never,nativeEnv as never);await pending.at(-1);await restored.ensure(job as never,grant);
  assert.deepEqual(props[1],props[0]);
  await assert.rejects(restored.ensure(job as never,{...grant,allowedHosts:['unapproved.example.com']}));
 }
});
test('actual native outbound remains web closed without transport regardless of headers',async(t)=>{
 const {NativeClaudeOutbound}=await import('../src/cloudflare/worker.ts');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('synthetic');});
 const entry=new NativeClaudeOutbound({props:{webGrant:{taskId:'task',jobId:'job',attempt:'attempt',expiresAt:Date.now()+60000,allowedHosts:['docs.example.com']}}} as never,nativeEnv as never);
 assert.equal((await entry.fetch(new Request('https://docs.example.com',{headers:{'x-hivemind-web-hosts':'docs.example.com'}}))).status,403);
 assert.equal(calls,0);
 assert.equal((await entry.fetch(new Request(control+'/v1/autonomous-tasks/task/native-start',{method:'POST',headers:{authorization:'Bearer wrong'}}))).status,403);
 assert.equal(calls,0);
});
test('actual approval pins only task hosts and rejects requests outside server upper bound',async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
 const {nativeApprovalKey}=await import('../src/cloudflare/autonomous-ports.ts');
 const {createSnapshot}=await import('../src/snapshot.ts');const snapshot=createSnapshot([]);
 for(const host of ['docs.example.com','unapproved.example.com']){
  const rows=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let approvals=0;
  const storage={async get(key:string){return structuredClone(rows.get(key));},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async getAlarm(){return null;},async setAlarm(){}};
  const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
  const actor=new SchedulerDO(ctx as never,{...nativeEnv,ARTIFACTS:{async get(){return {async json(){return snapshot;}};}}} as never);await Promise.all(pending);
  const task={id:'task',revision:1,status:'awaiting_approval',spec:{web:{allowedHosts:[host]},execution:{backend:'cloudflare',snapshotId:snapshot.digest}}};
  Object.assign(actor,{autonomy:{supportsLongRunning:true,async execute(op:string){if(op==='get')return task;if(op==='approve'){approvals++;return task;}if(op==='listPage')return {items:[]};throw Error('Unexpected operation');}}});
  const response=await actor.fetch(new Request(control+'/v1/autonomous-tasks/task/approve',{method:'POST',headers:{authorization:'Bearer fixture-operator','content-type':'application/json'},body:JSON.stringify({revision:1,reason:'fixture'})}));
  assert.equal(response.status,host==='docs.example.com'?200:422);
  assert.equal(approvals,host==='docs.example.com'?1:0);
  const approval=rows.get(nativeApprovalKey('task')) as {web?:{allowedHosts:string[]}}|undefined;
  assert.deepEqual(approval?.web,host==='docs.example.com'?{allowedHosts:['docs.example.com']}:undefined);
 }
});
test('private native submission carries the pinned task policy rather than a global allowlist',async()=>{
 const {LegacyAutonomousCloudPorts,nativeJobKey,nativeApprovalKey}=await import('../src/cloudflare/autonomous-ports.ts');
 const {Scheduler}=await import('../src/scheduler.ts');
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});
 const rows=new Map<string,unknown>();rows.set(nativeApprovalKey('task'),{revision:1,web:{allowedHosts:['docs.example.com']}});
 const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));}};
 const ports=new LegacyAutonomousCloudPorts({scheduler,storage,enabled:()=>true,sourceReady:async()=>true,save:async()=>{}});
 const task={id:'task',revision:1,spec:{goal:'fixture',provider:'claude',credentialIds:['shared'],maxRunMs:120000,web:{allowedHosts:['docs.example.com']},execution:{checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},checkpoint:undefined};
 await ports.submit({task,lease:{taskId:'task',runId:'run'},jobId:'web-native',idempotencyKey:'web-native',snapshotId:'a'.repeat(64)} as never);
 const record=rows.get(nativeJobKey('web-native')) as {webPolicy:{allowedHosts:string[]}};
 assert.deepEqual(record.webPolicy,{allowedHosts:['docs.example.com']});
});
test('noncloud approval without web does not require native configuration',async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');const pending:Promise<unknown>[]=[];
 const storage={async get(){},async put(){},async getAlarm(){return null;},async setAlarm(){}};
 const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 const actor=new SchedulerDO(ctx as never,{CONTROL_TOKEN:'fixture-operator'} as never);await Promise.all(pending);
 const task={id:'task',revision:1,spec:{provider:'mock'}};
 Object.assign(actor,{autonomy:{async execute(op:string){return op==='listPage'?{items:[]}:task;}}});
 const response=await actor.fetch(new Request(control+'/v1/autonomous-tasks/task/approve',{method:'POST',headers:{authorization:'Bearer fixture-operator','content-type':'application/json'},body:JSON.stringify({revision:1,reason:'fixture'})}));
 assert.equal(response.status,200);
});
