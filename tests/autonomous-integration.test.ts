import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {buildApp} from '../apps/control-plane/src/app.js';

const operator='local-development-only',worker='local-worker-only';
const spec={requestId:'synthetic-24h',goal:'synthetic integration',provider:'mock',model:'mock',endsAt:86400001,budgetMicros:10,tools:['compute'],systems:['mock'],credentialIds:[],maxRunMs:1000,maxIterations:10};
const usage={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};
test('HTTP autonomy preserves one approval, virtual wait, restart and mandatory cleanup',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'autonomous-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=1;const options={dbPath:join(dir,'state.sqlite'),now:()=>now};let app=buildApp(options);
 t.after(async()=>{await app.close();});
 let url=await app.listen({host:'127.0.0.1',port:0});
 async function call(path='',body?:unknown,token=operator){
  const r=await fetch(url+'/v1/autonomous-tasks'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(r.ok,`${r.status}: ${await r.clone().text()}`);return r.json() as Promise<any>;
 }
 const task=await call('',spec);const id=task.id;
 assert.equal(await call(`/${id}/claim`,{workerId:'one'},worker),null);
 await call(`/${id}/approve`,{revision:task.revision,reason:'single approval'});
 let claimed=await call(`/${id}/claim`,{workerId:'one'},worker);
 await call(`/${id}/finish`,{lease:claimed.lease,result:{outcome:'wait',wakeAt:43200000,usage,costMicros:1,message:'synthetic virtual clock'}},worker);
 assert.equal(await call(`/${id}/claim`,{workerId:'two'},worker),null);
 await app.close();now=43200000;app=buildApp(options);url=await app.listen({host:'127.0.0.1',port:0});
 claimed=await call(`/${id}/claim`,{workerId:'restarted'},worker);assert.ok(claimed.lease);
 const action=await call(`/${id}/reserve`,{lease:claimed.lease,request:{requestId:'resource',tool:'compute',system:'mock',operation:'create',estimatedCostMicros:1}},worker);
 await call(`/${id}/settle`,{lease:claimed.lease,actionId:action.id,actualCostMicros:1,success:true,resource:{id:'synthetic-resource',system:'mock',cleanupOperation:'delete'}},worker);
 const finishing=await call(`/${id}/finish`,{lease:claimed.lease,result:{outcome:'complete',usage,costMicros:1}},worker);
 assert.equal(finishing.status,'stopping');
 await app.close();now=86400000;app=buildApp(options);url=await app.listen({host:'127.0.0.1',port:0});
 assert.equal((await call(`/${id}`)).status,'stopping');
 const cleaned=await call(`/${id}/cleaned`,{resourceId:'synthetic-resource'});assert.equal(cleaned.status,'completed');
 const publicState=JSON.stringify(await call(`/${id}`));assert.doesNotMatch(publicState,/local-worker-only|objectKey|"token"/);
 assert.equal((await app.inject({url:'/api/state',headers:{authorization:`Bearer ${worker}`}})).statusCode,401);
});

test('autonomy authenticates before malformed or oversized body parsing',async t=>{
 const app=buildApp();t.after(()=>app.close());
 for(const payload of ['{','x'.repeat(2000001)]){
  const denied=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:{authorization:'Bearer wrong','content-type':'application/json'},payload});
  assert.equal(denied.statusCode,401);
 }
 const denied=await app.inject({method:'POST',url:'/v1/autonomous-tasks/id/claim',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},payload:'{'});
 assert.equal(denied.statusCode,401);
});

test('HTTP runner uses synthetic private sessions across worker replacement and one approval',async t=>{
 const {runAutonomousMockDemo}=await import('../apps/worker/src/autonomous-mock.js');
 const app=buildApp();t.after(()=>app.close());
 const apiUrl=await app.listen({host:'127.0.0.1',port:0});
 const result=await runAutonomousMockDemo({apiUrl,operatorToken:operator,workerToken:worker});
 assert.equal(result.synthetic,true);assert.equal(result.iterations,2);
 const response=await app.inject({url:'/v1/autonomous-tasks/'+result.taskId,headers:{authorization:`Bearer ${operator}`}});
 assert.match(String(response.headers['content-type']),/application\/json/);
 const task=response.json();assert.equal(task.iteration,2);
 assert.equal(task.interventions.filter((x:{kind:string})=>x.kind==='approval').length,1);
 assert.equal(task.runs[1].usage.cacheReadTokens,1);
 assert.doesNotMatch(response.body,/private transcript|objectKey|local-worker-only/);
});

test('HTTP budget exhaustion stops claims until operator confirms cleanup',async t=>{
 const app=buildApp({now:()=>1});t.after(()=>app.close());
 async function call(path:string,body?:unknown,token=operator){
  const r=await app.inject({method:body===undefined?'GET':'POST',url:'/v1/autonomous-tasks'+path,headers:{authorization:`Bearer ${token}`},...(body===undefined?{}:{payload:body as Record<string,unknown>})});
  assert.ok(r.statusCode<300,r.body);return r.json();
 }
 const task=await call('',{...spec,budgetMicros:2});await call(`/${task.id}/approve`,{revision:task.revision,reason:'budget'});
 const {lease}=await call(`/${task.id}/claim`,{workerId:'one'},worker);
 const action=await call(`/${task.id}/reserve`,{lease,request:{requestId:'r',tool:'compute',system:'mock',operation:'create',estimatedCostMicros:1}},worker);
 await call(`/${task.id}/settle`,{lease,actionId:action.id,actualCostMicros:1,success:true,resource:{id:'resource',system:'mock',cleanupOperation:'delete'}},worker);
 const stopped=await call(`/${task.id}/finish`,{lease,result:{outcome:'continue',usage,costMicros:1}},worker);
 assert.equal(stopped.status,'stopping');
 assert.equal(await call(`/${task.id}/claim`,{workerId:'two'},worker),null);
 const denied=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${task.id}/cleaned`,headers:{authorization:`Bearer ${worker}`},payload:{resourceId:'resource'}});assert.equal(denied.statusCode,401);
 assert.equal((await call(`/${task.id}/cleaned`,{resourceId:'resource'})).status,'budget_exceeded');
});

test('help message and same-scope resume require operator authority without another approval',async t=>{
 const app=buildApp({now:()=>1});t.after(()=>app.close());
 const call=async(path:string,body?:unknown,token=operator)=>{
  const r=await app.inject({method:body===undefined?'GET':'POST',url:'/v1/autonomous-tasks'+path,headers:{authorization:`Bearer ${token}`},...(body===undefined?{}:{payload:body as Record<string,unknown>})});
  assert.ok(r.statusCode<300,r.body);return r.json();
 };
 const task=await call('',spec);await call(`/${task.id}/approve`,{revision:task.revision,reason:'approved scope'});
 const {lease}=await call(`/${task.id}/claim`,{workerId:'one'},worker);
 const help=await call(`/${task.id}/finish`,{lease,result:{outcome:'input',usage,costMicros:1,message:'Need operator advice'}},worker);
 assert.equal(help.status,'awaiting_input');
 await call(`/${task.id}/message`,{message:'Continue within the approved scope'});
 assert.equal((await call(`/${task.id}`)).status,'awaiting_input');
 assert.equal(await call(`/${task.id}/claim`,{workerId:'two'},worker),null);
 const resumed=await call(`/${task.id}/resume`,{revision:task.revision,reason:'Advice supplied'});
 assert.equal(resumed.status,'ready');assert.deepEqual(resumed.spec,task.spec);
 assert.equal(resumed.revision,task.revision);assert.equal(resumed.approvedAt,1);
 assert.deepEqual(resumed.counts,{humanInterventions:3,helpRequests:1,toolCalls:0});
 assert.ok((await call(`/${task.id}/claim`,{workerId:'two'},worker)).lease);
});

test('chunked unauthorized request receives rejection before the body ends',{timeout:5000},async t=>{
 const app=buildApp();t.after(()=>app.close());const url=await app.listen({host:'127.0.0.1',port:0});
 const status=await new Promise<number|undefined>((resolve,reject)=>{
  const req=httpRequest(url+'/v1/autonomous-tasks',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json','transfer-encoding':'chunked'}},response=>{resolve(response.statusCode);response.resume();req.destroy();});
  req.on('error',reject);req.setTimeout(1500,()=>req.destroy(new Error('auth waited for body')));
  req.write('{');
 });
 assert.equal(status,401);
});

test('npm autonomous:mock command completes against a real ephemeral local server',{timeout:15000},async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const app=buildApp();t.after(()=>app.close());const apiUrl=await app.listen({host:'127.0.0.1',port:0});
 const {stdout}=await promisify(execFile)('npm',['run','autonomous:mock'],{timeout:10000,maxBuffer:65536,env:{...process.env,HIVEMIND_API_URL:apiUrl,HIVEMIND_OPERATOR_TOKEN:operator,HIVEMIND_WORKER_TOKEN:worker}});
 assert.match(stdout,/"synthetic":true/);assert.match(stdout,/"iterations":2/);
});

test('HTTP run billing reconciliation preserves null report and needs explicit same-scope resume',async t=>{
 const app=buildApp({now:()=>1});t.after(()=>app.close());
 async function call(path:string,body:unknown,token=operator){const r=await app.inject({method:'POST',url:'/v1/autonomous-tasks'+path,headers:{authorization:`Bearer ${token}`},payload:body as Record<string,unknown>});assert.ok(r.statusCode<300,r.body);return r.json();}
 const task=await call('',spec);await call(`/${task.id}/approve`,{revision:task.revision,reason:'approved'});
 const {lease}=await call(`/${task.id}/claim`,{workerId:'one'},worker);
 const waiting=await call(`/${task.id}/finish`,{lease,result:{outcome:'continue',usage,costMicros:null}},worker);assert.equal(waiting.status,'awaiting_input');
 const reconciled=await call(`/${task.id}/reconcile-run`,{runId:lease.runId,actualCostMicros:2,reason:'synthetic receipt'});
 assert.equal(reconciled.runs[0].costMicros,null);assert.equal(reconciled.runs[0].reconciledCostMicros,2);assert.equal(reconciled.spentMicros,2);
 assert.equal(reconciled.status,'awaiting_input');
 assert.equal((await call(`/${task.id}/resume`,{revision:task.revision,reason:'billing resolved'})).status,'ready');
});

test('authorized autonomy parser errors never reflect input credentials',async t=>{
 const app=buildApp();t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:{authorization:`Bearer ${operator}`,'content-type':'application/json'},payload:'{"fixture-sensitive-credential" broken'});
 assert.equal(response.statusCode,400);assert.doesNotMatch(response.body,/fixture-sensitive-credential|JSON|position/);
});
