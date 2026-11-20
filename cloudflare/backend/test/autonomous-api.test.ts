import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutonomousTask, AutonomousLease } from '../../../packages/contracts/src/autonomous.ts';
type ApiBody = AutonomousTask & {lease:AutonomousLease;task:AutonomousTask};
import { AutonomousService } from '../src/autonomous-service.ts';
import { handleAutonomousApi } from '../src/cloudflare/autonomous-api.ts';

class MemoryStorage {
 data=new Map<string,unknown>(); fail=false; writes=0;
 async get<T>(key:string):Promise<T|undefined>{return structuredClone(this.data.get(key)) as T|undefined;}
 async put<T>(key:string,value:T):Promise<void>{if(this.fail)throw new Error('disk unavailable secret');this.writes++;this.data.set(key,structuredClone(value));}
}
const spec={requestId:'r',goal:'goal',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:['fetch'],systems:['test'],credentialIds:[],maxRunMs:1000,maxIterations:4};
const url='http://local/v1/autonomous-tasks';
function req(path:string,body?:unknown,worker=false){return new Request(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${worker?'worker':'operator'}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
function setup(storage=new MemoryStorage()) {const service=new AutonomousService(storage,()=>1000);return {storage,service,options:{operatorToken:'operator',workerToken:'worker',service}};}
test('Durable restore preserves draft without starting execution',async()=>{
 const {storage,options}=setup();const created=await handleAutonomousApi(req('',spec),options);assert.equal(created.status,201);const task=await created.json() as ApiBody;
 const restored=setup(storage);const response=await handleAutonomousApi(req('/'+task.id),restored.options);assert.equal(response.status,200);assert.equal((await response.json() as ApiBody).status,'awaiting_approval');
});
test('concurrent mutations serialize and failed put does not publish state',async()=>{
 const {storage,service}=setup();await Promise.all([service.execute('create',{spec}),service.execute('create',{spec:{...spec,requestId:'r2'}})]);
 assert.equal((await service.execute('list',{}) as unknown[]).length,2);
 storage.fail=true;await assert.rejects(service.execute('create',{spec:{...spec,requestId:'r3'}}));storage.fail=false;
 assert.equal((await service.execute('list',{}) as unknown[]).length,2);
 assert.equal((await setup(storage).service.execute('list',{}) as unknown[]).length,2);
});
test('scope denial intentionally suspends and persists before error response',async()=>{
 const {storage,options}=setup();const task=await (await handleAutonomousApi(req('',spec),options)).json() as ApiBody;
 assert.equal((await handleAutonomousApi(req('/'+task.id+'/approve',{revision:task.revision,reason:'approved'}),options)).status,200);
 const claim=await (await handleAutonomousApi(req('/'+task.id+'/claim',{workerId:'worker'},true),options)).json() as ApiBody;assert.ok(claim.lease.token);
 const denied=await handleAutonomousApi(req('/'+task.id+'/reserve',{lease:claim.lease,request:{requestId:'action',tool:'forbidden',system:'test',operation:'read',estimatedCostMicros:1}},true),options);
 assert.ok([409,422].includes(denied.status));
 const restored=setup(storage);const response=await handleAutonomousApi(req('/'+task.id),restored.options);assert.equal((await response.json() as ApiBody).status,'awaiting_input');
});
test('claim exposes only own lease and public responses never expose credentials',async()=>{
 const {options}=setup();const task=await (await handleAutonomousApi(req('',spec),options)).json() as ApiBody;
 await handleAutonomousApi(req('/'+task.id+'/approve',{revision:task.revision,reason:'approved'}),options);
 const claim=await (await handleAutonomousApi(req('/'+task.id+'/claim',{workerId:'worker'},true),options)).json() as ApiBody;assert.ok(claim.lease.token);assert.ok(claim.task.spec);assert.equal(claim.task.lease?.token,undefined);
 for(const path of ['', '/'+task.id])assert.ok(!(await (await handleAutonomousApi(req(path),options)).text()).includes(claim.lease.token));
 assert.equal((await handleAutonomousApi(req('/'+task.id,undefined,true),options)).status,401);
});
test('tick persists clock transitions before returning',async()=>{
 const storage=new MemoryStorage();const service=new AutonomousService(storage,()=>1000);await service.execute('create',{spec});
 const before=storage.writes;await service.tick();assert.ok(storage.writes>before);
});

test('storage capacity failure preserves the previous committed snapshot',async()=>{
 const {storage,service}=setup();await service.execute('create',{spec});const before=structuredClone([...storage.data]);
 // Each individual goal stays within core limits; aggregate history exceeds the safe KV value bound.
 let denied=false;
 for(let i=0;i<200;i++){
  const previous=structuredClone([...storage.data]);
  try{await service.execute('create',{spec:{...spec,requestId:'large-'+i,goal:'x'.repeat(11000)}});}catch(error){assert.equal((error as {statusCode?:number}).statusCode,413);assert.deepEqual([...storage.data],previous);denied=true;break;}
 }
 assert.ok(denied);assert.ok(storage.data.size>=before.length);
});
test('failed suspension persistence leaves the previously running task intact',async()=>{
 const {storage,service}=setup();const task=await service.execute('create',{spec}) as {id:string;revision:number};
 await service.execute('approve',{id:task.id,revision:task.revision,reason:'yes'});const claim=await service.execute('claim',{id:task.id,workerId:'w'}) as {lease:unknown};
 storage.fail=true;await assert.rejects(service.execute('reserve',{id:task.id,lease:claim.lease,request:{requestId:'deny',tool:'no',system:'test',operation:'read',estimatedCostMicros:1}}));storage.fail=false;
 assert.equal((await setup(storage).service.execute('get',{id:task.id}) as {status:string}).status,'running');
});

test('capacity headroom preserves cancellation, cleanup and reads while denying new work',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');
 const {AUTONOMOUS_STATE_MAX_BYTES}=await import('../src/autonomous-service.ts');
 const engine=new AutonomousEngine();const task=engine.create(spec as Parameters<typeof engine.create>[0],1000,'target');
 engine.approve(task.id,task.revision,'approved',1000);const lease=engine.claim(task.id,'worker','token','run',1000)!;
 const action=engine.reserve(lease,{requestId:'resource',tool:'fetch',system:'test',operation:'create',estimatedCostMicros:1},1000);
 engine.settle(lease,action.id,1,true,{id:'resource',system:'test',cleanupOperation:'delete'},1000);
 engine.finish(lease,{outcome:'continue',usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},costMicros:0},1000);
 let state=engine.snapshot();let index=0;const bytes=(s:unknown)=>new TextEncoder().encode(JSON.stringify(s)).byteLength;
 while(bytes(state)<AUTONOMOUS_STATE_MAX_BYTES-5500){
  engine.create({...spec,requestId:'padding-'+index,goal:'x'.repeat(5000)} as Parameters<typeof engine.create>[0],1000,'padding-'+index++);state=engine.snapshot();
 }
 const last=state.tasks['padding-'+(index-1)]!;
 last.spec.goal+='x'.repeat(AUTONOMOUS_STATE_MAX_BYTES-8-bytes(state));
 assert.equal(bytes(state),AUTONOMOUS_STATE_MAX_BYTES-8);
 const storage=new MemoryStorage();await storage.put('autonomous-state',state);const {service}=setup(storage);
 assert.equal((await service.execute('cancel',{id:task.id,reason:'stop safely at storage capacity'}) as AutonomousTask).status,'stopping');
 assert.ok(bytes(storage.data.get('autonomous-state'))>AUTONOMOUS_STATE_MAX_BYTES);
 const cancelled=await service.execute('cleaned',{id:task.id,resourceId:'resource'}) as AutonomousTask;assert.equal(cancelled.status,'cancelled');
 await service.tick();assert.equal((await service.execute('list',{}) as AutonomousTask[]).length,index+1);
 const before=structuredClone([...storage.data]);
 await assert.rejects(service.execute('create',{spec:{...spec,requestId:'no-headroom-work'}}),{statusCode:413});assert.deepEqual([...storage.data],before);
 assert.ok(bytes(storage.data.get('autonomous-state'))<1900*1024);
});

test('native approval persists runtime binding and outer Cloudflare auth requires worker',async()=>{
 const {authorizeAutonomousRoute}=await import('../src/cloudflare/api.ts');
 const {storage,options}=setup();
 const task=await (await handleAutonomousApi(req('',{...spec,provider:'claude'}),options)).json() as ApiBody;
 await handleAutonomousApi(req('/'+task.id+'/approve',{revision:1,reason:'approved'}),options);
 const claim=await (await handleAutonomousApi(req('/'+task.id+'/claim',{workerId:'worker'},true),options)).json() as ApiBody;
 const path='/'+task.id+'/native-start',body={lease:claim.lease,runtimeId:'native-runtime'};
 assert.equal(authorizeAutonomousRoute(req(path,body),'operator','worker')?.status,401);
 assert.equal(authorizeAutonomousRoute(req(path,body,true),'operator','worker'),null);
 assert.equal((await handleAutonomousApi(req(path,body),options)).status,401);
 assert.equal((await handleAutonomousApi(req(path,{...body,lease:{...claim.lease,token:'forged'}},true),options)).status,409);
 const first=await handleAutonomousApi(req(path,body,true),options);assert.equal(first.status,200);
 const auth=await first.json() as {deadline:number;spec:{provider:string}};assert.equal(auth.deadline,2000);assert.equal(auth.spec.provider,'claude');
 const restored=setup(storage);assert.equal((await handleAutonomousApi(req(path,body,true),restored.options)).status,200);
 assert.equal((await handleAutonomousApi(req(path,{...body,runtimeId:'duplicate'},true),restored.options)).status,409);
 assert.doesNotMatch(await (await handleAutonomousApi(req('/'+task.id),restored.options)).text(),/native-runtime|nativeRuntimeId/);
 await handleAutonomousApi(req('/'+task.id+'/cancel',{reason:'stop'}),restored.options);
 assert.equal((await handleAutonomousApi(req(path,body,true),restored.options)).status,409);
});
