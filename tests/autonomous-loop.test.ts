import test from 'node:test';
import assert from 'node:assert/strict';
import {runAutonomousLoop} from '../packages/adapters/src/autonomous-loop.js';
import {MemorySessionStore,createAutonomousHttpClient,type AutonomousWorkerClient} from '../packages/adapters/src/autonomous-runner.js';
import type {AutonomousStatus,AutonomousTask} from '../packages/contracts/src/autonomous.js';

async function fixture() {
 let clock=1,executions=0,claims=0,overrideState=false;
 const sleeps:number[]=[];
 let state={taskId:'task',status:'ready' as AutonomousStatus,endsAt:10000,iteration:0,nextRunAt:undefined as number|undefined};
 const real=process.env.SUPERLITE_REAL==='1';
 const engine=real?new (await import('../packages/core/src/autonomous.js')).AutonomousEngine():undefined;
 const spec={requestId:'loop-test',goal:'synthetic',provider:'mock' as const,model:'mock',endsAt:10000,maxRunMs:1000,maxIterations:10,budgetMicros:100,tools:[],systems:[],credentialIds:[]};
 if(engine){const task=engine.create(spec,0,'task');engine.approve(task.id,task.revision,'synthetic approval',0);}
 const client:AutonomousWorkerClient={
  workerState:async()=>{if(engine&&!overrideState){engine.tick(clock);return engine.workerState('task');}return state;},
  claim:async()=>{claims++;if(engine){const lease=engine.claim('task','worker','private',`run-${claims}`,clock);return lease?{lease,task:engine.get('task')}:null;}if(state.status!=='ready')return null;return {task:{id:'task',spec,status:'running',iteration:state.iteration+1,revision:1,createdAt:0,runs:[],actions:[],resources:[],interventions:[],spentMicros:0,reservedMicros:0} as AutonomousTask,lease:{taskId:'task',workerId:'worker',runId:`r${claims}`,token:'private',expiresAt:clock+1000}};},
  heartbeat:async lease=>lease,
  finish:async(lease,result)=>{if(engine)return engine.finish(lease,result,clock);state={...state,status:result.outcome==='complete'?'completed':result.outcome==='wait'?'waiting':'ready',iteration:state.iteration+1,nextRunAt:result.wakeAt};},
  reserve:async()=>{throw Error('unused');},settle:async()=>{throw Error('unused');},
 };
 const options={client,taskId:'task',workerId:'worker',sessions:new MemorySessionStore(),maxIterations:5,maxIdlePolls:3,pollMs:100,now:()=>clock,
  wait:async(ms:number)=>{sleeps.push(ms);clock+=ms;if(state.status==='waiting'&&clock>=state.nextRunAt!)state.status='ready';},
  executor:async(c:Parameters<NonNullable<import('../packages/adapters/src/autonomous-runner.js').AutonomousIterationOptions['executor']>>[0])=>{
   executions++;return {outcome:executions===1?'continue' as const:executions===2?'wait' as const:'complete' as const,wakeAt:executions===2?clock+250:undefined,costMicros:1,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},session:{...c.session,sequence:c.session.sequence+1}};
  }};
 return {options,sleeps,executions:()=>executions,claims:()=>claims,setStatus:(status:AutonomousStatus)=>{state.status=status;overrideState=true;},setState:(patch:Partial<typeof state>)=>{state={...state,...patch};overrideState=true;}};
}
test('continue, bounded waiting, complete without operator actions',async()=>{
 const f=await fixture();assert.deepEqual(await runAutonomousLoop(f.options),{iterations:3,reason:'completed'});assert.equal(f.executions(),3);assert.deepEqual(f.sleeps,[100,100,50]);
});
for(const status of ['awaiting_input','stopping','awaiting_approval','cancelled','failed','expired','budget_exceeded','completed'] as const)test(`safe stop on ${status}`,async()=>{
 const f=await fixture();f.setStatus(status);assert.deepEqual(await runAutonomousLoop(f.options),{iterations:0,reason:status});assert.equal(f.claims(),0);
});
test('finite iterations and idle limits',async()=>{
 const f=await fixture();assert.deepEqual(await runAutonomousLoop({...f.options,maxIterations:1}),{iterations:1,reason:'iteration_limit'});
 const g=await fixture();g.setStatus('running');assert.deepEqual(await runAutonomousLoop(g.options),{iterations:0,reason:'idle_limit'});assert.deepEqual(g.sleeps,[100,100,100]);assert.equal(g.claims(),0);
});
test('future ready time does not claim or spin',async()=>{
 const f=await fixture();f.setState({nextRunAt:251});await runAutonomousLoop({...f.options,maxIterations:1});assert.deepEqual(f.sleeps,[100,100,50]);assert.equal(f.claims(),1);
});
test('missing state capability, operator credentials and invalid limits refuse before claim',async()=>{
 for(const patch of [{client:{...((await fixture()).options.client),workerState:undefined}},{operatorToken:'secret'},{maxIterations:Infinity},{maxIdlePolls:0},{pollMs:0}]){
  const f=await fixture();await assert.rejects(runAutonomousLoop({...f.options,...patch} as unknown as Parameters<typeof runAutonomousLoop>[0]));assert.equal(f.claims(),0);
 }
});
test('uncertain invocation error never retries or finishes again',async()=>{
 const f=await fixture();let calls=0;await assert.rejects(runAutonomousLoop({...f.options,executor:async()=>{calls++;throw Error('uncertain execution');}}),/uncertain execution/);assert.equal(calls,1);assert.equal(f.claims(),1);
});
test('default idle sleep aborts promptly',async()=>{
 const f=await fixture();f.setStatus('waiting');const controller=new AbortController();const pending=runAutonomousLoop({...f.options,wait:undefined,pollMs:5000,signal:controller.signal});setTimeout(()=>controller.abort(Error('stop')),10);await assert.rejects(pending,/stop/);assert.equal(f.claims(),0);
});
test('worker-state transport uses only worker GET and rejects redirect',async()=>{
 const calls:any[]=[];const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker-secret',fetchImpl:async(input,init)=>{calls.push({input,init});return Response.json({taskId:'task/a',status:'completed',endsAt:10,iteration:2});}});
 assert.equal((await client.workerState!('task/a')).status,'completed');assert.equal(calls[0].input,'http://control/v1/autonomous-tasks/task%2Fa/worker-state');assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.authorization,'Bearer worker-secret');assert.equal(calls[0].init.body,undefined);
});
test('worker POST prevents redirected lease replay',async()=>{
 let observed:RequestInit|undefined;
 const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker-secret',fetchImpl:async(_input,init)=>{observed=init;return Response.json({});}});
 await client.finish({taskId:'task',runId:'run',workerId:'worker',token:'private-lease',expiresAt:100},{outcome:'failed',costMicros:null,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}});
 assert.equal(observed?.redirect,'error');assert.equal(observed?.method,'POST');
});
test('state response grants no execution authority when claim loses a race',async()=>{
 const f=await fixture();let claims=0;
 assert.deepEqual(await runAutonomousLoop({...f.options,client:{...f.options.client,claim:async()=>{claims++;return null;}}}),{iterations:0,reason:'idle_limit'});
 assert.equal(f.executions(),0);assert.equal(claims,4);assert.deepEqual(f.sleeps,[100,100,100]);
});
test('state transport error is not retried and task deadline prevents claim',async()=>{
 const f=await fixture();let reads=0;await assert.rejects(runAutonomousLoop({...f.options,client:{...f.options.client,workerState:async()=>{reads++;throw Error('transport uncertain');}}}),/transport uncertain/);assert.equal(reads,1);assert.equal(f.claims(),0);
 const g=await fixture();g.setState({endsAt:1});assert.deepEqual(await runAutonomousLoop(g.options),{iterations:0,reason:'expired'});assert.equal(g.claims(),0);
});

test('abort stops a stalled worker-state adapter without another poll',async()=>{
 const f=await fixture(),controller=new AbortController();let reads=0;
 const pending=runAutonomousLoop({...f.options,signal:controller.signal,client:{...f.options.client,workerState:async()=>{reads++;return new Promise(()=>{});}}});
 controller.abort(Error('stop state'));
 const result=await Promise.race([pending.then(()=> 'resolved',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('stalled'),40))]);
 assert.equal(result,'aborted');assert.equal(reads,1);assert.equal(f.claims(),0);
});
test('abort stops injected wait that ignores its signal',async()=>{
 const f=await fixture(),controller=new AbortController();f.setStatus('waiting');
 const pending=runAutonomousLoop({...f.options,signal:controller.signal,wait:async()=>{controller.abort(Error('stop wait'));await new Promise(()=>{});}});
 const result=await Promise.race([pending.then(()=> 'resolved',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('stalled'),40))]);
 assert.equal(result,'aborted');assert.equal(f.claims(),0);
});
test('worker-state transport bounds streamed body and validates minimal DTO',async()=>{
 for(const body of [JSON.stringify({taskId:'task',status:'ready',endsAt:100,iteration:0,padding:'x'.repeat(5000)}),JSON.stringify({taskId:'task',status:'ready',endsAt:100,iteration:0,credentialIds:['private']}),JSON.stringify({taskId:'other',status:'ready',endsAt:100,iteration:0}),JSON.stringify({taskId:'task',status:'unknown',endsAt:100,iteration:0})]){
  const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>new Response(body)});
  await assert.rejects(client.workerState!('task'));
 }
});
test('worker HTTP abort rejects even when fetch ignores the signal',async()=>{
 const controller=new AbortController();const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>new Promise(()=>{})});
 const pending=client.claim('task','worker',controller.signal);controller.abort(Error('stop fetch'));
 const result=await Promise.race([pending.then(()=> 'resolved',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('stalled'),40))]);
 assert.equal(result,'aborted');
});
test('HTTP response streaming cancels its reader on abort and enforces size',async()=>{
 const controller=new AbortController();let cancelled=false;
 const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}))});
 const pending=client.workerState!('task',controller.signal);
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort(Error('stop body'));
 await assert.rejects(pending,/stop body/);assert.equal(cancelled,true);
 const oversized=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>new Response(JSON.stringify({padding:'x'.repeat(5000)}))});
 await assert.rejects(oversized.workerState!('task'),/response too large/);
});
test('loop cancellation rejects a pending injected claim without replay',async()=>{
 const f=await fixture(),controller=new AbortController();let claims=0;
 const pending=runAutonomousLoop({...f.options,signal:controller.signal,client:{...f.options.client,claim:async()=>{claims++;controller.abort(Error('stop claim'));return new Promise(()=>{});}}});
 const result=await Promise.race([pending.then(()=> 'resolved',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('stalled'),40))]);
 assert.equal(result,'aborted');assert.equal(claims,1);assert.equal(f.executions(),0);
});
test('claim response accommodates task history near Cloudflare hard state capacity',async()=>{
 const history='x'.repeat(1900*1024);
 const response={task:{id:'task',interventions:[{message:history}]},lease:{taskId:'task',runId:'run',workerId:'worker',token:'lease',expiresAt:100}};
 const client=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>Response.json(response)});
 const claim=await client.claim('task','worker');
 assert.equal(claim?.task.interventions[0]?.message.length,history.length);
 const oversized=createAutonomousHttpClient({apiUrl:'http://control',workerToken:'worker',fetchImpl:async()=>Response.json({padding:'x'.repeat(2*1024*1024)})});
 await assert.rejects(oversized.claim('task','worker'),/response too large/);
});
