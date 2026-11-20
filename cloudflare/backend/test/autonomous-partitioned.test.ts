import assert from 'node:assert/strict';
import test from 'node:test';
import {AutonomousService} from '../src/autonomous-service.ts';
class Storage {
 data=new Map<string,unknown>(); failAt=Infinity; writes=0;
 async get<T>(key:string){return structuredClone(this.data.get(key)) as T|undefined;}
 async put<T>(key:string,value:T){if(++this.writes===this.failAt)throw Error('injected');this.data.set(key,structuredClone(value));}
 async delete(key:string){return this.data.delete(key);}
 async transaction<T>(fn:(s:Storage)=>Promise<T>):Promise<T>{const before=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=before;throw e;}}
}
const spec={requestId:'r',goal:'goal',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:['fetch'],systems:['test'],credentialIds:[],maxRunMs:1000,maxIterations:4};
test('transaction storage publishes individual task manifests rather than legacy snapshot',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);
 await service.execute('create',{spec});
 assert.equal(storage.data.has('autonomous-state'),false);
 assert.ok([...storage.data.keys()].some(k=>k.startsWith('autonomous:task:')));
 assert.equal((await new AutonomousService(storage,()=>1000).execute('list',{}) as unknown[]).length,1);
});
test('failed multi-key writes roll back all manifests and indexes',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);await service.execute('create',{spec});const before=structuredClone(storage.data);
 storage.failAt=storage.writes+2;await assert.rejects(service.execute('create',{spec:{...spec,requestId:'r2'}}));assert.deepEqual(storage.data,before);
});
test('legacy migration keeps original and page summaries avoid private history',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');const engine=new AutonomousEngine();engine.create(spec as never,1000,'legacy');
 const storage=new Storage();await storage.put('autonomous-state',engine.snapshot());const service=new AutonomousService(storage,()=>1000);
 const page=await service.execute('listPage',{}) as {items:Record<string,unknown>[]};assert.equal(page.items[0]?.id,'legacy');assert.equal(page.items[0]?.runs,undefined);assert.ok(storage.data.has('autonomous-state'));assert.ok(storage.data.has('autonomous:catalog'));
});
import {encodeAutonomousRecord,decodeAutonomousRecord,pageAutonomousTasks,summarizeAutonomousTask} from '../../../packages/core/src/autonomous-repository.ts';
test('codec canonical base64 UTF8 chunks hash and byte validation',()=>{
 const value={text:'한글🙂'.repeat(40000)},record=encodeAutonomousRecord(value);assert.deepEqual(decodeAutonomousRecord(record),value);assert.ok(record.chunks.every(c=>Buffer.byteLength(c)<=128*1024));assert.ok(record.chunks.length>1);
 for(const bad of [{...record,digest:'0'.repeat(64)},{...record,bytes:record.bytes-1},{...record,chunks:[record.chunks[0]+'\n',...record.chunks.slice(1)]},{...record,chunks:record.chunks.slice(1)}])assert.throws(()=>decodeAutonomousRecord(bad));
 assert.throws(()=>encodeAutonomousRecord('x'.repeat(32*1024*1024)),{statusCode:413});
});
test('HMAC pages hold insertion watermark and accept metadata-only summaries',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);
 const a=await service.execute('create',{spec}) as never;const b=await service.execute('create',{spec:{...spec,requestId:'b'}}) as never;
 const entries=[{sequence:1,task:summarizeAutonomousTask(a)},{sequence:2,task:summarizeAutonomousTask(b)}],secret='s'.repeat(64);
 const first=pageAutonomousTasks(entries,{limit:1},secret);assert.ok(first.nextCursor);assert.equal(first.items.length,1);
 const next=pageAutonomousTasks([...entries,{sequence:3,task:summarizeAutonomousTask(a)}],{limit:1,cursor:first.nextCursor},secret);assert.equal(next.items.length,1);assert.equal(next.nextCursor,undefined);
 assert.throws(()=>pageAutonomousTasks(entries,{cursor:first.nextCursor},'t'.repeat(64)),{statusCode:400});
 for(const query of [{limit:0},{limit:101},{cursor:'bad'},{cursor:first.nextCursor+'x'}])assert.throws(()=>pageAutonomousTasks(entries,query,secret));
 assert.equal('runs' in first.items[0]!,false);
});
test('committed scope denial survives restart and cancelled lease cannot claim again',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);const t=await service.execute('create',{spec}) as {id:string};
 await service.execute('approve',{id:t.id,revision:1,reason:'yes'});const c=await service.execute('claim',{id:t.id,workerId:'w'}) as {lease:unknown};
 await assert.rejects(service.execute('reserve',{id:t.id,lease:c.lease,request:{requestId:'a',tool:'no',system:'test',operation:'read',estimatedCostMicros:1}}));
 const restored=new AutonomousService(storage,()=>1000);assert.equal((await restored.execute('get',{id:t.id}) as {status:string}).status,'awaiting_input');await restored.execute('cancel',{id:t.id,reason:'stop'});assert.equal(await restored.execute('claim',{id:t.id,workerId:'other'}),null);
});
test('migration crash leaves legacy authoritative and retryable',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');const e=new AutonomousEngine();e.create(spec as never,1000,'legacy');const storage=new Storage();await storage.put('autonomous-state',e.snapshot());const before=structuredClone(storage.data);storage.failAt=storage.writes+2;
 await assert.rejects(new AutonomousService(storage,()=>1000).execute('listPage',{}));assert.deepEqual(storage.data,before);storage.failAt=Infinity;assert.equal((await new AutonomousService(storage,()=>1000).execute('list',{}) as unknown[]).length,1);
});
test('legacy fallback keeps pilot limits and advertises no long-running support',async()=>{
 const storage=new Storage();const legacy={get:storage.get.bind(storage),put:storage.put.bind(storage)};const service=new AutonomousService(legacy,()=>1000);assert.equal(service.supportsLongRunning,false);assert.equal(new AutonomousService(storage).supportsLongRunning,true);
 await assert.rejects(service.execute('create',{spec:{...spec,execution:{mode:'long_running'}}}),{statusCode:503});await service.execute('create',{spec});assert.ok(storage.data.has('autonomous-state'));
});
test('due page commits deadline transitions and failed transition writes roll back',async()=>{
 const storage=new Storage();let now=1000;const service=new AutonomousService(storage,()=>now);const t=await service.execute('create',{spec:{...spec,endsAt:2000}}) as {id:string};const before=structuredClone(storage.data);now=2000;storage.failAt=storage.writes+1;
 await assert.rejects(service.execute('listPage',{}));assert.deepEqual(storage.data,before);storage.failAt=Infinity;
 const page=await service.execute('listPage',{}) as {items:{status:string}[]};assert.equal(page.items[0]?.status,'expired');
 assert.equal((await new AutonomousService(storage,()=>now).execute('get',{id:t.id}) as {status:string}).status,'expired');
});
test('get persists a due transition while unchanged reads do not write',async()=>{
 const storage=new Storage();let now=1000;const service=new AutonomousService(storage,()=>now);const t=await service.execute('create',{spec:{...spec,endsAt:2000}}) as {id:string};
 const before=storage.writes;await service.execute('get',{id:t.id});await service.execute('listPage',{});assert.equal(storage.writes,before);
 now=2000;await service.execute('get',{id:t.id});assert.ok(storage.writes>before);
});
test('codec rejects null query limits rather than treating them as defaults',()=>{
 assert.throws(()=>pageAutonomousTasks([],{limit:null} as never,'s'.repeat(64)),{statusCode:400});
});
test('credential owners across separate partitions block conflicting concurrent claims',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);const ids:string[]=[];
 for(const requestId of ['a','b']){const t=await service.execute('create',{spec:{...spec,provider:'claude',credentialIds:['shared'],requestId}}) as {id:string};ids.push(t.id);await service.execute('approve',{id:t.id,revision:1,reason:'yes'});}
 const results=await Promise.all(ids.map(id=>service.execute('claim',{id,workerId:id})));assert.equal(results.filter(Boolean).length,1);
 const winner=ids[results.findIndex(Boolean)]!;await service.execute('cancel',{id:winner,reason:'stop'});assert.equal(await new AutonomousService(storage,()=>1000).execute('claim',{id:ids.find(id=>id!==winner),workerId:'other'}),null);
});
test('1000 legacy task migration retains every task and insertion sequence',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');const e=new AutonomousEngine();for(let i=0;i<1000;i++)e.create({...spec,requestId:'r'+i} as never,1000,'t'+i);
 const storage=new Storage();await storage.put('autonomous-state',e.snapshot());const service=new AutonomousService(storage,()=>1000);const page=await service.execute('listPage',{limit:100}) as {items:unknown[]};assert.equal(page.items.length,100);assert.equal((await service.execute('list',{}) as unknown[]).length,1000);
});
test('aggregate hot bound rejects multiple individually small legacy tasks without publishing migration',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');const e=new AutonomousEngine();for(let i=0;i<4;i++)e.create({...spec,requestId:'r'+i} as never,1000,'t'+i);const state=e.snapshot();
 for(const task of Object.values(state.tasks))task.interventions=Array.from({length:600},()=>({kind:'message' as const,message:'x'.repeat(16000),at:1000,revision:1}));
 const storage=new Storage();await storage.put('autonomous-state',state);await assert.rejects(new AutonomousService(storage,()=>1000).execute('listPage',{}),{statusCode:413});assert.equal(storage.data.has('autonomous:catalog'),false);assert.equal(storage.data.size,1);
});
test('page reads metadata without decoding or fetching unchanged task histories',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);await service.execute('create',{spec});const original=storage.get.bind(storage);storage.get=async function<T>(key:string){if(key.startsWith('autonomous:chunk:'))throw Error('history fetched');return original<T>(key);};
 assert.equal((await service.execute('listPage',{}) as {items:unknown[]}).items.length,1);
});
test('pilot fallback supports stable pages for the bounded alarm consumer',async()=>{
 const storage=new Storage(),legacy={get:storage.get.bind(storage),put:storage.put.bind(storage)},service=new AutonomousService(legacy,()=>1000);await service.execute('create',{spec});
 assert.equal((await service.execute('listPage',{}) as {items:unknown[]}).items.length,1);assert.ok(storage.data.has('autonomous-state'));
});
test('capability downgrade fails closed for partitioned state and prevents conflicting credential claims',async()=>{
 const storage=new Storage(),service=new AutonomousService(storage,()=>1000);
 const cloudSpec={...spec,requestId:'active-long',provider:'claude',model:'pinned',tools:['Bash'],systems:[],credentialIds:['shared'],billingPolicy:{model:'subscription',budget:'external_actions'},maxIterations:5,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:10000}]}};
 const task=await service.execute('create',{spec:cloudSpec}) as {id:string};
 await service.execute('approve',{id:task.id,revision:1,reason:'approved'});
 assert.ok(await service.execute('claimCloud',{id:task.id,workerId:'owner',token:'test-only',runId:'active-run'}));
 const before=structuredClone(storage.data);
 const fallback=new AutonomousService({get:storage.get.bind(storage),put:storage.put.bind(storage)},()=>1000);
 assert.equal(fallback.supportsLongRunning,false);
 const {execution:_execution,...pilot}=cloudSpec;
 for(const [operation,input] of [
  ['list',{}],['listPage',{}],['get',{id:task.id}],
  ['create',{spec:{...pilot,requestId:'conflicting-pilot',maxIterations:1}}],
  ['claim',{id:task.id,workerId:'other'}],['tick',{}],
 ] as const){
  await assert.rejects(fallback.execute(operation,input),{statusCode:503},operation);
  assert.deepEqual(storage.data,before);
 }
 assert.equal(storage.data.has('autonomous-state'),false);
 assert.equal(await service.execute('claimCloud',{id:task.id,workerId:'other',token:'another-test',runId:'another-run'}),null);
});
