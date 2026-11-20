import test from 'node:test';
import assert from 'node:assert/strict';
import {createClaudeAutonomousExecutor,createClaudeRuntimeHttpPort} from '../packages/adapters/src/autonomous-claude.js';
import type {AutonomousSpec,AutonomousLease} from '../packages/contracts/src/autonomous.js';
import type {AutonomousExecutionContext} from '../packages/adapters/src/autonomous-runner.js';
import type {NativeClaudeRequest,NativeClaudeResponse} from '../packages/contracts/src/autonomous-native.js';
const auth='sk-ant-oat01-synthetic_test_credential';
const id='6a9d2ff4-0af4-4bab-9cd5-c7ac254a8990';
const snapshot={version:1 as const,digest:'a'.repeat(64),files:[]};
function context():Omit<AutonomousExecutionContext,'spec'> & {taskId:string;spec:AutonomousSpec;executionLease:AutonomousLease} {return {taskId:'central-task',executionLease:{taskId:'central-task',runId:'synthetic-run',workerId:'synthetic-worker',token:'synthetic-private-execution-lease-token',expiresAt:Date.now()+60000},spec:{requestId:'client-request',goal:'synthetic goal',provider:'claude',model:'claude-sonnet-4-6',endsAt:Date.now()+60000,budgetMicros:10,tools:['Bash'],systems:[],credentialIds:['credential-id'],maxRunMs:1000,maxIterations:4},model:'claude-sonnet-4-6',session:{sessionId:id,model:'claude-sonnet-4-6',sequence:0,data:null},credentials:{claudeSubscription:auth},signal:new AbortController().signal,actions:{async reserve(){throw Error('unexpected');},async settle(){throw Error('unexpected');}}};}
function response(request:NativeClaudeRequest):NativeClaudeResponse {return {version:1,session:{...request.session,sequence:request.session.sequence+1,data:{version:1,sessionId:id,model:request.model,workspacePath:'/workspace',snapshot,transcripts:[{path:id+'.jsonl',content:'{"text":"CONTROL_TOKEN identifier is permitted"}\n'}]}},usage:{inputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,outputTokens:4},outcome:'complete',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};}
const generic=/^Error: Native Claude iteration rejected$/;
test('HTTP transport credential cannot be archived in private runtime response',async()=>{
 const token='synthetic-private-http-credential';
 const port=createClaudeRuntimeHttpPort({url:'https://runtime.test',token,fetchImpl:async(_url,init)=>{
  const r=response(JSON.parse(init!.body as string));
  (r.session.data as {transcripts:{content:string}[]}).transcripts[0]!.content=JSON.stringify({text:token})+'\n';
  return new Response(JSON.stringify(r));
 }});
 await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:port})(context()),generic);
});
test('executor fixed private wire and cost null, explicitly pins fallback child model',async()=>{
 const ctx=context();let seen:NativeClaudeRequest|undefined;
 const executor=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(r,signal){assert.equal(signal,ctx.signal);seen=r;return response(r);}}});
 const result=await executor(ctx);assert.deepEqual(seen,{version:1,taskId:'central-task',executionLease:ctx.executionLease,model:ctx.model,subagentModel:ctx.model,tools:['Bash'],goal:'synthetic goal',session:ctx.session,subscriptionAuth:auth,maxRunMs:1000,initialSnapshot:snapshot});
 assert.equal(result.costMicros,null);assert.equal(result.session.sequence,1);assert.deepEqual(result.usage,{inputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,outputTokens:4});assert.deepEqual(Object.keys(result).sort(),['costMicros','outcome','session','usage']);
});
test('rejects unsupported policy and credentials before runtime',async()=>{
 let calls=0;const executor=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(r){calls++;return response(r);}}});
 for(const mutate of [
  (c:ReturnType<typeof context>)=>{c.spec.provider='codex';},c=>{c.spec.tools=[];},c=>{c.spec.tools=['Agent'];},c=>{c.spec.tools=['Bash','Bash'];},c=>{c.spec.tools=['Bash','WebFetch'];},c=>{c.spec.systems=['aws'];},c=>{c.spec.credentialIds=[];},c=>{c.spec.credentialIds=['a','b'];},c=>{c.credentials={wrong:auth};},c=>{c.credentials={claudeSubscription:auth,other:'secret'};},c=>{c.credentials={claudeSubscription:'api-key'};},c=>{c.model='other';},c=>{c.subagentModel='other';},c=>{c.session.model='other';},c=>{c.session.sequence=1;},c=>{c.taskId='';}
 ] satisfies ((c:ReturnType<typeof context>)=>void)[]){const c=context();mutate(c);await assert.rejects(executor(c),generic);}
 assert.equal(calls,0);await assert.rejects(createClaudeAutonomousExecutor({runtime:{async execute(r){calls++;return response(r);}}})(context()),generic);assert.equal(calls,0);
});
test('Agent policy order insensitive, resume private data and pinned approved child',async()=>{
 const c=context();c.spec.tools=['Agent','Bash'];c.spec.subagentModel='claude-haiku-4-5';c.subagentModel=c.spec.subagentModel;c.session=response({session:c.session,model:c.model} as NativeClaudeRequest).session;
 const result=await createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(r){assert.equal(r.subagentModel,'claude-haiku-4-5');assert.equal(r.initialSnapshot,undefined);assert.deepEqual(r.session,c.session);return response(r);}}})(c);assert.equal(result.session.sequence,2);
});
test('untrusted runtime fields, malformed metrics/boundary/body/outcome fail closed',async()=>{
 const mutations:((r:NativeClaudeResponse)=>void)[]=[r=>{r.session.model='other';},r=>{r.session.sessionId='other';},r=>{r.session.sequence=9;},r=>{r.session.data=null;},r=>{r.usage.cacheReadTokens=-1;},r=>{delete (r.usage as Partial<typeof r.usage>).cacheWriteTokens;},r=>{r.usage.outputTokens=Number.MAX_SAFE_INTEGER+1;},r=>{r.boundary.verified=false as true;},r=>{r.outcome='unknown' as 'complete';},r=>{r.outcome='wait';},r=>{r.wakeAt=Date.now()+1000;},r=>{Object.assign(r,{message:auth});},r=>{r.session.data={version:1,token:auth};},r=>{Object.defineProperty(r,'extra',{get(){throw Error(auth);},enumerable:true});},r=>{r.session.data={toJSON(){throw Error(auth);}};}];
 for(const mutate of mutations)await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){const r=response(q);mutate(r);return r;}}})(context()),generic);
});
test('cancellation rejects even if injected runtime ignores signal; error secrets never echo',async()=>{
 const c=context(),controller=new AbortController();c.signal=controller.signal;
 const pending=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{execute(){return new Promise(()=>{});}}})(c);controller.abort(Error(auth));await assert.rejects(pending,generic);
 await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(){throw Error(auth);}}})(context()),generic);
});
test('HTTP private transport fixes endpoint, auth, redirects and bounds parsed response',async()=>{
 const ctx=context();let seen:RequestInit|undefined;const port=createClaudeRuntimeHttpPort({url:'http://127.0.0.1:8123',token:'synthetic-private-token',fetchImpl:async(url,init)=>{assert.equal(url,'http://127.0.0.1:8123/iteration');seen=init;return new Response(JSON.stringify(response(JSON.parse(init!.body as string))),{headers:{'content-type':'application/json'}});}});
 const result=await createClaudeAutonomousExecutor({runtime:port,initialSnapshot:snapshot})(ctx);assert.equal(result.costMicros,null);assert.equal(seen?.redirect,'error');assert.equal((seen?.headers as Record<string,string>).authorization,'Bearer synthetic-private-token');
 for(const url of ['http://example.com','https://user:pass@example.com','https://example.com?x=1','https://example.com#x','file:///tmp/runtime','https://example.com/other','http://127.0.0.1.evil.test'])assert.throws(()=>createClaudeRuntimeHttpPort({url,token:'synthetic'}));
 for(const res of [new Response(auth,{status:500}),new Response('not JSON'),new Response('{}',{status:302,headers:{location:'https://evil.test'}}),new Response('{}',{headers:{'content-length':String(13*1024*1024)}}),new Response('x'.repeat(12*1024*1024+1))]){
  await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:createClaudeRuntimeHttpPort({url:'https://runtime.test',token:'synthetic',fetchImpl:async()=>res})})(context()),generic);
 }
});
test('runtime cannot mutate fixed request to accept a different model or archive scoped auth',async()=>{
 for(const attack of ['model','auth'])await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){const actualAuth=q.subscriptionAuth;if(attack==='model'){q.model='claude-other';q.session.model=q.model;}else q.subscriptionAuth='sk-ant-oat01-different_synthetic';const r=response(q);if(attack==='auth')Object.assign(r.session.data as object,{leaked:actualAuth});return r;}}})(context()),generic);
});
test('session accessors and toJSON are never invoked',async()=>{
 let invoked=0;const c=context();Object.defineProperty(c.session,'sequence',{enumerable:true,get(){invoked++;return 0;}});
 await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(r){return response(r);}}})(c),generic);assert.equal(invoked,0);
});
test('wait requires future wake time and HTTP cancellation interrupts ignored fetch',async()=>{
 const result=await createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){return {...response(q),outcome:'wait',wakeAt:Date.now()+10000};}}})(context());assert.equal(result.outcome,'wait');assert.equal(typeof result.wakeAt,'number');
 const c=context(),controller=new AbortController();c.signal=controller.signal;
 const pending=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:createClaudeRuntimeHttpPort({url:'http://[::1]:8123/iteration',token:'synthetic-private',fetchImpl:()=>new Promise(()=>{})})})(c);controller.abort(Error(auth));await assert.rejects(pending,generic);
 assert.throws(()=>createClaudeRuntimeHttpPort({url:'https://@example.com',token:'synthetic'}));
});
test('HTTP wire permits omitted optional child model while executor explicitly pins it',async()=>{
 let request:NativeClaudeRequest|undefined;await createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){request=q;return response(q);}}})(context());
 const {subagentModel:_child,...wire}=request!;
 const port=createClaudeRuntimeHttpPort({url:'https://runtime.test/iteration',token:'synthetic',fetchImpl:async(_url,init)=>new Response(JSON.stringify(response(JSON.parse(init!.body as string))))});
 assert.equal((await port.execute(wire,new AbortController().signal)).outcome,'complete');
});
test('rejects an explicit cross-task private bundle even if session and model match',async()=>{
 await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){const r=response(q);Object.assign(r.session.data as object,{taskId:'different-task'});return r;}}})(context()),generic);
});

test('requires full current execution lease bound to central task before runtime',async()=>{
 let calls=0;
 const executor=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){calls++;return response(q);}}});
 const mutations:((c:ReturnType<typeof context>)=>void)[]=[
 c=>{delete (c as Partial<typeof c>).executionLease;},
 c=>{c.executionLease.taskId='different-task';},
 c=>{c.executionLease.runId='';},c=>{c.executionLease.workerId='';},c=>{c.executionLease.token='';},
 c=>{c.executionLease.expiresAt=Date.now()-1;},c=>{c.executionLease.expiresAt=Infinity;},
 c=>{Object.assign(c.executionLease,{arbitrary:'unapproved'});},
 c=>{delete (c.executionLease as Partial<AutonomousLease>).workerId;},
 ];
 for(const mutate of mutations){const c=context();mutate(c);await assert.rejects(executor(c),generic);}
 assert.equal(calls,0);
});
test('private execution lease token cannot be archived or returned despite runtime mutation',async()=>{
 for(const mode of ['direct','mutated']){
  const c=context();const token=c.executionLease.token;
  await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){if(mode==='mutated')Object.assign(q,{executionLease:{...c.executionLease,token:'different-private-lease-token'}});const r=response(q);Object.assign(r.session.data as object,{leaked:token});return r;}}})(c),generic);
 }
});
test('lease structure remains outside private bundle on request and response',async()=>{
 const c=context();c.session=response({session:c.session,model:c.model} as NativeClaudeRequest).session;Object.assign(c.session.data as object,{executionLease:{...c.executionLease,token:'old-private-lease-token'}});
 let calls=0;const executor=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){calls++;return response(q);}}});await assert.rejects(executor(c),generic);assert.equal(calls,0);
 await assert.rejects(createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){const r=response(q);Object.assign(r.session.data as object,{executionLease:{...q.executionLease,token:'another-token'}});return r;}}})(context()),generic);
});
test('HTTP port rejects a missing execution lease without sending RPC',async()=>{
 let request:NativeClaudeRequest|undefined;await createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(q){request=q;return response(q);}}})(context());
 delete (request as Partial<NativeClaudeRequest>).executionLease;let calls=0;
 const port=createClaudeRuntimeHttpPort({url:'https://runtime.test',token:'synthetic',fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 await assert.rejects(port.execute(request!,new AbortController().signal),generic);assert.equal(calls,0);
});
test('R4 root executor rejects known parent and child aliases before runtime invocation',async()=>{
 let calls=0;const executor=createClaudeAutonomousExecutor({initialSnapshot:snapshot,runtime:{async execute(r){calls++;return response(r);}}});
 for(const alias of ['default','inherit','latest','best','opus','sonnet','haiku','opusplan'])for(const value of [alias,alias.toUpperCase()])for(const field of ['model','subagentModel']){
  const ctx=context();if(field==='model'){ctx.model=value;ctx.spec.model=value;ctx.session.model=value;}else{ctx.subagentModel=value;ctx.spec.subagentModel=value;}
  await assert.rejects(executor(ctx),generic);
 }assert.equal(calls,0);
});
test('R4 HTTP port rejects aliases before fetch and retains ordinary pin syntax',async()=>{
 let calls=0;const port=createClaudeRuntimeHttpPort({url:'https://runtime.test',token:'synthetic-transport',fetchImpl:async(_url,init)=>{calls++;return Response.json(response(JSON.parse(String(init!.body))));}});
 const ctx=context();const base:NativeClaudeRequest={version:1,taskId:ctx.taskId,executionLease:ctx.executionLease,model:ctx.model,subagentModel:ctx.model,tools:['Bash'],goal:ctx.spec.goal,session:ctx.session,subscriptionAuth:auth,maxRunMs:1000,initialSnapshot:snapshot};
 for(const alias of ['inherit','DEFAULT','opus','SONNET','latest','best','haiku','opusplan']){
  await assert.rejects(port.execute({...base,subagentModel:alias},ctx.signal),generic);
  await assert.rejects(port.execute({...base,model:alias,session:{...base.session,model:alias}},ctx.signal),generic);
 }assert.equal(calls,0);
 for(const model of ['123','Fable-1','vendor-opus-v3','sonnet-custom','latest-v2','default.custom'])assert.equal((await port.execute({...base,model,subagentModel:model,session:{...base.session,model}},ctx.signal)).session.model,model);
});
