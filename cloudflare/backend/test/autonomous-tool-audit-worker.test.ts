import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {AutonomousService} from '../src/autonomous-service.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {AutonomousSpec,AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(specifier,context);}});
const snapshot=createSnapshot([]);
// Local SQL and a fake Durable Object context. No container, model or provider.
async function fixture(){
 const db=new DatabaseSync(':memory:'),rows=new Map<string,unknown>();let alarm:number|null=null;
 const sql={exec(query:string,...bindings:(string|number|null)[]){const st=db.prepare(query);const result=st.columns().length?st.all(...bindings):(st.run(...bindings),[]);return Object.assign(result,{toArray(){return [...result];}});}};
 const storage={sql,transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},async transaction<T>(fn:(tx:any)=>Promise<T>){const before=structuredClone(rows);try{return await fn(storage);}catch(e){rows.clear();for(const [k,v] of before)rows.set(k,v);throw e;}},async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const env:any={AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:'fixture-storage',AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:{async get(key:string){if(key==='snapshots/'+snapshot.digest+'.json')return {async json(){return snapshot;}};return null;}},CREDENTIALS:{async get(){return null;}},RUNNER:{getByName(){throw Error('forbidden');}}};
 const {SchedulerDO,default:worker}=await import('../src/cloudflare/worker.ts');let actor:InstanceType<typeof SchedulerDO>;
 const pending:Promise<unknown>[]=[],ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 actor=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);env.SCHEDULER={getByName(){return {fetch:(request:Request)=>actor.fetch(request)};}};
 const service=new AutonomousService(storage);
 const spec:AutonomousSpec={requestId:'audit-fixture',goal:'synthetic audit',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:Date.now()+500000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};
 const task=await service.execute('create',{spec}) as AutonomousTask;
 await service.execute('approve',{id:task.id,revision:1,reason:'fixture'});
 const lease=await service.execute('claimCloud',{id:task.id,workerId:'worker',token:'test-lease',runId:'run'}) as any;
 const call=(method:string,token:string,body?:unknown,suffix='tool-calls')=>worker.fetch(new Request('https://control.example/v1/autonomous-tasks/'+task.id+(suffix?'/'+suffix:''),{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env as never);
 return {db,task,lease,call,service};
}
const record=(sequence:number,over:object={})=>({sequence,tool:'Bash',inputDigest:'a'.repeat(64),inputSummary:'ls',inputTruncated:false,outcome:'allowed',startedAt:1000+sequence,durationMs:5,...over});
test('reporter posts tool calls with a valid lease; operator reads them; the task view carries workerToolCalls',async()=>{
 const f=await fixture();try{
  const posted=await f.call('POST','fixture-reporter',{lease:f.lease,records:[record(1),record(2,{outcome:'denied',durationMs:null})],droppedByWorker:0});
  assert.equal(posted.status,200);assert.deepEqual(await posted.json(),{recorded:true,nextSequence:3});
  const again=await f.call('POST','fixture-reporter',{lease:f.lease,records:[record(1),record(2,{outcome:'denied',durationMs:null})],droppedByWorker:0});assert.deepEqual(await again.json(),{recorded:true,nextSequence:3});
  const page=await (await f.call('GET','fixture-operator')).json() as any;
  assert.equal(page.source,'worker_report');assert.equal(page.items.length,2);assert.equal(page.totals.recorded,2);assert.equal(page.totals.denied,1);
  const view=await (await f.call('GET','fixture-operator',undefined,'')).json() as any;
  assert.equal(view.counts.workerToolCalls,2);assert.equal(view.counts.toolCalls,0,'broker action count stays separate');
 }finally{f.db.close();}
});
test('tool-calls authorization: wrong tokens and stale leases are refused',async()=>{
 const f=await fixture();try{
  const body={lease:f.lease,records:[record(1)],droppedByWorker:0};
  for(const token of ['fixture-worker','fixture-operator',''])assert.equal((await f.call('POST',token,body)).status,401);
  assert.equal((await f.call('GET','fixture-reporter')).status,401);assert.equal((await f.call('GET','fixture-worker')).status,401);
  assert.equal((await f.call('POST','fixture-reporter',{...body,lease:{...f.lease,token:'stale'}})).status,409);
  assert.equal((await f.call('POST','fixture-reporter',{...body,records:[record(5)]})).status,409);
 }finally{f.db.close();}
});
test('workerToolCalls is absent from stored state and only overlaid at the view',async()=>{
 const f=await fixture();try{
  await f.call('POST','fixture-reporter',{lease:f.lease,records:[record(1)],droppedByWorker:0});
  const stored=await f.service.execute('get',{id:f.task.id}) as AutonomousTask;assert.equal(stored.counts?.workerToolCalls,undefined);
  const list=await (await f.call('GET','fixture-operator',undefined,'')).json() as any;assert.equal(list.counts.workerToolCalls,1);
 }finally{f.db.close();}
});
