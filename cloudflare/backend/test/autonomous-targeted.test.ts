import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousService} from '../src/autonomous-service.ts';
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';
import type {AutonomousSpec,AutonomousTask,AutonomousLease} from '../../../packages/contracts/src/autonomous.ts';

class Storage {
 data=new Map<string,unknown>();reads:string[]=[];writes:string[]=[];failAt=Infinity;
 async get<T>(key:string){this.reads.push(key);return structuredClone(this.data.get(key)) as T|undefined;}
 async put<T>(key:string,value:T){this.writes.push(key);if(this.writes.length===this.failAt)throw Error('write failed');this.data.set(key,structuredClone(value));}
 async delete(key:string){return this.data.delete(key);}
 async transaction<T>(fn:(tx:Storage)=>Promise<T>){const before=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=before;throw e;}}
 reset(){this.reads=[];this.writes=[];this.failAt=Infinity;}
 chunks(){return new Set(this.reads.filter(k=>k.startsWith('autonomous:chunk:')).map(k=>k.split(':')[2]!));}
}
const spec=(requestId:string,patch:Partial<AutonomousSpec>={}):AutonomousSpec=>({requestId,goal:'work',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:['read'],systems:['test'],credentialIds:[],maxRunMs:1000,maxIterations:10,...patch});
async function fixture(count=4,patch:Partial<AutonomousSpec>={}){
 const storage=new Storage(),e=new AutonomousEngine();let now=1000;
 for(let i=0;i<count;i++)e.create(spec('r'+i,patch),now,'t'+i);
 const legacy=e.snapshot();await storage.put('autonomous-state',legacy);
 const service=()=>new AutonomousService(storage,()=>now);
 await service().execute('listPage',{});storage.reset();
 return {storage,service,legacy,time(value:number){now=value;}};
}
test('get and workerState only decode their target; unchanged reads never write',async()=>{
 const f=await fixture();
 await f.service().execute('get',{id:'t1'});assert.deepEqual([...f.storage.chunks()],['t1']);assert.equal(f.storage.writes.length,0);
 f.storage.reset();await f.service().execute('workerState',{id:'t2'});assert.deepEqual([...f.storage.chunks()],['t2']);assert.equal(f.storage.writes.length,0);
});
test('target mutation merges catalog and leaves all other records and request indexes intact',async()=>{
 const f=await fixture(),other=structuredClone(f.storage.data.get('autonomous:task:t3'));
 await f.service().execute('message',{id:'t1',message:'changed'});assert.deepEqual([...f.storage.chunks()],['t1']);
 assert.deepEqual(f.storage.data.get('autonomous:task:t3'),other);
 const catalog=f.storage.data.get('autonomous:catalog') as {ids:string[];bytes:number};assert.equal(catalog.ids.length,4);
 assert.equal(catalog.bytes,catalog.ids.reduce((n,id)=>n+(f.storage.data.get('autonomous:task:'+id) as {bytes:number}).bytes,0));
 for(let i=0;i<4;i++)assert.equal((f.storage.data.get('autonomous:request:r'+i) as {id:string}).id,'t'+i);
 assert.equal((await f.service().execute('list',{}) as AutonomousTask[]).length,4);
});
test('claim loads all sharing blocked owners, ignores unrelated history, retains expired quarantine',async()=>{
 const f=await fixture(3,{provider:'claude',credentialIds:['shared']});
 await f.service().execute('revise',{id:'t2',spec:spec('r2',{provider:'claude',credentialIds:['other']}),reason:'separate'});
 for(const id of ['t0','t1','t2'])await f.service().execute('approve',{id,revision:id==='t2'?2:1,reason:'yes'});
 const owner=await f.service().execute('claim',{id:'t0',workerId:'w0'}) as {lease:AutonomousLease};
 await f.service().execute('claim',{id:'t2',workerId:'w2'});
 f.time(owner.lease.expiresAt);f.storage.reset();
 assert.equal(await f.service().execute('claim',{id:'t1',workerId:'w1'}),null);
 assert.deepEqual([...f.storage.chunks()].sort(),['t0','t1']);
 assert.equal((await f.service().execute('get',{id:'t0'}) as AutonomousTask).status,'awaiting_input');
 await f.service().execute('reconcileRun',{id:'t0',runId:owner.lease.runId,actualCostMicros:0,reason:'stopped proof'});
 assert.ok(await f.service().execute('claim',{id:'t1',workerId:'w1'}));
});
test('claimCloud shares global credential arbitration with an ordinary native owner',async()=>{
 const f=await fixture(1,{provider:'claude',credentialIds:['shared']});await f.service().execute('approve',{id:'t0',revision:1,reason:'yes'});await f.service().execute('claim',{id:'t0',workerId:'w'});
 const cloud=await f.service().execute('create',{spec:spec('cloud',{provider:'claude',credentialIds:['shared'],tools:['Bash'],systems:[],model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'c',argv:['node'],timeoutMs:1000}]}})}) as AutonomousTask;
 await f.service().execute('approve',{id:cloud.id,revision:1,reason:'yes'});f.storage.reset();
 assert.equal(await f.service().execute('claimCloud',{id:cloud.id,workerId:'w2',token:'private',runId:'r'}),null);
 assert.deepEqual([...f.storage.chunks()].sort(),['t0',cloud.id].sort());
});
test('tick decodes at most 25 due records per call, survives restart, then becomes a no-write noop',async()=>{
 const f=await fixture(61,{endsAt:2000});f.time(2000);const visited=new Set<string>();
 for(const expected of [25,25,11]){f.storage.reset();await f.service().tick();assert.equal(f.storage.chunks().size,expected);for(const id of f.storage.chunks())visited.add(id);}
 assert.equal(visited.size,61);f.storage.reset();await f.service().tick();assert.equal(f.storage.chunks().size,0);assert.equal(f.storage.writes.length,0);
});
test('listPage ticks only due displayed records, with stable highwater and no hidden history reads',async()=>{
 const f=await fixture(10,{endsAt:2000});f.time(2000);
 const first=await f.service().execute('listPage',{limit:3}) as {items:AutonomousTask[];nextCursor:string};
 assert.deepEqual([...f.storage.chunks()],['t0','t1','t2']);assert.ok(first.items.every(t=>t.status==='expired'));
 f.storage.reset();const second=await f.service().execute('listPage',{limit:3,cursor:first.nextCursor}) as {items:AutonomousTask[]};
 assert.deepEqual([...f.storage.chunks()],['t3','t4','t5']);assert.ok(second.items.every(t=>t.status==='expired'));
 f.storage.reset();await assert.rejects(f.service().execute('listPage',{cursor:'tampered'}));assert.equal(f.storage.writes.length,0);assert.equal(f.storage.chunks().size,0);
});
test('v2 upgrade rebuilds lost request indexes from summaries without reading unrelated chunks',async()=>{
 const f=await fixture();const catalog=f.storage.data.get('autonomous:catalog') as Record<string,unknown>;delete catalog.requestIndexVersion;
 for(const key of f.storage.data.keys())if(key.startsWith('autonomous:request:'))f.storage.data.delete(key);
 f.storage.reset();const prior=await f.service().execute('create',{spec:spec('r2')}) as AutonomousTask;
 assert.equal(prior.id,'t2');assert.deepEqual([...f.storage.chunks()],['t2']);
 for(let i=0;i<4;i++)assert.equal((f.storage.data.get('autonomous:request:r'+i) as {id:string}).id,'t'+i);
 f.storage.reset();await assert.rejects(f.service().execute('create',{spec:spec('r2',{goal:'different'})}),{statusCode:409});assert.equal(f.storage.writes.length,0);
 assert.equal((await f.service().execute('list',{}) as AutonomousTask[]).length,4);
});
test('new request creates without decoding old histories; global ID collision rejects atomically',async(t)=>{
 const f=await fixture();const created=await f.service().execute('create',{spec:spec('new')}) as AutonomousTask;assert.equal(f.storage.chunks().size,0);
 assert.equal((f.storage.data.get('autonomous:catalog') as {ids:string[]}).ids.length,5);
 t.mock.method(crypto,'randomUUID',()=>created.id);
 const before=structuredClone(f.storage.data);await assert.rejects(f.service().execute('create',{spec:spec('collision')}),{statusCode:409});assert.deepEqual(f.storage.data,before);
});
test('create enforces global task count but request replay still works at capacity',async()=>{
 const f=await fixture(1000);f.storage.reset();await assert.rejects(f.service().execute('create',{spec:spec('overflow')}));assert.equal(f.storage.chunks().size,0);
 const prior=await f.service().execute('create',{spec:spec('r999')}) as AutonomousTask;assert.equal(prior.id,'t999');assert.deepEqual([...f.storage.chunks()],['t999']);
});
test('target transition write failure preserves manifest, owner, catalog and legacy state',async()=>{
 const f=await fixture(4,{endsAt:2000});f.time(2000);const before=structuredClone(f.storage.data);f.storage.failAt=2;
 await assert.rejects(f.service().execute('get',{id:'t1'}));assert.deepEqual(f.storage.data,before);
 f.storage.reset();assert.equal((await f.service().execute('get',{id:'t1'}) as AutonomousTask).status,'expired');assert.deepEqual([...f.storage.chunks()],['t1']);
});
test('no-due tick and empty catalog page are no-write operations after initialization',async()=>{
 const f=await fixture(0);await f.service().tick();await f.service().execute('listPage',{});assert.equal(f.storage.writes.length,0);assert.equal(f.storage.chunks().size,0);
});
test('persistent cursor visits later tasks even while expired unresolved owners remain due',async()=>{
 const f=await fixture(60,{provider:'claude',credentialIds:['shared'],endsAt:2000});
 const e=new AutonomousEngine(f.legacy),state=e.snapshot();
 for(const t of Object.values(state.tasks)){
  t.status='awaiting_input';t.approvedAt=1000;t.iteration=1;
  t.interventions.push({kind:'approval',message:'approved',at:1000,revision:1});
  t.runs.push({runId:'lost-'+t.id,workerId:'w',startedAt:1000,finishedAt:1001,outcome:'failed',costMicros:null,usageUnavailable:true,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}});
 }
 f.storage.data.clear();await f.storage.put('autonomous-state',state);await f.service().execute('listPage',{});f.time(2000);
 const visited=new Set<string>();
 for(let turn=0;turn<3;turn++){f.storage.reset();await f.service().tick();assert.equal(f.storage.chunks().size,25);for(const id of f.storage.chunks())visited.add(id);}
 assert.equal(visited.size,60);assert.equal((f.storage.data.get('autonomous:catalog') as {tickCursor:number}).tickCursor,15);
});
test('request index upgrade rolls back on failure and retries without losing historical identity',async()=>{
 const f=await fixture();const catalog=f.storage.data.get('autonomous:catalog') as Record<string,unknown>;delete catalog.requestIndexVersion;
 for(const key of f.storage.data.keys())if(key.startsWith('autonomous:request:'))f.storage.data.delete(key);
 const before=structuredClone(f.storage.data);f.storage.failAt=2;
 await assert.rejects(f.service().execute('listPage',{}));assert.deepEqual(f.storage.data,before);
 f.storage.reset();await f.service().execute('listPage',{});assert.equal(f.storage.chunks().size,0);
 const replay=await f.service().execute('create',{spec:spec('r3')}) as AutonomousTask;assert.equal(replay.id,'t3');
});
test('missing credential owner index fails closed before a competing claim',async()=>{
 const f=await fixture(2,{provider:'claude',credentialIds:['shared']});for(const id of ['t0','t1'])await f.service().execute('approve',{id,revision:1,reason:'yes'});
 await f.service().execute('claim',{id:'t0',workerId:'w'});f.storage.data.delete('autonomous:credential-owner:t0');
 const before=structuredClone(f.storage.data);await assert.rejects(f.service().execute('claim',{id:'t1',workerId:'other'}),{statusCode:503});assert.deepEqual(f.storage.data,before);
});
test('intentional scope denial commits only the target without dropping unloaded records',async()=>{
 const f=await fixture();await f.service().execute('approve',{id:'t0',revision:1,reason:'yes'});
 const claim=await f.service().execute('claim',{id:'t0',workerId:'w'}) as {lease:AutonomousLease};f.storage.reset();
 await assert.rejects(f.service().execute('reserve',{lease:claim.lease,request:{requestId:'outside',tool:'no',system:'test',operation:'read',estimatedCostMicros:0}}));
 assert.deepEqual([...f.storage.chunks()],['t0']);
 assert.equal((await f.service().execute('get',{id:'t0'}) as AutonomousTask).status,'awaiting_input');assert.equal((await f.service().execute('list',{}) as AutonomousTask[]).length,4);
});
test('aggregate 30MiB admission and 32MiB recovery remain atomic with target-only writes',async()=>{
 const storage=new Storage(),e=new AutonomousEngine();for(let i=0;i<2;i++)e.create(spec('large'+i),1000,'large'+i);
 const state=e.snapshot();for(const t of Object.values(state.tasks))t.interventions=Array.from({length:990},()=>({kind:'message',message:'x'.repeat(16000),at:1000,revision:1}));
 await storage.put('autonomous-state',state);let service=new AutonomousService(storage,()=>1000);
 await service.execute('listPage',{});const catalog=storage.data.get('autonomous:catalog') as {bytes:number};
 assert.ok(catalog.bytes>30*1024*1024&&catalog.bytes<32*1024*1024);
 const before=structuredClone(storage.data);storage.reset();
 await assert.rejects(service.execute('message',{id:'large0',message:'normal growth'}),{statusCode:413});assert.deepEqual(storage.data,before);assert.deepEqual([...storage.chunks()],['large0']);
 storage.reset();service=new AutonomousService(storage,()=>1000);
 assert.equal((await service.execute('cancel',{id:'large0',reason:'recovery'}) as AutonomousTask).status,'cancelled');assert.deepEqual([...storage.chunks()],['large0']);
 assert.equal((await service.execute('get',{id:'large1'}) as AutonomousTask).interventions.length,990);
});
test('claim decodes every sharing historical unknown owner, not merely the first',async()=>{
 const f=await fixture(4,{provider:'claude',credentialIds:['shared']}),state=structuredClone(f.legacy);
 for(const id of ['t0','t1']){
  const t=state.tasks[id]!;t.approvedAt=1000;t.status='awaiting_input';t.iteration=1;
  t.interventions.push({kind:'approval',message:'yes',at:1000,revision:1});
  t.runs.push({runId:'lost-'+id,workerId:'w',startedAt:1000,finishedAt:1001,outcome:'failed',costMicros:null,usageUnavailable:true,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}});
 }
 f.storage.data.clear();await f.storage.put('autonomous-state',state);await f.service().execute('listPage',{});
 await f.service().execute('approve',{id:'t2',revision:1,reason:'yes'});f.storage.reset();
 assert.equal(await f.service().execute('claim',{id:'t2',workerId:'other'}),null);assert.deepEqual([...f.storage.chunks()].sort(),['t0','t1','t2']);
});
