import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySessionStore, runAutonomousIteration, createAutonomousHttpClient, runAutonomousCleanup } from '../packages/adapters/src/autonomous-runner.js';
import { mockAutonomousExecutor } from '../apps/worker/src/autonomous-mock.js';
import type { AutonomousTask, AutonomousSpec } from '../packages/contracts/src/autonomous.js';

const spec: AutonomousSpec = { requestId:'request',goal:'synthetic goal',provider:'mock',model:'mock-fixed',subagentModel:'child-fixed',endsAt:10000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:5 };
async function fixture(overrides: Partial<AutonomousSpec> = {}) {
  // Same HTTP fixture can consume the real producer at the seam check.
  const real = process.env.SUPERLITE_REAL === '1';
  let task = {id:'task',spec:{...spec,...overrides},revision:1,status:'ready',createdAt:0,iteration:0,runs:[],actions:[],resources:[],interventions:[],spentMicros:0,reservedMicros:0} as AutonomousTask;
  let engine: any;
  if (real) {
    const { AutonomousEngine } = await import('../packages/core/src/autonomous.js');
    engine = new AutonomousEngine();
    task = engine.create(task.spec,0,'task'); engine.approve('task',task.revision,'demo approval',0);
  }
  let clock = 1;
  let denyHeartbeat = false;
  let available = true;
  const calls: Array<{route:string;body:any}> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer worker-secret');
    const route = new URL(String(input)).pathname.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)); calls.push({route,body});
    if (route === 'claim') {
      if (!available) return Response.json(null);
      const lease = engine ? engine.claim('task',body.workerId,'private-token',`run-${calls.length}`,clock) : {taskId:'task',runId:`run-${calls.length}`,workerId:body.workerId,token:'private-token',expiresAt:clock+1000};
      if (!lease) return Response.json(null);
      task = engine ? engine.get('task') : {...task,status:'running',iteration:task.iteration+1};
      return Response.json({lease,task});
    }
    if (route === 'heartbeat') return denyHeartbeat ? Response.json({error:'cancelled'},{status:409}) : Response.json(engine ? engine.heartbeat(body.lease,clock) : body.lease);
    if (route === 'finish') {
      if (engine) task = engine.finish(body.lease,body.result,clock);
      else task = {...task,status:body.result.outcome==='complete'?'completed':'ready',checkpoint:body.result.checkpoint};
      return Response.json(task);
    }
    throw new Error(`Unexpected route: ${route}`);
  };
  return {client:createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker-secret',fetchImpl}),calls,task:()=>task,setIdle:()=>{available=false;},cancel:()=>{denyHeartbeat=true;},clock:()=>clock,setClock:(now:number)=>{clock=now;}};
}
const options = (f: Awaited<ReturnType<typeof fixture>>, sessions = new MemorySessionStore()) => ({client:f.client,taskId:'task',workerId:'worker',sessions,now:f.clock,heartbeatMs:5,executor:mockAutonomousExecutor});

test('idle or waiting claim never invokes executor or credentials',async()=>{
  const f=await fixture(); f.setIdle();
  assert.equal(await runAutonomousIteration({...options(f),executor:async()=>{throw Error('invoked');},resolveCredentials:async()=>{throw Error('credentials');}}),false);
  assert.deepEqual(f.calls.map(c=>c.route),['claim']);
});
test('restart restores private session, fixed models and per-run usage',async()=>{
  const f=await fixture(); const sessions=new MemorySessionStore(); const seen:any[]=[];
  const executor: typeof mockAutonomousExecutor=async context=>{seen.push(context);return mockAutonomousExecutor(context);};
  await runAutonomousIteration({...options(f,sessions),executor});
  await runAutonomousIteration({...options(f,sessions),workerId:'restarted',executor});
  assert.equal(seen[1].session.sessionId,seen[0].session.sessionId);
  assert.equal(seen[1].session.model,'mock-fixed');
  assert.deepEqual(seen[1].session.data,{transcript:'private transcript',previous:null});
  assert.equal(seen[1].subagentModel,'child-fixed');
  const results=f.calls.filter(c=>c.route==='finish').map(c=>c.body.result);
  assert.deepEqual(results.map(r=>r.usage.outputTokens),[1,1]);
  assert.equal(results[1].checkpoint.sequence,2);
  assert.match(results[0].message,/synthetic/i);
  assert.equal(JSON.stringify(results).includes('private transcript'),false);
});
test('native provider requires explicitly injected executor before credential resolution',async()=>{
  const f=await fixture({provider:'codex'});
  await assert.rejects(runAutonomousIteration({...options(f),executor:undefined,resolveCredentials:async()=>{throw Error('credential leak');}}),{name:'UnsupportedAutonomousCapabilityError'});
  assert.equal(f.calls.find(c=>c.route==='finish')!.body.result.costMicros,0);
  assert.equal(f.calls.find(c=>c.route==='finish')!.body.result.outcome,'failed');
});
test('unknown cost stays null and credentials never enter finish payload',async()=>{
  const f=await fixture({provider:'codex',credentialIds:['credential-id']});
  const durable = new MemorySessionStore();
  await runAutonomousIteration({...options(f),sessions:{durable:true,load:durable.load.bind(durable),save:durable.save.bind(durable)},nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async ids=>{assert.deepEqual(ids,['credential-id']);return {auth:'provider-secret'};},executor:async c=>{
    assert.equal(c.credentials.auth,'provider-secret');
    return {outcome:'continue',usage:{inputTokens:2,cacheReadTokens:1,cacheWriteTokens:0,outputTokens:1},costMicros:null,session:{...c.session,sequence:c.session.sequence+1,data:'private transcript'}};
  }});
  const finish=f.calls.find(c=>c.route==='finish')!.body;
  assert.equal(finish.result.costMicros,null);
  assert.equal(JSON.stringify(finish).includes('provider-secret'),false);
});
test('heartbeat rejection aborts even an executor ignoring cancellation and prevents finish',async()=>{
  const f=await fixture();
  await assert.rejects(runAutonomousIteration({...options(f),executor:async c=>{
    f.cancel(); return new Promise((_resolve)=>{c.signal.addEventListener('abort',()=>{}, {once:true});});
  }}),/heartbeat/i);
  assert.equal(f.calls.some(c=>c.route==='finish'),false);
});
test('caller cancellation prevents result submission',async()=>{
  const f=await fixture();const controller=new AbortController();
  await assert.rejects(runAutonomousIteration({...options(f),signal:controller.signal,executor:async c=>{
    controller.abort(new Error('operator stop'));return mockAutonomousExecutor(c);
  }}),/operator stop/);
  assert.equal(f.calls.some(c=>c.route==='finish'),false);
});
test('missing private session fails closed without model invocation',async()=>{
  const f=await fixture();await runAutonomousIteration(options(f));
  await assert.rejects(runAutonomousIteration({...options(f),executor:async()=>{throw Error('model invoked');}}),{name:'UnsupportedAutonomousCapabilityError'});
});
test('private store copies stored and loaded artifacts',async()=>{
  const sessions=new MemorySessionStore();const value={sessionId:'s',model:'m',sequence:1,data:{text:'private'}};
  const ref=await sessions.save('t',value);value.data.text='modified';
  const loaded=await sessions.load('t',ref);assert.deepEqual(loaded?.data,{text:'private'});
  loaded!.data='changed';assert.deepEqual((await sessions.load('t',ref))?.data,{text:'private'});
  assert.equal(await sessions.load('other',ref),undefined);
});

test('trusted cleanup retries failed deletion and only confirms stopping resources',async()=>{
  const resource={id:'r',system:'mock-system',cleanupOperation:'delete',status:'cleanup_pending' as const,actionId:'a'};
  let attempts=0;const confirmed:string[]=[];let stopping=true;
  const client={readTask:async()=>({...((await fixture()).task()),status:stopping?'stopping':'running',resources:[resource]}) as AutonomousTask,confirmCleaned:async(_taskId:string,id:string)=>{confirmed.push(id);resource.status='cleaned' as any;}};
  const cleanup=async()=>{if(++attempts===1)throw Error('external unavailable');};
  const config={taskId:'task',client,cleanup};
  assert.deepEqual(await runAutonomousCleanup(config),{cleaned:[],pending:['r']});
  assert.deepEqual(await runAutonomousCleanup(config),{cleaned:['r'],pending:[]});
  assert.deepEqual(await runAutonomousCleanup(config),{cleaned:[],pending:[]});
  assert.deepEqual(confirmed,['r']);stopping=false;
  assert.deepEqual(await runAutonomousCleanup(config),{cleaned:[],pending:[]});
});
test('cleanup cancellation prevents confirmation and allows safe retry',async()=>{
  const f=await fixture();let confirmed=0;const controller=new AbortController();
  const client={readTask:async()=>({...f.task(),status:'stopping',resources:[{id:'r',system:'s',cleanupOperation:'delete',status:'cleanup_pending',actionId:'a'}]}) as AutonomousTask,confirmCleaned:async()=>{confirmed++;}};
  await assert.rejects(runAutonomousCleanup({taskId:'task',client,signal:controller.signal,cleanup:async()=>{controller.abort(new Error('stop cleanup'));}}),/stop cleanup/);
  assert.equal(confirmed,0);
  await runAutonomousCleanup({taskId:'task',client,cleanup:async()=>{}});
  assert.equal(confirmed,1);
});
test('out-of-scope reservation reaches central policy suspension',async()=>{
  const f=await fixture();let recorded=false;
  const client={...f.client,reserve:async()=>{recorded=true;throw Error('central scope suspension');}};
  await assert.rejects(runAutonomousIteration({...options(f),client,executor:async c=>{
    await c.actions.reserve({requestId:'a',tool:'Bash',system:'aws',operation:'create',estimatedCostMicros:1});
    return mockAutonomousExecutor(c);
  }}),/central scope suspension/);
  assert.equal(recorded,true);
});
test('native provider cannot use synthetic session storage even with claimed capabilities',async()=>{
  const f=await fixture({provider:'claude'});
  await assert.rejects(runAutonomousIteration({...options(f),nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true}}),{code:'NOT_SUPPORTED'});
});

test('heartbeat extends short lease while hard run deadline remains fixed',async()=>{
  const f=await fixture();const client={...f.client,
    claim:async(...args:Parameters<typeof f.client.claim>)=>{const c=await f.client.claim(...args);return c ? {...c,lease:{...c.lease,expiresAt:f.clock()+15}} : null;},
    heartbeat:async(lease: any)=>({...lease,expiresAt:f.clock()+100}),
  };
  let time=1;
  await runAutonomousIteration({...options(f),client,now:()=>time,executor:async c=>{
    await new Promise(resolve=>setTimeout(resolve,25));time=26;return mockAutonomousExecutor(c);
  }});
  assert.equal(f.calls.some(c=>c.route==='finish'),true);
});

test('mock demo explicitly approves as operator and runs only HTTP worker calls',async()=>{
  const {runAutonomousMockDemo}=await import('../apps/worker/src/autonomous-mock.js');
  let approved=false;let checkpoint:any;let sequence=0;const roles:string[]=[];
  const fetchImpl:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;const body=JSON.parse(String(init?.body));
    const role=(init?.headers as Record<string,string>).authorization!;roles.push(role);
    if(path==='/v1/autonomous-tasks')return Response.json({id:'demo',revision:1,spec:body});
    if(path.endsWith('/approve')){assert.equal(role,'Bearer operator-secret');approved=true;return Response.json({});}
    assert.equal(role,'Bearer worker-secret');assert.equal(approved,true);
    if(path.endsWith('/claim'))return Response.json({task:{id:'demo',status:'running',spec:{...spec,endsAt:Date.now()+60000},checkpoint},lease:{taskId:'demo',runId:`run-${sequence}`,workerId:body.workerId,token:'private',expiresAt:Date.now()+1000}});
    if(path.endsWith('/finish')){checkpoint=body.result.checkpoint;sequence++;return Response.json({});}
    throw Error('unexpected demo route');
  };
  assert.deepEqual(await runAutonomousMockDemo({apiUrl:'http://control',operatorToken:'operator-secret',workerToken:'worker-secret',fetchImpl}),{synthetic:true,taskId:'demo',iterations:2});
  assert.equal(sequence,2);assert.equal(roles.filter(r=>r==='Bearer operator-secret').length,2);
});

test('default heartbeat cadence follows short lease rather than long run limit',async()=>{
  const f=await fixture();let beats=0;
  const client={...f.client,claim:async(...args:Parameters<typeof f.client.claim>)=>{
    const c=await f.client.claim(...args);return c?{...c,lease:{...c.lease,expiresAt:f.clock()+30}}:null;
  },heartbeat:async(lease:any)=>{beats++;return {...lease,expiresAt:f.clock()+100};}};
  await runAutonomousIteration({...options(f),client,heartbeatMs:undefined,executor:async c=>{
    await new Promise(resolve=>setTimeout(resolve,45));return mockAutonomousExecutor(c);
  }});
  assert.ok(beats>0);
});

test('synthetic executor completes second iteration with restored transcript',async()=>{
  const f=await fixture();const sessions=new MemorySessionStore();
  await runAutonomousIteration(options(f,sessions));
  await runAutonomousIteration(options(f,sessions));
  assert.deepEqual(f.calls.filter(c=>c.route==='finish').map(c=>c.body.result.outcome),['continue','complete']);
});

test('HTTP claim exposes running status and increments iteration before executor',async()=>{
  const f=await fixture();
  await runAutonomousIteration({...options(f),executor:async c=>{
    assert.equal(f.task().status,'running');assert.equal(f.task().iteration,1);
    return mockAutonomousExecutor(c);
  }});
  assert.equal(f.task().iteration,1);
});

test('trusted cleanup handles pending resources while awaiting operator input',async()=>{
 const {AutonomousEngine}=await import('../packages/core/src/autonomous.js');
 const engine=new AutonomousEngine();const task=engine.create({...spec,tools:['compute'],systems:['mock']},0,'cleanup-help');
 engine.approve(task.id,task.revision,'approved',0);const lease=engine.claim(task.id,'worker','private','run',1)!;
 const action=engine.reserve(lease,{requestId:'resource',tool:'compute',system:'mock',operation:'create',estimatedCostMicros:1},1);
 engine.settle(lease,action.id,1,true,{id:'resource',system:'mock',cleanupOperation:'delete'},1);
 engine.finish(lease,{outcome:'input',usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},costMicros:0},1);
 assert.equal(engine.get(task.id).status,'awaiting_input');
 let removed=0;
 const result=await runAutonomousCleanup({taskId:task.id,client:{readTask:async()=>engine.get(task.id),confirmCleaned:async(id,r)=>engine.cleaned(id,r,1)},cleanup:async()=>{removed++;}});
 assert.deepEqual(result,{cleaned:['resource'],pending:[]});assert.equal(removed,1);
 engine.message(task.id,'Ready to continue',1);assert.equal(engine.resume(task.id,task.revision,'cleanup verified',1).status,'ready');
});

test('runner sends only usage and checkpoint contract fields from capability outputs',async()=>{
 const f=await fixture();const sessions=new MemorySessionStore();
 await runAutonomousIteration({...options(f),sessions:{load:sessions.load.bind(sessions),save:async(id,session)=>({...await sessions.save(id,session),privateTranscript:'fixture-private-checkpoint'})},executor:async c=>{
  const result=await mockAutonomousExecutor(c);return {...result,usage:{...result.usage,privateCredential:'fixture-private-usage'}};
 }});
 const finish=f.calls.find(c=>c.route==='finish')!.body;
 assert.doesNotMatch(JSON.stringify(finish),/fixture-private|privateTranscript|privateCredential/);
 assert.deepEqual(Object.keys(finish.result.usage).sort(),['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].sort());
});

test('caller abort before deferred capability invocation prevents sending a reservation',async()=>{
 const f=await fixture();const controller=new AbortController();let reservations=0;
 const client={...f.client,reserve:async()=>{reservations++;throw Error('must not send');}};
 await assert.rejects(runAutonomousIteration({...options(f),client,signal:controller.signal,executor:async c=>{
  const pending=c.actions.reserve({requestId:'cancel-race',tool:'compute',system:'mock',operation:'create',estimatedCostMicros:1});
  controller.abort(new Error('cancel before send'));await pending;return mockAutonomousExecutor(c);
 }}),/cancel before send/);
 assert.equal(reservations,0);
});

test('unsupported preflight releases real lease as verified zero execution while preserving NOT_SUPPORTED',async()=>{
 const {AutonomousEngine}=await import('../packages/core/src/autonomous.js');const engine=new AutonomousEngine();
 const task=engine.create(spec,0,'task');engine.approve(task.id,task.revision,'approved',0);
 const f=await fixture();let resolutions=0;
 const client={...f.client,claim:async()=>{const lease=engine.claim(task.id,'worker','private','run',1);return lease?{lease,task:engine.get(task.id)}:null;},finish:async(lease:Parameters<typeof engine.finish>[0],result:Parameters<typeof engine.finish>[1])=>engine.finish(lease,result,1)};
 await assert.rejects(runAutonomousIteration({...options(f),client,executor:undefined,resolveCredentials:async()=>{resolutions++;return {};}}),{code:'NOT_SUPPORTED'});
 const stopped=engine.get(task.id);assert.equal(stopped.lease,undefined);assert.equal(stopped.status,'failed');
 assert.equal(stopped.runs[0]!.costMicros,0);assert.equal(stopped.runs[0]!.usageUnavailable,undefined);assert.equal(resolutions,0);
});

for(const durable of [undefined,false] as const)test(`native rejects private store durable=${durable} before credentials or execution`,async()=>{
 const f=await fixture({provider:'claude',credentialIds:['credential-id']});const memory=new MemorySessionStore();let called=0;
 await assert.rejects(runAutonomousIteration({...options(f),sessions:{durable,load:memory.load.bind(memory),save:memory.save.bind(memory)},nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async()=>{called++;return {};},executor:async c=>{called++;return mockAutonomousExecutor(c);}}),{code:'NOT_SUPPORTED'});
 assert.equal(called,0);assert.equal(f.calls.find(c=>c.route==='finish')!.body.result.costMicros,0);
});

test('executor context uses claimed task identity rather than the request id',async()=>{
 const f=await fixture({requestId:'distinct-idempotency-key'});
 await runAutonomousIteration({...options(f),executor:async c=>{
  assert.equal(c.taskId,'task');
  assert.notEqual(c.taskId,c.spec.requestId);
  return mockAutonomousExecutor(c);
 }});
});

test('executor receives a copy of the current execution lease',async()=>{
 const f=await fixture();
 await runAutonomousIteration({...options(f),executor:async c=>{
  const lease=c.executionLease;
  assert.equal(lease?.taskId,'task');assert.equal(lease.workerId,'worker');assert.equal(lease.token,'private-token');
  lease.token='executor-mutated';lease.runId='executor-mutated';
  return mockAutonomousExecutor(c);
 }});
 const finish=f.calls.find(c=>c.route==='finish')!.body;
 assert.equal(finish.lease.token,'private-token');assert.notEqual(finish.lease.runId,'executor-mutated');
});

test('executor lease copy includes heartbeat renewal during credential resolution',async()=>{
 const f=await fixture({credentialIds:['scoped']});let beats=0;
 const client={...f.client,heartbeat:async(lease:Parameters<typeof f.client.heartbeat>[0])=>{beats++;return {...lease,expiresAt:2001};}};
 await runAutonomousIteration({...options(f),client,heartbeatMs:1,resolveCredentials:async()=>{await new Promise(r=>setTimeout(r,15));return {};},executor:async c=>{
  assert.ok(beats>0);assert.equal(c.executionLease.expiresAt,2001);return mockAutonomousExecutor(c);
 }});
});
