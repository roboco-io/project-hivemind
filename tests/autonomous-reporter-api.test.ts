import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAutonomousApi, type AutonomousApiService} from '../apps/control-plane/src/autonomous-api.js';
import {buildApp} from '../apps/control-plane/src/app.js';
const lease={taskId:'task',runId:'run',workerId:'worker',token:'lease',expiresAt:1000};
const receipt={runId:'run',runtimeId:'runtime',sessionId:'session',model:'model',sequence:1,outcome:'continue',usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},stopped:true};
const service:AutonomousApiService={async execute(operation){return operation==='workerState'?{taskId:'task',status:'running',endsAt:1000,iteration:1}:operation==='nativeReady'?{ready:true}:operation==='recordNativeReceipt'?{recorded:true}:{nativeReceipt:receipt,id:'task'};}};
const options={operatorToken:'operator',workerToken:'worker',reporterToken:'reporter',service};
function req(suffix:string,token:string,body?:unknown){return new Request('http://local/v1/autonomous-tasks/task/'+suffix,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
test('reporter paths use independent role before parsing',async()=>{
 for(const suffix of ['native-ready','native-receipt']){
  for(const token of ['operator','worker'])assert.equal((await handleAutonomousApi(req(suffix,token,'{'),options)).status,401);
  for(const reporterToken of [undefined,'',' ','operator','worker',' worker','operator ','report\tkey','report\u007fkey'])assert.equal((await handleAutonomousApi(req(suffix,'reporter','{'),{...options,reporterToken})).status,503);
 }
});
test('strict ready and receipt dispatch',async()=>{
 assert.deepEqual(await (await handleAutonomousApi(req('native-ready','reporter',{lease,runtimeId:'runtime'}),options)).json(),{ready:true});
 assert.deepEqual(await (await handleAutonomousApi(req('native-receipt','reporter',{lease,receipt}),options)).json(),{recorded:true});
 for(const bad of [{...receipt,stopped:false},{...receipt,secret:'secret'},{...receipt,usage:{...receipt.usage,outputTokens:-1}}])assert.equal((await handleAutonomousApi(req('native-receipt','reporter',{lease,receipt:bad}),options)).status,400);
});
test('worker state is worker only and receipt stays private',async()=>{
 for(const token of ['operator','reporter'])assert.equal((await handleAutonomousApi(req('worker-state',token),options)).status,401);
 assert.deepEqual(await (await handleAutonomousApi(req('worker-state','worker'),options)).json(),{taskId:'task',status:'running',endsAt:1000,iteration:1});
 const response=await handleAutonomousApi(new Request('http://local/v1/autonomous-tasks/task',{headers:{authorization:'Bearer operator'}}),options);
 assert.equal((await response.text()).includes('nativeReceipt'),false);
});
test('Fastify guard rejects reporter configuration before JSON parser',async()=>{
 for(const nativeReporterToken of [undefined,'',' ','operator','worker',' worker','operator ','report\tkey','report\u007fkey']){
 const app=buildApp({operatorToken:'operator',workerToken:'worker',nativeReporterToken});
 try{const r=await app.inject({method:'POST',url:'/v1/autonomous-tasks/task/native-ready',headers:{authorization:'Bearer reporter','content-type':'application/json'},payload:'{'});assert.equal(r.statusCode,503);}finally{await app.close();}
 }
});
test('receipt requires attested outcome and bounded wake time without cost flags',async()=>{
 const {outcome:_,...missing}=receipt;
 for(const bad of [missing,{...receipt,sequence:0},{...receipt,outcome:'unknown'},{...receipt,wakeAt:-1},{...receipt,costMicros:0}])assert.equal((await handleAutonomousApi(req('native-receipt','reporter',{lease,receipt:bad}),options)).status,400);
 assert.equal((await handleAutonomousApi(req('native-receipt','reporter',{lease,receipt:{...receipt,outcome:'wait',wakeAt:2000}}),options)).status,200);
});
test('billing policy accepts only explicit subscription external actions on Claude',async()=>{
 const spec={requestId:'request',goal:'goal',provider:'claude',model:'model',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3};
 const create=(body:unknown)=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks',{method:'POST',headers:{authorization:'Bearer operator'},body:JSON.stringify(body)}),options);
 assert.equal((await create({...spec,billingPolicy:{model:'subscription',budget:'external_actions'}})).status,201);
 for(const billingPolicy of [null,{}, {model:'subscription',budget:'all'}, {model:'subscription',budget:'external_actions',costMicros:0}])assert.equal((await create({...spec,billingPolicy})).status,400);
 assert.equal((await create({...spec,provider:'mock',billingPolicy:{model:'subscription',budget:'external_actions'}})).status,400);
});
test('swappable engine seam routes reporter operations inside transaction with server clock',async()=>{
 const {createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js');
 const {AutonomousEngine}=await import('../packages/core/src/autonomous.js');
 const calls:string[]=[];
 const fake={tick(now:number){assert.equal(now,100);calls.push('tick');},nativeReady(){return {ready:true};},recordNativeReceipt(){return {recorded:true};},workerState(){return {taskId:'task',status:'running',endsAt:100000,iteration:1};}};
 const real=new AutonomousEngine();
 const spec={requestId:'seam',goal:'goal',provider:'claude' as const,model:'model',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3,billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}};
 const t=real.create(spec,100,'task');real.approve('task',t.revision,'approved',100);
 const granted=real.claim('task','worker','lease','run',100)!;real.nativeStart(granted,'runtime',100);
 const engine=process.env.SUPERLITE_REAL==='1'?real:fake as unknown as typeof real;
 const service=createAutonomousApiService({transaction(fn){calls.push('transaction');return fn(engine);}},()=>100);
 assert.deepEqual(await service.execute('nativeReady',{lease:granted,runtimeId:'runtime'}),{ready:true});
 assert.deepEqual(await service.execute('recordNativeReceipt',{lease:granted,receipt}),{recorded:true});
 assert.deepEqual(await service.execute('workerState',{id:'task'}),{taskId:'task',status:'running',endsAt:100000,iteration:1});
 assert.equal(calls.filter(c=>c==='transaction').length,3);
});
