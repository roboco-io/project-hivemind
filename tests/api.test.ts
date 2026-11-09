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
