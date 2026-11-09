import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/control-plane/src/app.js';
import { runOnce } from '../apps/worker/src/worker.js';
import type { Task, Lease, State } from '../packages/contracts/src/index.js';
const operator = {authorization:'Bearer local-development-only'};
const worker = {authorization:'Bearer local-worker-only'};
const input = {title:'프로젝트 관제',instructions:'모의 실행 확인',budgetMicros:5000,provider:'mock',runtime:'local'};

test('unauthenticated and worker clients cannot approve or inspect operator state', async t => {
  const app = buildApp(); t.after(()=>app.close());
  assert.equal((await app.inject('/health')).statusCode,200);
  assert.equal((await app.inject('/api/state')).statusCode,401);
  assert.equal((await app.inject({url:'/api/state',headers:worker})).statusCode,401);
  const created = await app.inject({method:'POST',url:'/api/tasks',headers:operator,payload:input});
  assert.equal(created.statusCode,201); const task = created.json<Task>();
  const forbidden = await app.inject({method:'POST',url:`/api/tasks/${task.id}/decision`,headers:worker,payload:{decision:'approve',reason:'not allowed'}});
  assert.equal(forbidden.statusCode,401);
  const state = (await app.inject({url:'/api/state',headers:operator})).json<State>();
  assert.equal(state.tasks[0]!.status,'awaiting_execution_approval');
  assert.ok(!JSON.stringify(state).includes('local-worker-only'));
});

test('invalid payloads, unsupported runtime and duplicate decisions are rejected', async t => {
  const app = buildApp(); t.after(()=>app.close());
  const post = (url: string,payload: Record<string, unknown>) => app.inject({method:'POST',url,headers:operator,payload});
  assert.equal((await post('/api/tasks',{...input,budgetMicros:-1})).statusCode,400);
  assert.equal((await post('/api/tasks',{...input,budgetMicros:'1000'})).statusCode,400);
  assert.equal((await post('/api/tasks',{...input,provider:'codex'})).statusCode,422);
  assert.equal((await post('/api/tasks',{...input,runtime:'cloudflare'})).statusCode,422);
  assert.equal((await post('/api/tasks',{...input,extra:true})).statusCode,400);
  const task = (await post('/api/tasks',input)).json<Task>();
  assert.equal((await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:' '})).statusCode,400);
  assert.equal((await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'확인'})).statusCode,200);
  assert.equal((await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'중복'})).statusCode,409);
  assert.equal((await post('/api/tasks/missing/cancel',{reason:'취소'})).statusCode,404);
});

test('concurrent HTTP claims give a task to exactly one worker', async t => {
  const app = buildApp(); t.after(()=>app.close());
  const task = (await app.inject({method:'POST',url:'/api/tasks',headers:operator,payload:input})).json<Task>();
  await app.inject({method:'POST',url:`/api/tasks/${task.id}/decision`,headers:operator,payload:{decision:'approve',reason:'실행'}});
  for (const workerId of ['a','b']) await app.inject({method:'POST',url:'/api/workers/register',headers:worker,payload:{workerId,provider:'mock',runtime:'local'}});
  const claims = await Promise.all(['a','b'].map(workerId=>app.inject({method:'POST',url:'/api/workers/claim',headers:worker,payload:{workerId}})));
  assert.deepEqual(claims.map(r=>r.statusCode),[200,200]);
  assert.equal(claims.map(r=>r.json<Lease|null>()).filter(Boolean).length,1);
});

test('a separate worker completes the real HTTP flow and awaits human result approval', async t => {
  const app = buildApp(); t.after(()=>app.close());
  const url = await app.listen({host:'127.0.0.1',port:0});
  const post = async (path: string,payload: unknown) => {
    const response = await fetch(url+path,{method:'POST',headers:{...operator,'content-type':'application/json'},body:JSON.stringify(payload)});
    assert.ok(response.ok,await response.clone().text()); return response.json() as Promise<Task>;
  };
  const task = await post('/api/tasks',input);
  assert.equal(await runOnce({apiUrl:url,workerId:'remote-1',workerToken:'local-worker-only'}),false);
  await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'실행'});
  assert.equal(await runOnce({apiUrl:url,workerId:'remote-1',workerToken:'local-worker-only'}),true);
  const state = (await app.inject({url:'/api/state',headers:operator})).json<State>();
  assert.equal(state.tasks[0]!.status,'awaiting_review');
  assert.equal(state.tasks[0]!.actualCostMicros,1000);
  assert.match(state.tasks[0]!.diff!,/Synthetic/);
  const complete = await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'모의 결과 확인'});
  assert.equal(complete.status,'completed');
});

test('dashboard assets load without exposing operator credentials', async t => {
  const app = buildApp({operatorToken:'custom-secret-value'}); t.after(()=>app.close());
  for (const path of ['/','/app.js','/styles.css']) {
    const response = await app.inject(path);
    assert.equal(response.statusCode,200);
    assert.ok(!response.body.includes('custom-secret-value'));
    assert.ok(response.headers['content-security-policy']);
  }
});

const repository={id:'local',name:'fixture',baseCommit:'a'.repeat(40),testProfile:'default',testCommand:['node','--test']};
const codexInput={...input,provider:'codex',repositoryId:'local',baseCommit:repository.baseCommit,testProfile:'default'};
const actualEvidence={repositoryId:'local',baseCommit:repository.baseCommit,headCommit:repository.baseCommit,worktreePath:'/tmp/worktree/run',diffTruncated:false,status:'succeeded',tests:{command:['node','--test'],status:'passed',exitCode:0,durationMs:10,stdout:'passed',stderr:'',truncated:false},codex:{status:'passed',exitCode:0,threadId:'session',model:null,usage:null,stderr:''}};

test('capabilities reveal allowed pinned repository only to operator',async t=>{
 const app=buildApp({repository}); t.after(()=>app.close());
 assert.equal((await app.inject('/api/capabilities')).statusCode,401);
 const response=await app.inject({url:'/api/capabilities',headers:operator});
 assert.equal(response.statusCode,200); assert.deepEqual(response.json(),{providers:['mock','codex'],repository});
});

test('HTTP Codex routing and results preserve real evidence and null cost',async t=>{
 const app=buildApp({repository}); t.after(()=>app.close());
 const post=(url:string,payload:Record<string,unknown>,headers=operator)=>app.inject({method:'POST',url,headers,payload});
 assert.equal((await post('/api/tasks',{...codexInput,baseCommit:'b'.repeat(40)})).statusCode,422);
 assert.equal((await post('/api/tasks',{...codexInput,testCommand:['sh','-c','arbitrary']})).statusCode,400);
 const create=await post('/api/tasks',codexInput); assert.equal(create.statusCode,201); const task=create.json<Task>();
 assert.deepEqual(task.testCommand,repository.testCommand);
 await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'run'});
 await post('/api/workers/register',{workerId:'mock',provider:'mock',runtime:'local'},worker);
 assert.equal((await post('/api/workers/claim',{workerId:'mock'},worker)).json(),null);
 assert.equal((await post('/api/workers/register',{workerId:'c',provider:'codex',runtime:'local',repositoryId:'local'},worker)).statusCode,200);
 const lease=(await post('/api/workers/claim',{workerId:'c'},worker)).json<Lease>();
 assert.equal(lease.task.id,task.id);
 const creds={workerId:'c',leaseToken:lease.leaseToken};
 assert.equal((await post(`/api/tasks/${task.id}/result`,{...creds,summary:'bad',diff:'',actualCostMicros:null,execution:{...actualEvidence,tests:{...actualEvidence.tests,exitCode:1}}},worker)).statusCode,400);
 const result=await post(`/api/tasks/${task.id}/result`,{...creds,summary:'actual result',diff:'',actualCostMicros:null,execution:actualEvidence},worker);
 assert.equal(result.statusCode,200); assert.equal(result.json<Task>().status,'awaiting_review'); assert.equal(result.json<Task>().actualCostMicros,null);
 assert.deepEqual(result.json<Task>().execution,actualEvidence);
});

test('failed test evidence is retained and malformed or oversized logs rejected',async t=>{
 const app=buildApp({repository}); t.after(()=>app.close());
 const post=(url:string,payload:Record<string,unknown>,headers=operator)=>app.inject({method:'POST',url,headers,payload});
 const task=(await post('/api/tasks',codexInput)).json<Task>(); await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'run'});
 await post('/api/workers/register',{workerId:'c',provider:'codex',runtime:'local',repositoryId:'local'},worker);
 const lease=(await post('/api/workers/claim',{workerId:'c'},worker)).json<Lease>(); const creds={workerId:'c',leaseToken:lease.leaseToken};
 const evidence={...actualEvidence,status:'failed',tests:{...actualEvidence.tests,status:'failed',exitCode:1,stderr:'assertion failure'}};
 assert.equal((await post(`/api/tasks/${task.id}/result`,{...creds,summary:'failed',diff:'patch',actualCostMicros:null,execution:{...evidence,tests:{...evidence.tests,stdout:'x'.repeat(16001)}}},worker)).statusCode,400);
 const result=await post(`/api/tasks/${task.id}/result`,{...creds,summary:'failed',diff:'patch',actualCostMicros:null,execution:evidence},worker);
 assert.equal(result.statusCode,200); assert.equal(result.json<Task>().status,'failed'); assert.equal(result.json<Task>().execution!.tests.stderr,'assertion failure');
 assert.equal((await post(`/api/tasks/${task.id}/decision`,{decision:'approve',reason:'ignore'})).statusCode,409);
});
