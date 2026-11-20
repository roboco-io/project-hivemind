import assert from 'node:assert/strict';
import test from 'node:test';
import {Scheduler} from '../src/scheduler.ts';
const modulePath='../src/scheduler-storage.ts';
class Storage {
 rows=new Map<string,unknown>();writes=0;failAt=Infinity;
 async get<T>(key:string){return structuredClone(this.rows.get(key)) as T|undefined;}
 async put(key:string,value:unknown){if(++this.writes===this.failAt)throw Error('injected storage failure');if(key.startsWith('scheduler:chunk:'))assert.ok(Buffer.byteLength(String(value))<=128*1024);this.rows.set(key,structuredClone(value));}
 async delete(key:string){return this.rows.delete(key);}
 async transaction<T>(fn:(tx:Storage)=>Promise<T>){const before=structuredClone(this.rows);try{return await fn(this);}catch(error){this.rows=before;throw error;}}
}
function history(count=160){
 const scheduler=new Scheduler();scheduler.registerCredential({id:'credential',provider:'claude',generation:1,objectKey:'credentials/g1',quarantined:false});
 const goal='x'.repeat(16000),spec=(i:number)=>({provider:'claude' as const,credentialId:'credential',snapshotId:'a'.repeat(64),instructions:goal,checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'key'+i});
 for(let i=0;i<count;i++){
  const now=1000+i*10,job=scheduler.submit(spec(i),now,'job'+i);scheduler.dispatch(now+1);scheduler.agentFinished(job.id,job.attempt,{success:true,containerStopped:true,authGeneration:i+2,authObjectKey:'credentials/g'+(i+2),outputSnapshotId:'b'.repeat(64)},now+2);
  const checks=scheduler.dispatch(now+3);for(const check of checks)scheduler.computeFinished(check.id,check.attempt,{success:true,containerStopped:true,sourceUnchanged:true},now+4);
 }
 const active=scheduler.submit(spec(count),10000,'active');scheduler.dispatch(10001);
 const state=scheduler.state;state.workflows={fixture:{id:'fixture',status:'SUCCEEDED',jobIds:['job0'],snapshotId:'a'.repeat(64)}} as never;state.computeGroups={fixture:{id:'fixture',status:'SUCCEEDED',jobs:['job0']}} as never;
 return {scheduler,state,active,spec};
}
test('pooled state over 2MiB roundtrips all history, graph, idempotency and active credential ownership',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),f=history(),before=JSON.stringify(f.state);assert.ok(Buffer.byteLength(before)>2*1024*1024);
 const repository=createSchedulerStorage(storage);await repository.load();
 Object.defineProperty(f.state,'toJSON',{configurable:true,value(){assert.fail('Full unpooled state must never be serialized');}});
 await repository.save(f.state,{recovery:false});delete (f.state as any).toJSON;
 const manifest=storage.rows.get('scheduler:manifest') as any;assert.ok(manifest.bytes<Buffer.byteLength(before)/5);assert.equal(storage.rows.has('state'),false);
 const restored=await loadSchedulerState(storage);assert.deepEqual(restored,f.state);assert.equal(JSON.stringify(f.state),before);
 const scheduler=new Scheduler(restored);assert.equal(scheduler.state.credentials.credential!.activeJobId,'active');assert.equal(scheduler.state.credentials.credential!.generation,161);
 assert.equal(scheduler.submit(f.spec(0),20000,'job0').id,'job0');assert.throws(()=>scheduler.registerCredential({id:'credential',provider:'claude',generation:162,objectKey:'credentials/new',quarantined:false}));
});
test('legacy migration is atomic, retains old bytes immutable and a failed publish can retry',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),f=history(1);await storage.put('state',f.state);const legacy=structuredClone(storage.rows.get('state')),before=structuredClone(storage.rows);storage.failAt=storage.writes+2;
 await assert.rejects(createSchedulerStorage(storage).load(),/injected/);assert.deepEqual(storage.rows,before);storage.failAt=Infinity;
 const repository=createSchedulerStorage(storage),restored=await repository.load();assert.deepEqual(restored,f.state);assert.deepEqual(storage.rows.get('state'),legacy);
 restored.jobs.active!.status='CANCELLING';restored.jobs.active!.cancellationRequested=true;await repository.save(restored,{recovery:true});assert.deepEqual(storage.rows.get('state'),legacy);assert.equal((await loadSchedulerState(storage)).jobs.active.status,'CANCELLING');
});
test('failed replacement rolls back every chunk and refuses corrupt snapshots without legacy fallback',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),repository=createSchedulerStorage(storage),f=history(1);await repository.load();await repository.save(f.state);const before=structuredClone(storage.rows);
 f.state.jobs.active!.instructions='y'.repeat(200000);storage.failAt=storage.writes+2;await assert.rejects(repository.save(f.state,{recovery:true}),/injected/);assert.deepEqual(storage.rows,before);storage.failAt=Infinity;
 const key=[...storage.rows.keys()].find(k=>k.startsWith('scheduler:chunk:'))!;storage.rows.set(key,'corrupt');await storage.put('state',history(0).state);await assert.rejects(loadSchedulerState(storage));
});
test('capability downgrade never resurrects stale legacy jobs and fresh legacy fallback has the old 2MiB bound',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),f=history(1);await storage.put('state',f.state);const repository=createSchedulerStorage(storage);await repository.load();f.state.credentials.credential!.generation=999;f.state.jobs.active!.credentialGeneration=999;await repository.save(f.state,{recovery:true});
 const fallback={get:storage.get.bind(storage),put:storage.put.bind(storage)};await assert.rejects(loadSchedulerState(fallback),(e:any)=>e.statusCode===503);await assert.rejects(createSchedulerStorage(fallback).save(f.state),(e:any)=>e.statusCode===503);
 const fresh=new Storage(),legacy={get:fresh.get.bind(fresh),put:fresh.put.bind(fresh)},compatible=createSchedulerStorage(legacy);await compatible.load();await compatible.save(history(1).state);assert.ok(fresh.rows.has('state'));
 const growing=new Scheduler(await loadSchedulerState(legacy),{exclusiveOwnership:true});for(let i=0;i<160;i++)growing.submit({...f.spec(i+100),idempotencyKey:'growing'+i},20000);await assert.rejects(compatible.save(growing.state),(e:any)=>e.statusCode===503);assert.equal((await loadSchedulerState(legacy)).credentials.credential.generation,2);
});
test('Scheduler default constructor remains defensive while fresh decoded state supports exclusive adoption',()=>{
 const state=history(0).state,normal=new Scheduler(state);assert.notEqual(normal.state,state);normal.state.credentials.credential!.objectKey='changed';assert.notEqual(state.credentials.credential!.objectKey,'changed');
 const fresh=structuredClone(state),exclusive=new Scheduler(fresh,{exclusiveOwnership:true});assert.equal(exclusive.state,fresh);const job=exclusive.get('active');job.checks[0]!.argv[0]='mutated';assert.equal(exclusive.state.jobs.active!.checks[0]!.argv[0],'node');const listed=exclusive.list();listed[0]!.instructions='changed';listed[0]!.checks[0]!.argv[0]='changed';assert.notEqual(exclusive.state.jobs.active!.instructions,'changed');assert.equal(exclusive.state.jobs.active!.checks[0]!.argv[0],'node');
});
test('instruction references are strict and cannot escape their string pool even with a recomputed digest',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),{decodeAutonomousRecord,encodeAutonomousRecord}=await import('../../../packages/core/src/autonomous-repository.ts'),storage=new Storage(),repository=createSchedulerStorage(storage),f=history(0);await repository.load();await repository.save(f.state);
 const original=structuredClone(storage.rows),m=storage.rows.get('scheduler:manifest') as any;
 const envelope=decodeAutonomousRecord({bytes:m.bytes,digest:m.digest,chunks:Array.from({length:m.chunks},(_,i)=>storage.rows.get('scheduler:chunk:'+m.generation+':'+i) as string)}) as any;
 for(const ref of [{pool:999},{pool:-1},{pool:0,extra:true},'raw unpooled instructions']){
  storage.rows=structuredClone(original);envelope.state.jobs.active.instructions=ref;const record=encodeAutonomousRecord(envelope);storage.rows.set('scheduler:manifest',{...m,bytes:record.bytes,digest:record.digest,chunks:record.chunks.length});for(let i=0;i<record.chunks.length;i++)storage.rows.set('scheduler:chunk:'+m.generation+':'+i,record.chunks[i]);await assert.rejects(loadSchedulerState(storage));
 }
});
test('recovery headroom cannot admit new root work and hard overflow leaves the last generation intact',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),repository=createSchedulerStorage(storage),f=history(0);await repository.load();await repository.save(f.state);
 // Synthetic terminal evidence: unique text cannot be pooled away; no provider/model runs.
 const large={...f.state,carbonCampaigns:{history:{payload:'x'.repeat(31*1024*1024)}}} as any;
 await assert.rejects(repository.save(large), (e:any)=>e.statusCode===413);
 // The history is new root work until first admitted below the normal bound.
 const small={...f.state,carbonCampaigns:{history:{payload:'small'}}} as any;await repository.save(small);
 await repository.save(large,{recovery:true});const current=structuredClone(storage.rows);
 const added={...large,jobs:{...large.jobs,newroot:{...large.jobs.active,id:'newroot',status:'QUEUED',containerStopped:true}}};await assert.rejects(repository.save(added,{recovery:true}),(e:any)=>e.statusCode===413);assert.deepEqual(storage.rows,current);
 const overflow={...large,carbonCampaigns:{history:{payload:'x'.repeat(32*1024*1024)}}};await assert.rejects(repository.save(overflow,{recovery:true}),(e:any)=>e.statusCode===413);assert.deepEqual(storage.rows,current);
 assert.equal((await loadSchedulerState(storage)).credentials.credential.activeJobId,'active');
});
test('3952 repeated-goal jobs save reload and list under a bounded local heap without an unpooled buffer',async(t)=>{
 const {spawnSync}=await import('node:child_process');
 const source=`
 import {Scheduler} from ${JSON.stringify(new URL('../src/scheduler.ts',import.meta.url).href)};
 import {createSchedulerStorage} from ${JSON.stringify(new URL('../src/scheduler-storage.ts',import.meta.url).href)};
 const rows=new Map(),port={async get(k){return rows.get(k);},async put(k,v){rows.set(k,v);},async delete(k){return rows.delete(k);},async transaction(fn){return fn(port);}};
 let s=new Scheduler(undefined,{exclusiveOwnership:true});s.registerCredential({id:'cred',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});const goal='x'.repeat(16000),count=3952;
 for(let i=0;i<count;i++){s.submit({provider:'claude',credentialId:'cred',snapshotId:'a'.repeat(64),instructions:Buffer.from(goal).toString(),checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'key'+i},1000,'job'+i);Object.assign(s.state.jobs['job'+i],{status:'SUCCEEDED',authSynced:true,finishedAt:2000});}
 globalThis.gc();let liveList=s.list();const liveHeap=process.memoryUsage().heapUsed;if(liveHeap>48*1024*1024)throw Error('Unpooled live owner heap '+liveHeap);liveList=null;
 const repository=createSchedulerStorage(port);await repository.load();await repository.save(s.state);s=null;globalThis.gc();const restored=await repository.load(),scheduler=new Scheduler(restored,{exclusiveOwnership:true});globalThis.gc();const listed=scheduler.list();const heap=process.memoryUsage().heapUsed;
 if(listed.length!==count||listed.at(-1).instructions!==goal)throw Error('history lost');
 console.log(JSON.stringify({liveHeap,jobs:listed.length,encodedBytes:rows.get('scheduler:manifest').bytes,unpooledMinimum:count*goal.length,heap}));
 `;
 const child=spawnSync(process.execPath,['--max-old-space-size=96','--expose-gc','--input-type=module','-e',source],{encoding:'utf8',timeout:30000});assert.equal(child.status,0,child.stderr.slice(-1600));const stats=JSON.parse(child.stdout.trim());assert.equal(stats.jobs,3952);assert.ok(stats.encodedBytes<stats.unpooledMinimum/10);assert.ok(stats.heap<48*1024*1024,JSON.stringify(stats));t.diagnostic('LOCAL_NODE_HEAP_FIXTURE '+JSON.stringify(stats));
});
test('a stale storage handle cannot overwrite committed auth generation or its verification graph',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),initial=createSchedulerStorage(storage),f=history(0);await initial.load();await initial.save(f.state);
 const left=createSchedulerStorage(storage),right=createSchedulerStorage(storage),a=await left.load(),b=await right.load(),scheduler=new Scheduler(a,{exclusiveOwnership:true}),active=scheduler.get('active');
 scheduler.agentFinished(active.id,active.attempt,{success:true,containerStopped:true,authGeneration:2,authObjectKey:'credentials/g2',outputSnapshotId:'b'.repeat(64)},10002);await left.save(scheduler.state,{recovery:true});
 await assert.rejects(right.save(b,{recovery:true}),(e:any)=>e.statusCode===409);const restored=await loadSchedulerState(storage);assert.equal(restored.credentials.credential.generation,2);assert.equal(restored.credentials.credential.activeJobId,undefined);assert.equal(restored.jobs.active.status,'VERIFYING');assert.equal(restored.jobs.active.childIds.length,1);
});
test('saving a clipped state cannot delete previously persisted jobs or their idempotency history',async()=>{
 const {createSchedulerStorage,loadSchedulerState}=await import(modulePath),storage=new Storage(),repository=createSchedulerStorage(storage),f=history(0);await repository.load();await repository.save(f.state);const clipped={...f.state,jobs:{},idempotency:{},credentials:{credential:{...f.state.credentials.credential,activeJobId:undefined}}};
 await assert.rejects(repository.save(clipped,{recovery:true}));assert.equal((await loadSchedulerState(storage)).jobs.active.id,'active');
});
