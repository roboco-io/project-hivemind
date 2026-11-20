import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAutonomousApi, type AutonomousApiService } from '../apps/control-plane/src/autonomous-api.js';

const prefix = 'http://local/v1/autonomous-tasks';
const calls: {operation:string;input:Record<string,unknown>}[] = [];
const fake: AutonomousApiService = { async execute(operation,input) { calls.push({operation,input}); return {id:'task'}; } };
const options = {operatorToken:'operator-secret',workerToken:'worker-secret',service:fake};
const spec = {requestId:'request',goal:'goal',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3};
function request(path='', body?:unknown, token='operator-secret', method=body===undefined?'GET':'POST') {
 return new Request(prefix+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
test('authorization precedes malformed body parsing',async()=>{
 const response=await handleAutonomousApi(new Request(prefix+'/task/claim',{method:'POST',headers:{authorization:'Bearer operator-secret'},body:'not json'}),options);
 assert.equal(response.status,401);
});
test('worker cannot list, approve or confirm cleanup',async()=>{
 for(const [path,body] of [['',undefined],['/task/approve',{revision:1,reason:'yes'}],['/task/cleaned',{resourceId:'resource'}]] as const){
  assert.equal((await handleAutonomousApi(request(path,body,'worker-secret'),options)).status,401);
 }
});
test('worker endpoints fail closed without distinct configured token',async()=>{
 for(const workerToken of ['',options.operatorToken]) assert.equal((await handleAutonomousApi(request('/task/claim',{workerId:'worker'}),{...options,workerToken})).status,503);
});
test('direct spec create and operator routes dispatch only allowed fields',async()=>{
 const response=await handleAutonomousApi(request('',spec),options); assert.equal(response.status,201);
 assert.deepEqual(calls.at(-1),{operation:'create',input:{spec}});
 assert.equal((await handleAutonomousApi(request('/task/approve',{revision:1,reason:'yes'}),options)).status,200);
 assert.deepEqual(calls.at(-1),{operation:'approve',input:{id:'task',revision:1,reason:'yes'}});
 assert.equal((await handleAutonomousApi(request('/task/approve',{revision:1,reason:'yes',now:0}),options)).status,400);
});
test('claim receives worker identity and server controls lease identifiers',async()=>{
 assert.equal((await handleAutonomousApi(request('/task/claim',{workerId:'worker'},'worker-secret'),options)).status,200);
 assert.deepEqual(calls.at(-1),{operation:'claim',input:{id:'task',workerId:'worker'}});
 assert.equal((await handleAutonomousApi(request('/task/claim',{workerId:'worker',token:'chosen'},'worker-secret'),options)).status,400);
});
test('full lease is mandatory and task identity must match path',async()=>{
 const lease={taskId:'other',runId:'run',workerId:'worker',token:'lease-secret',expiresAt:1000};
 for(const body of [{lease},{lease:{taskId:'task',token:'secret'}}]) assert.equal((await handleAutonomousApi(request('/task/heartbeat',body,'worker-secret'),options)).status,400);
});
test('unknown nested result fields and malformed JSON are rejected',async()=>{
 const lease={taskId:'task',runId:'run',workerId:'worker',token:'secret',expiresAt:1000};
 const result={outcome:'complete',usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,secret:'x'},costMicros:0};
 assert.equal((await handleAutonomousApi(request('/task/finish',{lease,result},'worker-secret'),options)).status,400);
 assert.equal((await handleAutonomousApi(new Request(prefix,{method:'POST',headers:{authorization:'Bearer operator-secret'},body:'{'}),options)).status,400);
});
test('request byte size is bounded including streaming bodies',async()=>{
 const response=await handleAutonomousApi(new Request(prefix,{method:'POST',headers:{authorization:'Bearer operator-secret'},body:JSON.stringify({goal:'가'.repeat(30000)})}),options);
 assert.equal(response.status,413);
});
test('service conflict maps to 409 without exposing internal error text',async()=>{
 const service:AutonomousApiService={async execute(){throw Object.assign(new Error('private lease-secret'),{status:409});}};
 const response=await handleAutonomousApi(request('/task/approve',{revision:1,reason:'yes'}),{...options,service});
 assert.equal(response.status,409); assert.doesNotMatch(await response.text(),/private|lease-secret/);
});
test('public responses defensively redact lease token and private checkpoint',async()=>{
 const service:AutonomousApiService={async execute(){return {id:'task',lease:{token:'private-token',runId:'run'},checkpoint:{objectKey:'private-key'}};}};
 const response=await handleAutonomousApi(request('/task'),{...options,service});
 const body=await response.text(); assert.doesNotMatch(body,/private-token|private-key/);
});

test('SQLite restores drafts, rolls back ordinary errors and persists intentional scope denial',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const dir=mkdtempSync(join(tmpdir(),'autonomous-store-'));const path=join(dir,'state.sqlite');let store=createAutonomousStore(path);
 try {
  const input={...spec,tools:['fetch'],systems:['test']} as Parameters<typeof store.create>[0];
  const task=store.create(input,1000,'task');store.close();store=createAutonomousStore(path);assert.equal(store.get(task.id).status,'awaiting_approval');
  assert.throws(()=>store.approve('task',999,'stale',1000));assert.equal(store.get('task').status,'awaiting_approval');
  store.approve('task',task.revision,'approved',1000);const lease=store.claim('task','worker','private-token','run',1000)!;
  assert.throws(()=>store.reserve(lease,{requestId:'action',tool:'forbidden',system:'test',operation:'read',estimatedCostMicros:1},1000));
  store.close();store=createAutonomousStore(path);assert.equal(store.get('task').status,'awaiting_input');assert.doesNotMatch(JSON.stringify(store.list()),/private-token/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('operator reconcile is strict and inaccessible to workers',async()=>{
 const body={actionId:'action',actualCostMicros:1,success:true,reason:'verified'};
 assert.equal((await handleAutonomousApi(request('/task/reconcile',body,'worker-secret'),options)).status,401);
 assert.equal((await handleAutonomousApi(request('/task/reconcile',body),options)).status,200);
 assert.deepEqual(calls.at(-1),{operation:'reconcile',input:{id:'task',...body}});
 assert.equal((await handleAutonomousApi(request('/task/reconcile',{...body,resource:{id:'r',system:'s',cleanupOperation:'remove',secret:'x'}}),options)).status,400);
});
test('SQLite state file is private and independent handles do not lose writes',async()=>{
 const {mkdtempSync,rmSync,statSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const dir=mkdtempSync(join(tmpdir(),'autonomous-perms-'));const path=join(dir,'state.sqlite');const a=createAutonomousStore(path),b=createAutonomousStore(path);
 try{
  assert.equal(statSync(path).mode&0o777,0o600);
  a.create(spec as Parameters<typeof a.create>[0],1000,'one');b.create({...spec,requestId:'second'} as Parameters<typeof b.create>[0],1000,'two');
  assert.equal(a.list().length,2);assert.equal(b.list().length,2);
  assert.throws(()=>a.transaction(engine=>{engine.cancel('one','cancel',1000);throw new Error('rollback');}));
  assert.equal(b.get('one').status,'awaiting_approval');
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('swappable policy producer seam: draft approval claim',async()=>{
 const {createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js');
 type Engine=Parameters<Parameters<import('../apps/control-plane/src/autonomous-api.js').AutonomousTransactionalStore['transaction']>[0]>[0];
 class FakeEngine {
  tasks=new Map<string,Record<string,unknown>>();tick(){}
  create(spec:unknown,_now:number,id:string){const task={id,spec,revision:1,status:'awaiting_approval'};this.tasks.set(id,task);return structuredClone(task);}
  get(id:string){return structuredClone(this.tasks.get(id));}
  approve(id:string){const task=this.tasks.get(id)!;task.status='ready';return this.get(id);}
  claim(id:string,workerId:string,token:string,runId:string,now:number){const task=this.tasks.get(id)!;if(task.status!=='ready')return null;task.status='running';return {taskId:id,workerId,token,runId,expiresAt:now+1000};}
 }
 const engine:Engine=process.env.SUPERLITE_REAL==='1'?new (await import('../packages/core/src/autonomous.js')).AutonomousEngine():new FakeEngine() as unknown as Engine;
 const service=createAutonomousApiService({transaction:fn=>fn(engine)},()=>1000);
 const config={...options,service};const task=await (await handleAutonomousApi(request('',spec),config)).json();
 assert.equal(task.status,'awaiting_approval');assert.equal(await (await handleAutonomousApi(request('/'+task.id+'/claim',{workerId:'w'},'worker-secret'),config)).json(),null);
 assert.equal((await handleAutonomousApi(request('/'+task.id+'/approve',{revision:1,reason:'yes'}),config)).status,200);
 const claimed=await (await handleAutonomousApi(request('/'+task.id+'/claim',{workerId:'w'},'worker-secret'),config)).json();
 assert.equal(claimed.task.id,task.id);assert.equal(claimed.lease.taskId,task.id);assert.ok(claimed.lease.token);assert.equal(claimed.task.lease?.token,undefined);
});

test('valid worker result uses statusCode conflicts and keeps checkpoint private from operators',async()=>{
 const service:AutonomousApiService={async execute(operation){if(operation==='approve')throw {statusCode:409};if(operation==='claim')return {lease:{token:'secret'},task:{id:'task',spec,checkpoint:{sessionId:'session',objectKey:'private-object',model:'mock',sequence:1},lease:{token:'secret'}}};return null;}};
 const config={...options,service};
 assert.equal((await handleAutonomousApi(request('/task/approve',{revision:1,reason:'yes'}),config)).status,409);
 const claimed=await (await handleAutonomousApi(request('/task/claim',{workerId:'w'},'worker-secret'),config)).json();
 assert.equal(claimed.task.checkpoint.objectKey,'private-object');assert.equal(claimed.task.lease.token,undefined);assert.equal(claimed.lease.token,'secret');
});

test('operator resume and run reconciliation routes reject worker authority and extra scope',async()=>{
 for(const [suffix,body] of [['resume',{revision:1,reason:'resume'}],['reconcile-run',{runId:'run',actualCostMicros:4,reason:'invoice'}]] as const){
  assert.equal((await handleAutonomousApi(request('/task/'+suffix,body,'worker-secret'),options)).status,401);
  assert.equal((await handleAutonomousApi(request('/task/'+suffix,body),options)).status,200);
  assert.deepEqual(calls.at(-1),{operation:suffix==='resume'?'resume':'reconcileRun',input:{id:'task',...body}});
  assert.equal((await handleAutonomousApi(request('/task/'+suffix,{...body,tools:['forbidden']}),options)).status,400);
 }
});

test('SQLite write failure rolls back and next operation remains usable',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const dir=mkdtempSync(join(tmpdir(),'autonomous-rollback-'));const path=join(dir,'state.sqlite');const store=createAutonomousStore(path),raw=new DatabaseSync(path);
 try{
  store.create(spec as Parameters<typeof store.create>[0],1000,'task');
  raw.exec("CREATE TRIGGER reject_autonomous_write BEFORE UPDATE ON autonomous_state BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
  assert.throws(()=>store.approve('task',1,'approved',1000));
  raw.exec('DROP TRIGGER reject_autonomous_write');assert.equal(store.get('task').status,'awaiting_approval');
  assert.equal(store.approve('task',1,'approved',1000).status,'ready');
 }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('SQLite failed update rolls back approval and allows a later retry',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const dir=mkdtempSync(join(tmpdir(),'autonomous-commit-'));const path=join(dir,'state.sqlite');const store=createAutonomousStore(path);const faults=new DatabaseSync(path);
 try{
  const task=store.create(spec as Parameters<typeof store.create>[0],1000,'task');
  faults.exec("CREATE TRIGGER reject_autonomous_update BEFORE UPDATE ON autonomous_state BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  assert.throws(()=>store.approve(task.id,task.revision,'approve',1000),/injected write failure/);
  faults.exec('DROP TRIGGER reject_autonomous_update');
  assert.equal(store.get(task.id).status,'awaiting_approval');assert.equal(store.get(task.id).interventions.length,0);
  assert.equal(store.approve(task.id,task.revision,'retry',1000).status,'ready');
 }finally{faults.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('native-start requires worker role and strict lease/runtime body while preserving checkpoint',async()=>{
 const lease={taskId:'task',runId:'run',workerId:'worker',token:'secret',expiresAt:1000};
 const service:AutonomousApiService={async execute(operation,input){assert.equal(operation,'nativeStart');assert.deepEqual(input,{id:'task',lease,runtimeId:'native'});return {taskId:'task',spec,deadline:1000,checkpoint:{objectKey:'private-checkpoint'}};}};
 const config={...options,service};const body={lease,runtimeId:'native'};
 assert.equal((await handleAutonomousApi(request('/task/native-start',body),config)).status,401);
 for(const extra of [{now:0},{spec},{executionLease:lease}])assert.equal((await handleAutonomousApi(request('/task/native-start',{...body,...extra},'worker-secret'),config)).status,400);
 const response=await handleAutonomousApi(request('/task/native-start',body,'worker-secret'),config);assert.equal(response.status,200);assert.equal((await response.json()).checkpoint.objectKey,'private-checkpoint');
});

test('Fastify native-start authorizes worker before JSON parsing and persists binding',async()=>{
 const {buildApp}=await import('../apps/control-plane/src/app.js');const app=buildApp({operatorToken:'operator-secret',workerToken:'worker-secret',now:()=>1000});
 const post=(path:string,payload:Record<string,unknown>,token='operator-secret')=>app.inject({method:'POST',url:'/v1/autonomous-tasks'+path,headers:{authorization:`Bearer ${token}`},payload});
 try{
  const task=(await post('',{...spec,provider:'claude'})).json();await post('/'+task.id+'/approve',{revision:1,reason:'approved'});
  const {lease}=(await post('/'+task.id+'/claim',{workerId:'w'},'worker-secret')).json();const path='/'+task.id+'/native-start';
  assert.equal((await app.inject({method:'POST',url:'/v1/autonomous-tasks'+path,headers:{authorization:'Bearer operator-secret','content-type':'application/json'},payload:'not json'})).statusCode,401);
  const response=await post(path,{lease,runtimeId:'native'},'worker-secret');assert.equal(response.statusCode,200);assert.equal(response.json().deadline,2000);
  assert.equal((await post(path,{lease,runtimeId:'other'},'worker-secret')).statusCode,409);
 }finally{await app.close();}
});
