import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {AutonomousService} from '../src/autonomous-service.ts';
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';
import type {AutonomousSpec,AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
import {Scheduler} from '../src/scheduler.ts';
import {createSnapshot} from '../src/snapshot.ts';
import {nativeConfigurationFingerprint} from '../src/cloudflare/autonomous-ports.ts';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(specifier,context);}});
const day=86400000;
const snapshot=createSnapshot([]);
function spec(now:number,id='task'):AutonomousSpec{return {requestId:id,goal:'synthetic long task',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:now+56*day,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:1000}]}};}
async function fixture(flag?:string,transactional=true){
 const rows=new Map<string,unknown>();let alarm:number|null=null,sourceReads=0,runnerCalls=0;
 const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put<T>(key:string,value:T){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;},...(transactional?{async transaction<T>(fn:(tx:unknown)=>Promise<T>):Promise<T>{const before=structuredClone(rows);try{return await fn(storage);}catch(error){rows.clear();for(const [key,value] of before)rows.set(key,value);throw error;}}}:{})};
 const env={AUTONOMOUS_LONG_RUNNING_ENABLED:flag,AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:'fixture-storage',AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:{async get(){sourceReads++;return {async json(){return snapshot;}};}},RUNNER:{getByName(){runnerCalls++;throw Error('No runtime call is permitted in sleeping fixtures');}}};
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
 async function actor(){const pending:Promise<unknown>[]=[];const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};const a=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);return a;}
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture-credential',quarantined:false});await storage.put('state',scheduler.state);
 const service=new AutonomousService(storage as never);
 async function create(s=spec(Date.now())){return await service.execute('create',{spec:s}) as AutonomousTask;}
 async function approve(task:AutonomousTask){return (await actor()).fetch(new Request(`https://control.example/v1/autonomous-tasks/${task.id}/approve`,{method:'POST',headers:{authorization:'Bearer fixture-operator','content-type':'application/json'},body:JSON.stringify({revision:task.revision,reason:'synthetic fixture approval'})}));}
 return {rows,storage,env,actor,service,create,approve,get alarm(){return alarm;},clearAlarm(){alarm=null;},get sourceReads(){return sourceReads;},get runnerCalls(){return runnerCalls;}};
}
for(const flag of [undefined,'false','TRUE','1'])test(`long approval is default closed (${flag})`,async()=>{const f=await fixture(flag),task=await f.create();const response=await f.approve(task);assert.equal(response.status,503);assert.equal((await f.service.execute('get',{id:task.id}) as AutonomousTask).status,'awaiting_approval');assert.equal(f.sourceReads,0);});
test('transaction capable storage and explicit flag permit long approval',async()=>{const f=await fixture('true'),task=await f.create();const response=await f.approve(task);assert.equal(response.status,200,await response.text());});
test('native configuration fingerprint binds long enablement',()=>{const env={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:'fixture-storage',AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true'};assert.notEqual(nativeConfigurationFingerprint(env,'a'.repeat(64)),nativeConfigurationFingerprint({...env,...{AUTONOMOUS_LONG_RUNNING_ENABLED:'true'}},'a'.repeat(64)));});
test('legacy fake storage remains pilot compatible without transaction support',async()=>{const f=await fixture(undefined,false),s=spec(Date.now());delete s.execution!.mode;s.endsAt=Date.now()+500000;s.maxIterations=4;assert.equal((await f.approve(await f.create(s))).status,200);});
test('restored long task without flag cannot dispatch',async()=>{const f=await fixture(),task=await f.create();await f.service.execute('approve',{id:task.id,revision:1,reason:'previous approval'});await (await f.actor()).alarm();assert.equal((await f.service.execute('get',{id:task.id}) as AutonomousTask).iteration,0);assert.equal(f.runnerCalls,0);});
test('actor pagination replaces unbounded list and advances at most eight fairly across restarts',async()=>{const f=await fixture('true');const now=Date.now(),engine=new AutonomousEngine();for(let i=0;i<60;i++){const id=`task${i}`;engine.create({...spec(now,id),credentialIds:[id]},now,id);engine.approve(id,1,'approved',now+1);if(i%4===1||i%4===2){engine.claimCloud(id,'worker',`token${i}`,`run${i}`,now+2);if(i%4===2)engine.cancel(id,'stop',now+3);}}const state=engine.snapshot();for(let i=3;i<60;i+=4){state.tasks[`task${i}`]!.status='waiting';state.tasks[`task${i}`]!.nextRunAt=now+day;}await f.storage.put('autonomous-state',state);const visited:string[]=[],operations:string[]=[];for(let turn=0;turn<6;turn++){const actor=await f.actor();const service=(actor as unknown as {autonomy:AutonomousService}).autonomy,original=service.execute.bind(service);service.execute=async(op,input)=>{operations.push(op);assert.notEqual(op,'list');return original(op,input);};(actor as unknown as {cloudController:()=>unknown}).cloudController=()=>({async step(id:string){visited.push(id);}});const before=visited.length;await actor.alarm();assert.equal(visited.length-before,8);}assert.equal(new Set(visited).size,45);assert.ok(operations.filter(op=>op==='listPage').length>=12);});
test('25 hour synthetic sleep survives actor eviction and cancellation without a model',async(t)=>{
 const start=Date.now();t.mock.timers.enable({apis:['Date'],now:start});
 const f=await fixture('true'),task=await f.create(),wakeAt=start+25*60*60*1000;
 assert.equal((await f.approve(task)).status,200);
 const lease=await f.service.execute('claimCloud',{id:task.id,workerId:'worker',token:'private',runId:'first'}) as import('../../../packages/contracts/src/autonomous.ts').AutonomousLease;
 const usage={inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};
 await f.service.execute('nativeStart',{lease,runtimeId:'runtime'});
 await f.service.execute('recordNativeReceipt',{lease,receipt:{runId:'first',runtimeId:'runtime',sessionId:'session',model:'pinned',sequence:1,usage,stopped:true,outcome:'wait',wakeAt}});
 await f.service.execute('finishCloud',{lease,result:{outcome:'wait',costMicros:null,usage,wakeAt,checkpoint:{sessionId:'session',model:'pinned',objectKey:'private',sequence:1}},checksPassed:true});
 for(const hours of [0,24]){
  t.mock.timers.setTime(start+hours*60*60*1000);f.clearAlarm();
  await (await f.actor()).alarm();
  assert.equal(f.alarm,wakeAt);
  assert.equal(await f.storage.get('autonomous-cloud:'+task.id),undefined);
 }
 t.mock.timers.setTime(wakeAt);f.clearAlarm();
 await (await f.actor()).alarm();
 const intent=await f.storage.get<{phase:string;checkpoint:{sessionId:string}}>('autonomous-cloud:'+task.id);
 assert.equal(intent?.phase,'claiming');assert.equal(intent?.checkpoint.sessionId,'session');
 await f.service.execute('cancel',{id:task.id,reason:'cancel after wake'});
 f.clearAlarm();await (await f.actor()).alarm();
 assert.equal(f.alarm,null);assert.equal(f.runnerCalls,0);
 assert.equal((await f.service.execute('get',{id:task.id}) as AutonomousTask).status,'cancelled');
});
test('approval refuses a service without long storage capability even with flag enabled',async()=>{
 const f=await fixture('true'),task=await f.create(),actor=await f.actor();
 Object.defineProperty((actor as unknown as {autonomy:AutonomousService}).autonomy,'supportsLongRunning',{value:false});
 const response=await actor.fetch(new Request(`https://control.example/v1/autonomous-tasks/${task.id}/approve`,{method:'POST',headers:{authorization:'Bearer fixture-operator','content-type':'application/json'},body:JSON.stringify({revision:1,reason:'fixture'})}));
 assert.equal(response.status,503);assert.equal(f.sourceReads,0);
});
test('restored native long job stops before ensure or launch when flag is removed',async()=>{
 const f=await fixture(),task=await f.create();
 await f.service.execute('approve',{id:task.id,revision:1,reason:'previous approval'});
 const lease=await f.service.execute('claimCloud',{id:task.id,workerId:'worker',token:'private',runId:'run'}) as import('../../../packages/contracts/src/autonomous.ts').AutonomousLease;
 const scheduler=new Scheduler((await f.storage.get('state')) as import('../src/contracts.ts').SchedulerState);
 const job=scheduler.submit({provider:'claude',credentialId:'shared',snapshotId:snapshot.digest,instructions:'fixture',checks:task.spec.execution!.checks,timeoutMs:120000,idempotencyKey:'restored-long'},Date.now(),'restored-native');
 scheduler.state.jobs[job.id]!.autonomous={taskId:task.id,runId:lease.runId};
 scheduler.dispatch(Date.now());await f.storage.put('state',scheduler.state);
 await f.storage.put('autonomous-native:'+job.id,{task,lease,runtimeId:'runtime',sessionId:'session'});
 await f.storage.put('autonomous-cloud:'+task.id,{taskId:task.id,runId:lease.runId,workerId:lease.workerId,token:lease.token,jobId:job.id,phase:'polling',lease,snapshotId:snapshot.digest});
 let ensure=0,launch=0,stops=0;
 const runner={async ensure(){ensure++;throw Error('Forbidden ensure');},async launchNative(){launch++;},async stop(){stops++;return true;},async nativeLifecycle(){return {native:true,neverLaunched:false,containerStopped:true};}};
 Object.assign(f.env.RUNNER,{getByName(){return runner;}});
 await (await f.actor()).alarm();
 assert.equal(ensure,0);assert.equal(launch,0);assert.ok(stops>0);
 assert.notEqual((await f.service.execute('get',{id:task.id}) as AutonomousTask).status,'completed');
});
