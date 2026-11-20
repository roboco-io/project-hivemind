import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {Scheduler} from '../src/scheduler.ts';
import {createSchedulerStorage} from '../src/scheduler-storage.ts';
registerHooks({resolve(s,c,next){if(s==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(s,c);}});
async function fixture(){
 const rows=new Map<string,unknown>();let alarm:number|null=null;const storage={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(v:number){alarm=v;},async transaction<T>(fn:(tx:any)=>Promise<T>){const before=structuredClone(rows);try{return await fn(storage);}catch(e){rows.clear();for(const [k,v]of before)rows.set(k,v);throw e;}}};
 const scheduler=new Scheduler(undefined,{exclusiveOwnership:true}),goal='goal '.repeat(3200);scheduler.registerCredential({id:'credential',provider:'claude',generation:7,objectKey:'fixture',quarantined:false});
 for(let i=0;i<170;i++){scheduler.submit({provider:'claude',credentialId:'credential',snapshotId:'a'.repeat(64),instructions:goal,checks:[{id:'check',argv:['node','secret-argv'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'job'+i},1000,'job'+i);Object.assign(scheduler.state.jobs['job'+i]!,{status:'SUCCEEDED',authSynced:true,finishedAt:2000});}
 scheduler.submit({provider:'claude',credentialId:'credential',snapshotId:'a'.repeat(64),instructions:goal,checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'active'},Date.now(),'active');scheduler.dispatch(Date.now());
 const repository=createSchedulerStorage(storage);await repository.load();await repository.save(scheduler.state);
 const {SchedulerDO,default:worker}=await import('../src/cloudflare/worker.ts');let actor:InstanceType<typeof SchedulerDO>;
 const env={CONTROL_TOKEN:'operator',SCHEDULER:{getByName(){return {fetch:(r:Request)=>actor.fetch(r)};}},RUNNER:{getByName(){assert.fail('No model invocation');}},ARTIFACTS:{},CREDENTIALS:{}};
 async function restart(){const pending:Promise<unknown>[]=[];actor=new SchedulerDO({storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}} as never,env as never);await Promise.all(pending);return actor;}
 await restart();return {rows,storage,repository,restart,get actor(){return actor;},call:(query='',token='operator',path='/v1/jobs')=>worker.fetch(new Request('https://control.example'+path+query,{headers:{authorization:'Bearer '+token}}),env as never)};
}
test('large default jobs GET rejects before unpooled list materialization and summary pages retain every ID once',async()=>{
 const f=await fixture();(f.actor as any).scheduler.list=()=>assert.fail('Full list was materialized');
 const children=Array.from({length:50000},()=> 'job0');Object.defineProperty(children,'toJSON',{value(){assert.fail('Summary serialized childIds');}});(f.actor as any).scheduler.state.jobs.active.childIds=children;
 const denied=await f.call();assert.equal(denied.status,413);assert.equal((await denied.json() as any).error,'PAGE_REQUIRED');
 const ids:string[]=[];let cursor:string|undefined,active:any;
 for(let i=0;i<20;i++){const response=await f.call('?view=summary&limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(response.status,200);const page=await response.json() as any;assert.ok(page.items.length<=20);assert.ok(Buffer.byteLength(JSON.stringify(page))<2*1024*1024);assert.doesNotMatch(JSON.stringify(page),/instructions|secret-argv|"checks"|"argv"|"childIds"/);for(const row of page.items){ids.push(row.id);if(row.id==='active')active=row;}cursor=page.nextCursor;if(!cursor)break;}
 assert.equal(ids.length,171);assert.equal(new Set(ids).size,171);assert.equal(active.credentialGeneration,7);assert.equal(active.credentialOwned,true);assert.equal(active.childCount,50000);assert.equal(active.checkCount,1);
 const job=await f.call('', 'operator','/v1/jobs/active');assert.equal(job.status,200);assert.equal(typeof (await job.json() as any).instructions,'string');
});
test('summary cursor survives actor restart, freezes highwater and rejects tamper after authentication',async()=>{
 const f=await fixture(),first=await (await f.call('?limit=1&view=summary')).json() as any;assert.ok(first.nextCursor);const scheduler=(f.actor as any).scheduler as Scheduler;
 scheduler.submit({provider:'claude',credentialId:'credential',snapshotId:'a'.repeat(64),instructions:'new task',checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'new'},1000,'0');await (f.actor as any).save();await f.restart();
 const ids:string[]=[first.items[0].id];let cursor=first.nextCursor;
 while(cursor){const response=await f.call('?limit=100&view=summary&cursor='+encodeURIComponent(cursor));assert.equal(response.status,200);const page=await response.json() as any;ids.push(...page.items.map((j:any)=>j.id));cursor=page.nextCursor;}
 assert.equal(ids.length,171);assert.ok(!ids.includes('0'));
 for(const q of ['?limit=0','?limit=101','?limit=1&limit=2','?view=full','?extra=1','?cursor=','?cursor='+first.nextCursor+'x']){assert.equal((await f.call(q,'wrong')).status,401);assert.equal((await f.call(q)).status,400,q);}
});
