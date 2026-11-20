import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {AutonomousEngine} from '../packages/core/src/autonomous.js';
import { createAutonomousStore } from '../packages/core/src/autonomous-store.js';
import { createAutonomousApiService, handleAutonomousApi } from '../apps/control-plane/src/autonomous-api.js';
import type { AutonomousSpec } from '../packages/contracts/src/autonomous.js';
const spec:AutonomousSpec={requestId:'request',goal:'goal',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'autonomous-page-'));const path=join(dir,'state.sqlite');return {path,cleanup:()=>rmSync(dir,{recursive:true,force:true})};}
// Reflect keeps the red test compilable before the store exposes the new method.
function page(store:ReturnType<typeof createAutonomousStore>,input:Record<string,unknown>={}) {return Reflect.get(store,'listPage')(input) as {items:{id:string;status:string}[];nextCursor?:string};}
test('SQLite pages freeze insertion highwater across same timestamp, reopen and independent handles',()=>{
 const f=fixture();let a=createAutonomousStore(f.path);const b=createAutonomousStore(f.path);
 try{
  a.create(spec,1000,'z');a.create({...spec,requestId:'second'},1000,'a');
  const first=page(a,{limit:1});assert.deepEqual(first.items.map(t=>t.id),['z']);assert.ok(first.nextCursor);
  b.create({...spec,requestId:'third'},1000,'0');a.close();a=createAutonomousStore(f.path);
  const second=page(a,{limit:1,cursor:first.nextCursor});assert.deepEqual(second.items.map(t=>t.id),['a']);assert.equal(second.nextCursor,undefined);
  assert.equal(page(a).items.length,3);assert.equal(a.list().length,3);
 }finally{a.close();b.close();f.cleanup();}
});
test('page summaries exclude histories and private references; cursor tampering and cross-store use fail',()=>{
 const a=createAutonomousStore(':memory:'),b=createAutonomousStore(':memory:');
 try{
  for(const s of [a,b]){s.create(spec,1000,'one');s.create({...spec,requestId:'two'},1000,'two');}
  a.approve('one',1,'approved',1000);const lease=a.claim('one','worker','private-token','run',1000)!;
  a.finish(lease,{outcome:'continue',costMicros:0,usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},checkpoint:{sessionId:'private-session',objectKey:'private-object',model:'mock',sequence:1}},1001);
  const result=page(a,{limit:1});assert.doesNotMatch(JSON.stringify(result.items),/private|checkpoint|runs|interventions|native/);
  assert.ok(result.nextCursor);assert.throws(()=>page(b,{cursor:result.nextCursor}));
  const cursor=result.nextCursor!;assert.throws(()=>page(a,{cursor:cursor.slice(0,-1)+(cursor.endsWith('A')?'B':'A')}));
  for(const input of [{limit:0},{limit:101},{limit:1.5},{cursor:''},{cursor:'x'.repeat(4097)},{unknown:1}])assert.throws(()=>page(a,input));
 }finally{a.close();b.close();}
});
test('HTTP pagination authenticates first, validates strict queries and preserves legacy arrays',async()=>{
 const store=createAutonomousStore(':memory:');store.create(spec,1000,'one');store.create({...spec,requestId:'two'},1000,'two');
 const options={operatorToken:'operator',workerToken:'worker',service:createAutonomousApiService(store,()=>1000)};
 const get=(query:string,token='operator')=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks'+query,{headers:{authorization:'Bearer '+token}}),options);
 try{
  assert.ok(Array.isArray(await (await get('')).json()));
  const response=await get('?limit=1');assert.equal(response.status,200);const first=await response.json();assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  assert.equal((await (await get('?cursor='+encodeURIComponent(first.nextCursor))).json()).items.length,1);
  for(const q of ['?limit=0','?limit=101','?limit=1&limit=2','?unknown=1','?cursor=','?limit=01','?limit=1.5','?limit=+1','?cursor='+ 'x'.repeat(4097)]){
   assert.equal((await get(q,'worker')).status,401);assert.equal((await get(q)).status,400,q);
  }
  assert.equal((await get('?limit=1&cursor=invalid')).status,400);
  assert.equal((await get('/one?limit=1')).status,400);
 }finally{store.close();}
});
test('SQLite migrates legacy JSON without deleting it and rolls back failed chunk writes',()=>{
 const f=fixture();const seed=createAutonomousStore(':memory:');seed.create(spec,1000,'one');const state=seed.snapshot();seed.close();
 const raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify(state));
 const store=createAutonomousStore(f.path);
 try{
  assert.deepEqual(page(store).items.map(t=>t.id),['one']);
  assert.equal(JSON.parse(String(raw.prepare('SELECT data FROM autonomous_state').get()!.data)).tasks.one.id,'one');
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='autonomous_chunks'").get());
  raw.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON autonomous_chunks BEGIN SELECT RAISE(ABORT,'chunk failure'); END");
  assert.throws(()=>store.approve('one',1,'approved',1000),/chunk failure/);
  raw.exec('DROP TRIGGER reject_chunk');assert.equal(store.get('one').status,'awaiting_approval');
  assert.equal(store.approve('one',1,'retry',1000).status,'ready');
 }finally{store.close();raw.close();f.cleanup();}
});
test('HTTP summary reflects policy expiration in the same transaction',async()=>{
 const store=createAutonomousStore(':memory:');store.create(spec,1000,'one');
 try{
  const response=await handleAutonomousApi(new Request('http://local/v1/autonomous-tasks?limit=1',{headers:{authorization:'Bearer operator'}}),{operatorToken:'operator',workerToken:'worker',service:createAutonomousApiService(store,()=>100001)});
  assert.equal(response.status,200);assert.equal((await response.json()).items[0].status,'expired');assert.equal(store.get('one').status,'expired');
 }finally{store.close();}
});
test('failed legacy migration keeps the original authoritative and retries atomically',()=>{
 const f=fixture();const seed=createAutonomousStore(':memory:');seed.create(spec,1000,'one');const json=JSON.stringify(seed.snapshot());seed.close();
 const raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(json);
 const store=createAutonomousStore(f.path);
 try{
  raw.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON autonomous_chunks BEGIN SELECT RAISE(ABORT,'migration failure'); END");
  assert.throws(()=>page(store),/migration failure/);assert.equal(raw.prepare('SELECT data FROM autonomous_state').get()!.data,json);
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM autonomous_tasks').get()!.count,0);
  raw.exec('DROP TRIGGER reject_migration');assert.equal(page(store).items[0]!.id,'one');
 }finally{store.close();raw.close();f.cleanup();}
});
test('SQLite partitions and reopens multi-megabyte long history without truncating any run',()=>{
 const f=fixture(),seed=createAutonomousStore(':memory:');
 const long:AutonomousSpec={...spec,tools:['Bash'],credentialIds:['credential'],provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:56*86400000,maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:10000}]}};
 seed.create(long,0,'one');seed.approve('one',1,'approved',1);const state=seed.snapshot(),task=state.tasks.one!;seed.close();
 task.iteration=1001;task.runs=Array.from({length:1001},(_,i)=>({runId:'run'+i,workerId:'worker',startedAt:2+i,finishedAt:3+i,outcome:'failed',costMicros:0,message:'가'.repeat(1000),usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}}));
 const raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify(state));let store=createAutonomousStore(f.path);
 try{
  assert.equal(page(store).items.length,1);assert.equal(store.get('one').runs.length,1001);
  const chunks=raw.prepare('SELECT data FROM autonomous_chunks').all();assert.ok(chunks.length>20);assert.ok(chunks.every(c=>Buffer.byteLength(String(c.data))<=128*1024));
  store.close();store=createAutonomousStore(f.path);const restored=store.get('one');assert.equal(restored.runs[0]!.runId,'run0');assert.equal(restored.runs[1000]!.runId,'run1000');assert.equal(restored.runs[1000]!.message,'가'.repeat(1000));
  assert.doesNotMatch(JSON.stringify(page(store)),/run1000|가/);
 }finally{store.close();raw.close();f.cleanup();}
});
test('HTTP strict execution whitelist accepts long_running and rejects extra nested fields before dispatch',async()=>{
 const calls:unknown[]=[];
 const options={operatorToken:'operator',workerToken:'worker',service:{async execute(_operation:unknown,input:unknown){calls.push(input);return input;}}};
 const execution:NonNullable<AutonomousSpec['execution']>={backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:10000}]};
 // A cloud fixture must satisfy both HTTP capability checks and central core policy.
 const cloud:AutonomousSpec={...spec,provider:'claude',model:'pinned',tools:['Bash'],credentialIds:['credential'],billingPolicy:{model:'subscription',budget:'external_actions'},execution};
 assert.doesNotThrow(()=>new AutonomousEngine().create(cloud,0,'valid-cloud-policy'));
 const post=(e:unknown,patch:Partial<AutonomousSpec>={})=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks',{method:'POST',headers:{authorization:'Bearer operator'},body:JSON.stringify({...cloud,...patch,execution:e})}),options);
 const accepted=await post(execution);assert.equal(accepted.status,201,await accepted.text());assert.equal(calls.length,1);
 for(const e of [{...execution,mode:'invalid'},{...execution,private:true},{...execution,checks:[{...execution.checks[0],private:true}]}])assert.equal((await post(e)).status,400);
 // Preserve rejection before dispatch when required tools or matching capability scope are missing.
 for(const tools of [[],['Bash','WebFetch'],['Bash','mcp__hivemind__action']]){
  const denied=await post(execution,{tools});assert.equal(denied.status,400);assert.deepEqual(await denied.json(),{error:'Invalid autonomous request'});
 }
 assert.equal(calls.length,1);
});
test('SQLite reserves 30..32MiB for recovery while rejecting normal growth atomically',()=>{
 const f=fixture(),seed=createAutonomousStore(':memory:');
 seed.create({...spec,provider:'claude',model:'pinned',tools:['Bash'],credentialIds:['credential'],billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:56*86400000,maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:10000}]}},0,'one');seed.approve('one',1,'approved',1);
 const state=seed.snapshot(),task=state.tasks.one!;seed.close();task.iteration=1100;
 task.runs=Array.from({length:1100},(_,i)=>({runId:'run'+i,workerId:'worker',startedAt:2+i,finishedAt:3+i,outcome:'failed',costMicros:0,message:'가'.repeat(9700),usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}}));
 const raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify(state));const store=createAutonomousStore(f.path);
 try{
  assert.equal(page(store).items.length,1);
  assert.throws(()=>store.message('one','normal growth',2000),e=>(e as {statusCode?:number}).statusCode===413);
  assert.equal(store.get('one').interventions.length,1);
  assert.equal(store.cancel('one','recovery cancellation',2001).status,'cancelled');assert.equal(store.get('one').runs.length,1100);
 }finally{store.close();raw.close();f.cleanup();}
});
test('HTTP schedule accepts only the daily schedule fields before dispatch',async()=>{
 let calls=0;
 const options={operatorToken:'operator',workerToken:'worker',service:{async execute(){calls++;return {};}}};
 const post=(schedule:unknown)=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks',{method:'POST',headers:{authorization:'Bearer operator'},body:JSON.stringify({...spec,schedule})}),options);
 assert.equal((await post({kind:'daily',timeZone:'Asia/Seoul',localTime:'09:00'})).status,201);
 for(const schedule of [{kind:'daily',timeZone:'Asia/Seoul',localTime:'09:00',extra:true},{kind:'daily',timeZone:1,localTime:'09:00'},{kind:'daily',timeZone:'Asia/Seoul'},{kind:'weekly',timeZone:'Asia/Seoul',localTime:'09:00'}])assert.equal((await post(schedule)).status,400);
 assert.equal(calls,1);
});
test('SQLite rejects aggregate manifest overflow before decoding any task chunks',()=>{
 const f=fixture(),store=createAutonomousStore(f.path),raw=new DatabaseSync(f.path);
 try{
  store.create(spec,1000,'one');store.create({...spec,requestId:'two'},1000,'two');
  raw.exec("UPDATE autonomous_tasks SET bytes=17*1024*1024; UPDATE autonomous_chunks SET data='corrupt'");
  assert.throws(()=>store.list(),e=>(e as {statusCode?:number}).statusCode===413);
 }finally{store.close();raw.close();f.cleanup();}
});
test('SQLite checks oversized legacy bytes before attempting JSON parsing',()=>{
 const f=fixture(),raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run('invalid'.padEnd(32*1024*1024+1,'x'));
 const store=createAutonomousStore(f.path);
 try{assert.throws(()=>store.list(),e=>(e as {statusCode?:number}).statusCode===413);assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM autonomous_tasks').get()!.n,0);}
 finally{store.close();raw.close();f.cleanup();}
});
test('SQLite normal aggregate budget is 30MiB while recovery retains up to 32MiB',()=>{
 const f=fixture(),seed=createAutonomousStore(':memory:');
 const long:AutonomousSpec={...spec,provider:'claude',model:'pinned',tools:['Bash'],credentialIds:['credential'],billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:56*86400000,maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:10000}]}};
 seed.create(long,0,'one');seed.create({...long,requestId:'second'},0,'two');seed.approve('one',1,'approved',1);seed.approve('two',1,'approved',1);const state=seed.snapshot();seed.close();
 for(const task of Object.values(state.tasks)){task.iteration=550;task.runs=Array.from({length:550},(_,i)=>({runId:'run'+i,workerId:'worker',startedAt:2+i,finishedAt:3+i,outcome:'failed',costMicros:0,message:'가'.repeat(9700),usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}}));}
 const raw=new DatabaseSync(f.path);raw.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');raw.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify(state));const store=createAutonomousStore(f.path);
 try{assert.equal(page(store).items.length,2);assert.throws(()=>store.message('one','normal growth',2000),e=>(e as {statusCode?:number}).statusCode===413);assert.equal(store.cancel('one','recovery',2001).status,'cancelled');assert.equal(store.get('two').runs.length,550);}
 finally{store.close();raw.close();f.cleanup();}
});
