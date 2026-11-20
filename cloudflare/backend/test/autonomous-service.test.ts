import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAutonomousRoute,isAutonomousPath} from '../src/cloudflare/api.ts';
const request=(path:string,token:string,method='POST')=>new Request('https://example.test'+path,{method,headers:{authorization:`Bearer ${token}`}});
test('autonomy authentication selects only the exact route role and fails closed',()=>{
 assert.equal(isAutonomousPath('/v1/autonomous-tasks'),true);
 assert.equal(isAutonomousPath('/v1/autonomous-tasks/task/claim'),true);
 assert.equal(isAutonomousPath('/v1/autonomous-tasks-extra'),false);
 for(const action of ['claim','heartbeat','finish','reserve','settle']){
  assert.equal(authorizeAutonomousRoute(request(`/v1/autonomous-tasks/task/${action}`,'worker'),'operator','worker'),null);
  assert.equal(authorizeAutonomousRoute(request(`/v1/autonomous-tasks/task/${action}`,'operator'),'operator','worker')?.status,401);
 }
 for(const path of ['/v1/autonomous-tasks','/v1/autonomous-tasks/task','/v1/autonomous-tasks/task/approve','/v1/autonomous-tasks/task/cleaned']){
  assert.equal(authorizeAutonomousRoute(request(path,'worker'),'operator','worker')?.status,401);
  assert.equal(authorizeAutonomousRoute(request(path,'operator'),'operator','worker'),null);
 }
 assert.equal(authorizeAutonomousRoute(request('/v1/autonomous-tasks/task/claim','operator'),'operator',undefined)?.status,503);
 assert.equal(authorizeAutonomousRoute(request('/v1/autonomous-tasks/task/claim','operator'),'operator','operator')?.status,503);
});

test('long waits schedule transitions without polling or stale deadline loops',async()=>{
 const {scheduleAutonomousAlarm}=await import('../src/cloudflare/api.ts');
 let alarm:number|null=null;
 const storage={async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const end=8*7*86400000;
 const task={status:'waiting',spec:{endsAt:end},nextRunAt:end-1000};
 await scheduleAutonomousAlarm(storage,[task],100);assert.equal(alarm,end-1000);
 alarm=2100;await scheduleAutonomousAlarm(storage,[task],100);assert.equal(alarm,2100);
 for(const status of ['ready','awaiting_approval','awaiting_input']){
  alarm=null;await scheduleAutonomousAlarm(storage,[{...task,status,nextRunAt:50}],100);assert.equal(alarm,end);
 }
 alarm=null;await scheduleAutonomousAlarm(storage,[{...task,status:'running',lease:{expiresAt:500}}],100);assert.equal(alarm,500);
 alarm=null;await scheduleAutonomousAlarm(storage,[{...task,status:'stopping',lease:{expiresAt:500}}],100);assert.equal(alarm,500);
 alarm=null;await scheduleAutonomousAlarm(storage,[{...task,status:'completed'}],100);assert.equal(alarm,null);
 alarm=null;await scheduleAutonomousAlarm(storage,[{...task,status:'stopping',spec:{endsAt:50},nextRunAt:50}],100);assert.equal(alarm,null);
});

test('DO service state stays separate, restores waits and ticks only at transition',async()=>{
 const {AutonomousService}=await import('../src/autonomous-service.ts');
 const data=new Map<string,unknown>([['state',{existingScheduler:true}]]);
 const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put<T>(key:string,value:T){data.set(key,structuredClone(value));}};
 let now=1;let service=new AutonomousService(storage,()=>now);
 const spec={requestId:'do-wait',goal:'synthetic',provider:'mock',model:'mock',endsAt:86400001,budgetMicros:10,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3};
 const task=await service.execute('create',{spec}) as {id:string;revision:number};
 await service.execute('approve',{id:task.id,revision:task.revision,reason:'synthetic'});
 const claim=await service.execute('claim',{id:task.id,workerId:'one'}) as {lease:unknown};
 await service.execute('finish',{lease:claim.lease,result:{outcome:'wait',wakeAt:86400000,costMicros:1,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1}}});
 service=new AutonomousService(storage,()=>now);await service.tick();
 assert.equal((await service.execute('get',{id:task.id}) as {status:string}).status,'waiting');
 now=86400000;await service.tick();
 assert.equal((await service.execute('get',{id:task.id}) as {status:string}).status,'ready');
 assert.deepEqual(data.get('state'),{existingScheduler:true});
 assert.ok(data.has('autonomous-state'));
});

test('Worker and DO enforce role auth, retain separate state and never enqueue autonomous model jobs',async()=>{
 const {registerHooks}=await import('node:module');
 registerHooks({resolve(specifier,context,nextResolve){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return nextResolve(specifier,context);}});
 const {default:worker,SchedulerDO}=await import('../src/cloudflare/worker.ts');
 const data=new Map<string,unknown>();let alarm:number|null=null;const pending:Promise<unknown>[]=[];let modelCalls=0;
 const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put(key:string,value:unknown){data.set(key,structuredClone(value));},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 let owner:any;
 const env={CONTROL_TOKEN:'operator',AUTONOMOUS_WORKER_TOKEN:'worker',SCHEDULER:{getByName(){return {fetch:(r:Request)=>owner.fetch(r)};}},RUNNER:{getByName(){modelCalls++;throw Error('autonomous model must not be scheduled');}}};
 owner=new SchedulerDO(ctx as any,env as any);await Promise.all(pending);
 const request=(path:string,body?:unknown,token='operator')=>new Request('https://test'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 for(const fetcher of [(r:Request)=>worker.fetch(r,env as any),(r:Request)=>owner.fetch(r)]){
  assert.equal((await fetcher(request('/v1/jobs',undefined,'worker'))).status,401);
  assert.equal((await fetcher(new Request('https://test/v1/autonomous-tasks/id/claim',{method:'POST',headers:{authorization:'Bearer operator'},body:'{'}))).status,401);
 }
 const now=Date.now(),end=now+8*7*86400000,wake=end-1000;
 const created=await worker.fetch(request('/v1/autonomous-tasks',{requestId:'cf-integration',goal:'synthetic',provider:'mock',model:'mock',endsAt:end,budgetMicros:10,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3}),env as any);
 assert.equal(created.status,201);const task=await created.json() as any;
 assert.equal(alarm,end);
 const call=async(suffix:string,body:unknown,token='operator')=>{
  const r=await worker.fetch(request(`/v1/autonomous-tasks/${task.id}/${suffix}`,body,token),env as any);assert.ok(r.ok,await r.clone().text());return await r.json() as any;
 };
 await call('approve',{revision:task.revision,reason:'mock'});
 const {lease}=await call('claim',{workerId:'one'},'worker');
 await call('finish',{lease,result:{outcome:'wait',wakeAt:wake,costMicros:1,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1}}},'worker');
 alarm=null;await owner.alarm();assert.equal(alarm,wake);
 assert.equal(modelCalls,0);assert.deepEqual(owner.scheduler.list(),[]);
 assert.ok(data.has('autonomous-state'));assert.equal((data.get('state') as any).jobs[task.id],undefined);
});
