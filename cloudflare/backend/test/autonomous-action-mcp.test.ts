import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,chmod,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';

import {createActionTool,createActionMcpServer,readActionPrivateInput,createAutonomousActionMcpConfig} from '../src/runtime/autonomous-action-mcp.ts';
const worker='TEST_ONLY_WORKER_CANARY_8fe4',leaseToken='TEST_ONLY_LEASE_CANARY_213b';
const runtimeId='12345678-1234-4234-8234-123456789012';
const payload={profileId:'spot',requestId:'request-1',operation:'aws.spot.start',parameters:{lifetimeMs:500}};
function input(origin='http://127.0.0.1:4310'):any {
  const now=Date.now();return {version:1,runtimeId,request:{taskId:'task-1',executionLease:{taskId:'task-1',runId:'run-1',workerId:'worker-1',token:leaseToken,expiresAt:now+60000},maxRunMs:60000,externalProfiles:['spot']},control:{origin,workerToken:worker}};
}
function feature(){assert.equal(typeof createActionTool,'function','private action tool must be implemented');}
function action(extra:Record<string,unknown>={}) {return {requestId:'request-1',phase:'broker',actionId:'action-1',status:'succeeded',upperBoundMicros:100,reservedMicros:100,verifiedCostMicros:null,billingFinal:false,cleanupStatus:'none',effect:'resource',evidenceId:'provider-receipt-1',ownershipToken:'NEVER_OWNERSHIP',idempotencyKey:'NEVER_IDEMPOTENCY',parameters:{secret:'NEVER_PARAMS'},...extra};}
type Context={after(fn:()=>unknown):void};
async function http(t:Context) {
  feature();const calls:{url:string;auth:string|undefined;body:any}[]=[];let reply:(req:any,res:any)=>void=(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(action()));};
  const server=createServer((req,res)=>{let raw='';req.on('data',c=>{raw+=c;});req.on('end',()=>{calls.push({url:req.url!,auth:req.headers.authorization,body:JSON.parse(raw)});reply(req,res);});});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return {calls,origin:`http://127.0.0.1:${address.port}`,setReply:(fn:typeof reply)=>{reply=fn;}};
}
async function privateFile(t:Context,value=input()) {
  const dir=await mkdtemp(join(tmpdir(),'hivemind-action-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'action.json');await writeFile(path,JSON.stringify(value),{mode:0o600});return {path,dir};
}

test('actual loopback HTTP receives canonical private identity and only projected output returns',async t=>{
  const h=await http(t),privateInput=input(h.origin);const tool=createActionTool(privateInput);const result=await tool(payload);
  assert.equal(result.isError,undefined);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0]!.url,'/v1/autonomous-tasks/task-1/external-action');assert.equal(h.calls[0]!.auth,'Bearer '+worker);
  assert.deepEqual(h.calls[0]!.body,{lease:privateInput.request.executionLease,runtimeId,request:payload});
  const serialized=JSON.stringify(result);for(const secret of [worker,leaseToken,runtimeId,'NEVER_OWNERSHIP','NEVER_IDEMPOTENCY','NEVER_PARAMS'])assert.ok(!serialized.includes(secret));
  const content=result.content[0];assert.ok(content&&content.type==='text');const data=JSON.parse(content.text);assert.equal(data.verifiedCostMicros,null);assert.equal(data.reservedMicros,100);assert.equal(data.requestId,'request-1');assert.equal(data.phase,'broker');assert.equal(data.actionId,'action-1');assert.equal(data.providerReceipt,undefined);
});

test('missing or empty canonical profiles disable calls with no fallback',async()=>{
  feature();for(const profiles of [undefined,[]]) {const config=input();if(profiles===undefined)delete config.request.externalProfiles;else config.request.externalProfiles=profiles;let calls=0;
    const tool=createActionTool(config,{fetchImpl:async()=>{calls++;return Response.json(action());}});
    assert.equal((await tool(payload)).isError,true);assert.equal(calls,0);
  }
});

test('model-crafted identity, unknown fields, URL, token and parameters never reach HTTP',async()=>{
  feature();let calls=0;const tool=createActionTool(input(),{fetchImpl:async()=>{calls++;return Response.json(action());}});
  const invalid=[{...payload,taskId:'other'},{...payload,executionLease:{token:worker}},{...payload,runtimeId},{...payload,revision:2},{...payload,url:'http://127.0.0.1'},{...payload,token:worker},{...payload,profileId:'other'},{...payload,operation:'shell'},{...payload,parameters:{lifetimeMs:1,command:worker}},{...payload,parameters:{lifetimeMs:0}},{...payload,[worker]:true}];
  for(const value of invalid) {const result=await tool(value);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(worker));}assert.equal(calls,0);
});

test('all fixed operations use constrained discriminated parameters',async()=>{
  feature();let calls=0;const tool=createActionTool(input(),{fetchImpl:async()=>{calls++;return Response.json(action());}});
  for(const value of [{...payload,operation:'aws.spot.inspect',parameters:{startActionId:'owned-start'}},{...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'bounded upload'}},{...payload,operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}}])assert.equal((await tool(value)).isError,undefined);
  assert.equal(calls,3);
});

test('HTTP redirects, HTTP failures and malformed responses remain generic without retries',async t=>{
  const h=await http(t);const tool=createActionTool(input(h.origin));
  for(const mode of ['redirect','failure','json','type','size','canary']) {
    h.setReply((_req,res)=>{if(mode==='redirect'){res.writeHead(307,{location:'/redirected'});res.end(worker);}else if(mode==='failure'){res.writeHead(403);res.end(worker);}else if(mode==='json'){res.end(worker);}else if(mode==='type'){res.end(JSON.stringify(action({verifiedCostMicros:-1})));}else if(mode==='size'){res.end('x'.repeat(65537));}else {res.end(JSON.stringify(action({actionId:worker})));}});
    const result=await tool(payload);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(worker));
  }assert.equal(h.calls.length,6);
});

test('request and streamed response sizes are strictly bounded',async()=>{
  feature();let calls=0;const tool=createActionTool(input(),{fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));c.close();}}));}});
  assert.equal((await tool({...payload,parameters:{message:'a'.repeat(70000)}})).isError,true);assert.equal(calls,0);
  assert.equal((await tool(payload)).isError,true);assert.equal(calls,1);
});

test('timeouts bound fetch and response body even when injected transport ignores AbortSignal',async()=>{
  feature();for(const stuckBody of [false,true]) {
    const tool=createActionTool(input(),{timeoutMs:20,fetchImpl:async()=>stuckBody?new Response(new ReadableStream({start(){},cancel(){}}),{headers:{'content-type':'application/json'}}):new Promise<Response>(()=>{})});
    const result=await Promise.race([tool(payload),new Promise<null>(r=>setTimeout(()=>r(null),300))]);assert.ok(result);assert.equal(result.isError,true);
  }
});

test('default trusted timeout permits forty seconds of pending guard/provider work within approved native window',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=Date.now(),calls=0,release:(response:Response)=>void=()=>{};let signal:AbortSignal|undefined;
  const config=input();config.request.maxRunMs=120000;config.executionDeadline=now+120000;config.request.executionLease.expiresAt=now+30000;
  const tool=createActionTool(config,{now:()=>now,fetchImpl:async(_url,init)=>{calls++;signal=init!.signal!;return new Promise<Response>(r=>{release=r;});}});
  try {
    const pending=tool(payload);await new Promise<void>(r=>setImmediate(r));now+=40000;t.mock.timers.tick(40000);assert.equal(signal?.aborted,false);
    release(Response.json(action()));assert.equal((await pending).isError,undefined);assert.equal(calls,1);
  }finally{t.mock.timers.reset();}
});

test('trusted 120s timeout is clipped to remaining approved deadline with no retry or new execution window',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let now=Date.now(),calls=0;const start=now,config=input();config.request.maxRunMs=120000;config.executionDeadline=start+30000;
  const tool=createActionTool(config,{timeoutMs:120000,now:()=>now,fetchImpl:async()=>{calls++;return new Promise<Response>(()=>{});}});
  try {
    now+=10000;const pending=tool(payload);await new Promise<void>(r=>setImmediate(r));now+=19999;t.mock.timers.tick(19999);now++;t.mock.timers.tick(1);
    assert.equal((await pending).isError,true);assert.equal(calls,1);assert.equal((await tool(payload)).isError,true);assert.equal(calls,1);
    assert.throws(()=>createActionTool({...config,executionDeadline:now+120000},{timeoutMs:120001,now:()=>now}));
  }finally{t.mock.timers.reset();}
});

test('model cannot set timeout and a response beyond absolute native deadline cannot become success',async()=>{
  let now=Date.now(),calls=0;const config=input();config.request.maxRunMs=120000;config.executionDeadline=now+30000;
  const tool=createActionTool(config,{now:()=>now,fetchImpl:async()=>{calls++;now=config.executionDeadline;return Response.json(action());}});
  assert.equal((await tool({...payload,timeoutMs:120000})).isError,true);assert.equal(calls,0);
  assert.equal((await tool(payload)).isError,true);assert.equal(calls,1);
});

test('lease expiry and total run deadline are not extended by another call',async()=>{
  feature();let now=Date.now(),calls=0;const config=input();config.request.maxRunMs=50;const tool=createActionTool(config,{now:()=>now,fetchImpl:async()=>{calls++;return Response.json(action());}});
  assert.equal((await tool(payload)).isError,undefined);now+=51;assert.equal((await tool(payload)).isError,true);assert.equal(calls,1);
  const expired=input();expired.request.executionLease.expiresAt=now-1;assert.throws(()=>createActionTool(expired,{now:()=>now}));
});

function renewableAuthority(){
  const engine=new AutonomousEngine();let now=3,calls=0;
  engine.create({requestId:'renewed-lease-fixture',goal:'synthetic lease bound',provider:'claude',model:'operator-pinned-model',endsAt:200000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['subscription-ref'],maxRunMs:120000,maxIterations:2},0,'task-1');engine.approve('task-1',1,'synthetic explicit approval',1);
  const original=engine.claim('task-1','worker-1',leaseToken,'run-1',2)!;const approved=engine.nativeStart(original,runtimeId,now);
  const config=input();config.executionDeadline=approved.deadline;config.request.executionLease=structuredClone(original);config.request.maxRunMs=120000;
  const fetchImpl:typeof fetch=async(_url,init)=>{
    calls++;const body=JSON.parse(String(init!.body));assert.deepEqual(body.lease,original);assert.equal(body.runtimeId,runtimeId);assert.equal(body.executionDeadline,undefined);assert.equal(body.request.executionDeadline,undefined);
    try{engine.nativeStart(body.lease,body.runtimeId,now);return Response.json(action());}catch{return Response.json({error:worker},{status:409});}
  };
  return {engine,config,original,approved,fetchImpl,now:()=>now,time:(value:number)=>{now=value;},calls:()=>calls};
}

test('approved immutable execution deadline permits T+40s actions after parent renews initial 30s lease',async()=>{
  const f=renewableAuthority(),tool=createActionTool(f.config,{now:f.now,fetchImpl:f.fetchImpl});
  f.time(25000);const renewed=f.engine.heartbeat(f.original,f.now());assert.ok(renewed.expiresAt>f.original.expiresAt);
  f.time(40000);assert.ok(f.original.expiresAt<f.now());assert.equal((await tool(payload)).isError,undefined);assert.equal(f.calls(),1);
  const lateSidecar=createActionTool(f.config,{now:f.now,fetchImpl:f.fetchImpl});assert.equal((await lateSidecar(payload)).isError,undefined);
  f.time(f.approved.deadline);assert.equal((await tool(payload)).isError,true);assert.equal((await lateSidecar(payload)).isError,true);assert.equal(f.calls(),2);
});

test('current central lease expiry or cancellation rejects action despite future private execution deadline',async()=>{
  for(const cancel of [false,true]){
    const f=renewableAuthority(),tool=createActionTool(f.config,{now:f.now,fetchImpl:f.fetchImpl});f.time(25000);f.engine.heartbeat(f.original,f.now());
    if(cancel){f.time(40000);f.engine.cancel('task-1','synthetic stop',f.now());}else f.time(60000);
    const result=await tool(payload);assert.equal(result.isError,true);assert.equal(f.calls(),1);assert.ok(!JSON.stringify(result).includes(worker));assert.ok(!JSON.stringify(result).includes(leaseToken));
  }
});

test('private execution deadline must be safe future bound and model cannot select it',async()=>{
  const start=Date.now();for(const value of [start,start-1,start+60001,NaN,Infinity,1.5,'later']){const config=input();config.executionDeadline=value;assert.throws(()=>createActionTool(config,{now:()=>start}));}
  const config=input();config.executionDeadline=start+50000;let calls=0;const tool=createActionTool(config,{now:()=>start,fetchImpl:async()=>{calls++;return Response.json(action());}});
  assert.equal((await tool({...payload,executionDeadline:start+999999})).isError,true);assert.equal(calls,0);
});

test('only exact control origins and matching private lease identity are accepted',()=>{
  feature();for(const origin of ['https://control.invalid/path','https://control.invalid?x=1','https://user:pass@control.invalid','http://remote.invalid','https://control.invalid#x','file:///tmp/x'])assert.throws(()=>createActionTool(input(origin)));
  const mismatch=input();mismatch.request.executionLease.taskId='other';assert.throws(()=>createActionTool(mismatch));
});

test('private input loader accepts 0600 regular owned file and rejects mode, links and size',async t=>{
  feature();const {path,dir}=await privateFile(t);assert.equal((await readActionPrivateInput(path)).request.taskId,'task-1');
  await chmod(path,0o644);await assert.rejects(readActionPrivateInput(path));await chmod(path,0o600);
  const symbolic=join(dir,'symbolic');await symlink(path,symbolic);await assert.rejects(readActionPrivateInput(symbolic));
  const hard=join(dir,'hard');await link(path,hard);await assert.rejects(readActionPrivateInput(path));await rm(hard);
  await writeFile(path,'x'.repeat(65537));await assert.rejects(readActionPrivateInput(path));
});

test('config helper exposes only fixed server and private path, with no auth environment',()=>{
  feature();const config=createAutonomousActionMcpConfig({command:'/usr/local/bin/node',args:['/opt/hivemind/backend/src/runtime/autonomous-action-mcp.ts'],privateInputPath:'/runtime/private/action.json'});
  assert.deepEqual(config,{mcpServers:{hivemind:{command:'/usr/local/bin/node',args:['/opt/hivemind/backend/src/runtime/autonomous-action-mcp.ts','--private-input','/runtime/private/action.json']}}});assert.ok(!JSON.stringify(config).includes(worker));
});

test('actual MCP SDK awaits deferred loopback reply, lists strict tool and rejects secret-bearing errors',async t=>{
  const h=await http(t);h.setReply((_req,res)=>{setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(action()));},10);});const server=createActionMcpServer(input(h.origin)),client=new Client({name:'action-test',version:'1.0.0'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
  assert.equal(client.getServerVersion()!.name,'hivemind');const {tools}=await client.listTools();assert.deepEqual(tools.map(x=>x.name),['action']);assert.equal(tools[0]!.inputSchema.additionalProperties,false);
  assert.equal((await client.callTool({name:'action',arguments:payload})).isError,undefined);
  for(const args of [{...payload,[worker]:true},{...payload,parameters:{[leaseToken]:worker}}]) {const result=await client.callTool({name:'action',arguments:args});assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(worker));assert.ok(!JSON.stringify(result).includes(leaseToken));}
  assert.equal(h.calls.length,1);
});

test('explicit stdio entry works through SDK without shell or import side effects',async t=>{
  const h=await http(t),{path}=await privateFile(t,input(h.origin));const module=fileURLToPath(new URL('../src/runtime/autonomous-action-mcp.ts',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:[module,'--private-input',path],stderr:'pipe'});let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  const client=new Client({name:'stdio-action-test',version:'1.0.0'});t.after(()=>client.close());await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['action']);assert.equal((await client.callTool({name:'action',arguments:payload})).isError,undefined);assert.equal(stderr,'');assert.equal(h.calls.length,1);
  assert.ok(resolve(module).endsWith('autonomous-action-mcp.ts'));
});

test('published schema requires exact discriminated operations and rejects unknown property branches',async t=>{
  const server=createActionMcpServer(input()),client=new Client({name:'schema-test',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
  const schema=(await client.listTools()).tools[0]!.inputSchema;
  assert.equal(schema.additionalProperties,false);
  const branches=schema.oneOf as {additionalProperties:boolean;properties:{operation:{const:string};parameters:{additionalProperties:boolean}}}[];
  assert.equal(branches.length,4);assert.deepEqual(branches.map(b=>b.properties.operation.const),['aws.spot.start','aws.spot.inspect','hf.model.commit','github.branch.push']);
  for(const branch of branches){assert.equal(branch.additionalProperties,false);assert.equal(branch.properties.parameters.additionalProperties,false);}
});

test('SDK protocol validation details and unknown tool names never reflect secret canaries',async t=>{
  let calls=0;const server=createActionMcpServer(input(),{fetchImpl:async()=>{calls++;return Response.json(action());}}),client=new Client({name:'protocol-test',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
  for(const params of [{name:{[worker]:leaseToken},arguments:payload},{name:'action',arguments:[worker]},{name:'action',arguments:payload,extra:worker}]){
    try {const result=await client.request({method:'tools/call',params} as never,CallToolResultSchema);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(worker));}
    catch(error){assert.ok(error instanceof Error);assert.ok(error.message.includes('External action unavailable or rejected.'));assert.ok(!error.message.includes(worker));assert.ok(!error.message.includes(leaseToken));}
  }
  assert.equal((await client.callTool({name:worker,arguments:payload})).isError,true);assert.equal(calls,0);
});

test('non-JSON HTTP content type is rejected even when body resembles a valid action',async t=>{
  const h=await http(t);h.setReply((_req,res)=>{res.setHeader('content-type','text/plain');res.end(JSON.stringify(action()));});
  assert.equal((await createActionTool(input(h.origin))(payload)).isError,true);
});

test('unapproved evidence and auth fields are discarded rather than exposed or hashed',async()=>{
  const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action({evidenceId:worker,auth:leaseToken,providerReceipt:{raw:worker}}))});
  const result=await tool(payload);assert.equal(result.isError,undefined);for(const secret of [worker,leaseToken])assert.ok(!JSON.stringify(result).includes(secret));
});

test('canonical partial intent DTO omits unmeasured action and financial fields without invented zero',async()=>{
  const tool=createActionTool(input(),{fetchImpl:async()=>Response.json({requestId:payload.requestId,phase:'intent'})});const result=await tool(payload);assert.equal(result.isError,undefined);
  assert.deepEqual(result.structuredContent,{requestId:'request-1',phase:'intent'});
});

test('financially inconsistent or mismatched canonical action DTO is rejected generically',async()=>{
  for(const extra of [{billingFinal:true,verifiedCostMicros:null},{billingFinal:true,verifiedCostMicros:undefined},{reservedMicros:101},{verifiedCostMicros:60,reservedMicros:50},{upperBoundMicros:-1},{requestId:'different-request'},{operation:'github.branch.push'},{phase:'settled',billingFinal:false},{phase:'cleaned',reservedMicros:1,verifiedCostMicros:20,billingFinal:true}]){
    const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action(extra))});const result=await tool(payload);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(worker));
  }
});

test('verified overrun remains an actual reported charge rather than being clamped to budget or zero',async()=>{
  const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action({phase:'settled',verifiedCostMicros:120,reservedMicros:0,billingFinal:true}))});const result=await tool(payload);assert.equal(result.isError,undefined);assert.equal(result.structuredContent?.verifiedCostMicros,120);
});

test('caller cancellation stops a stuck local HTTP response and never retries',async t=>{
  const h=await http(t);h.setReply(()=>{});const controller=new AbortController(),tool=createActionTool(input(h.origin));
  const pending=tool(payload,controller.signal);setTimeout(()=>controller.abort(),20);
  assert.equal((await pending).isError,true);assert.equal(h.calls.length,1);
});

test('private reader rejects malformed UTF-8 and a writable parent directory',async t=>{
  const {path,dir}=await privateFile(t);await writeFile(path,Buffer.from([0xff]));await assert.rejects(readActionPrivateInput(path));
  await writeFile(path,JSON.stringify(input()));await chmod(dir,0o777);await assert.rejects(readActionPrivateInput(path));await chmod(dir,0o700);
});

test('stdio closes malformed UTF-8, oversized frames and invalid JSON without secret reflection',async t=>{
  const {path}=await privateFile(t),module=fileURLToPath(new URL('../src/runtime/autonomous-action-mcp.ts',import.meta.url));
  for(const bytes of [Buffer.from([0xff,0x0a]),Buffer.from('x'.repeat(65537)),Buffer.from('{'+worker+'\n')]) {
    const child=spawn(process.execPath,[module,'--private-input',path],{stdio:['pipe','pipe','pipe']});let output='',errors='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});t.after(()=>{if(child.exitCode===null)child.kill();});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const closed=once(child,'close');child.stdin.end(bytes);
    try {await Promise.race([closed,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('stdio failed to close'));},2000);})]);}
    finally {if(timer)clearTimeout(timer);}
    assert.equal(output,'');assert.equal(errors,'');
  }
});

test('plain module import has no stdio, private file or process side effects',async()=>{
  const module=new URL('../src/runtime/autonomous-action-mcp.ts',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e','await import(process.argv[1])',module],{stdio:['pipe','pipe','pipe']});let output='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});child.stdin.end();
  const [code]=await once(child,'close');assert.equal(code,0);assert.equal(output,'');assert.equal(errors,'');
});

test('SDK sequential private GitHub pushes use the returned commit as the next expectedHead',async t=>{
  const heads=['a'.repeat(40),'b'.repeat(40),'c'.repeat(64)],requests:any[]=[];
  const server=createActionMcpServer(input(),{fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init!.body)).request;requests.push(request);
    assert.equal(request.parameters.expectedHead,heads[requests.length-1]);
    return Response.json(action({requestId:request.requestId,operation:'github.branch.push',effect:'retained',providerResult:{kind:'github_commit',oid:heads[requests.length]},providerReceipt:{auth:worker},operatorBillingEvidence:{reason:leaseToken}}));
  }}),client=new Client({name:'sequential-push-test',version:'1.0.0'}),[ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);t.after(async()=>{await client.close();await server.close();});
  let expectedHead=heads[0]!;
  for(let n=1;n<=2;n++){
    const result=await client.callTool({name:'action',arguments:{profileId:'spot',requestId:'push-'+n,operation:'github.branch.push',parameters:{artifactDigest:'d'.repeat(64),expectedHead}}});
    const data=result.structuredContent as Record<string,unknown>|undefined;
    assert.equal(result.isError,undefined);assert.deepEqual(data?.providerResult,{kind:'github_commit',oid:heads[n]});
    const content=result.content as {type:string;text:string}[];assert.deepEqual(JSON.parse(content[0]!.text),data);
    expectedHead=(data!.providerResult as {oid:string}).oid;
    const serialized=JSON.stringify(result);for(const secret of [worker,leaseToken,runtimeId,'NEVER_OWNERSHIP','NEVER_IDEMPOTENCY','NEVER_PARAMS','providerReceipt','operatorBillingEvidence'])assert.ok(!serialized.includes(secret));
  }
  assert.equal(requests.length,2);
  for(const operation of ['billing','operator.billing','external-actions/billing'])assert.equal((await client.callTool({name:'action',arguments:{...payload,operation}})).isError,true);
  assert.equal((await client.callTool({name:'hivemind_autonomous_record_external_cost',arguments:{}})).isError,true);
  assert.equal(requests.length,2);
});

test('only typed matching provider results on successful known receipts are exposed',async()=>{
  const cases=[
    {operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)},effect:'retained',providerResult:{kind:'github_commit',oid:'c'.repeat(40)}},
    {operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'},effect:'retained',providerResult:{kind:'hf_commit',oid:'d'.repeat(64)}},
    {operation:'aws.spot.start',parameters:{lifetimeMs:500},effect:'resource',providerResult:{kind:'aws_instance',id:'i-1234567890abcdef0'}},
    {operation:'aws.spot.inspect',parameters:{startActionId:'action-1'},effect:'none',providerResult:{kind:'aws_instance',id:'i-12345678'}},
  ];
  for(const c of cases){
    const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action({operation:c.operation,effect:c.effect,providerResult:c.providerResult}))});
    const result=await tool({...payload,operation:c.operation,parameters:c.parameters});assert.equal(result.isError,undefined);assert.deepEqual(result.structuredContent?.providerResult,c.providerResult);
  }
  const request={...payload,operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}};
  const good={kind:'github_commit',oid:'c'.repeat(40)};
  for(const extra of [
    {providerResult:{kind:'unknown',oid:'c'.repeat(40)}},{providerResult:{...good,oid:'c'.repeat(39)}},{providerResult:{...good,oid:'g'.repeat(40)}},
    {providerResult:{kind:'hf_commit',oid:'c'.repeat(40)}},{providerResult:{kind:'aws_instance',id:'i-12345678'}},
    {providerResult:{...good,auth:worker}},{providerResult:null},
    {status:'failed'},{status:'ambiguous'},{status:'dispatching'},{status:undefined},{phase:'intent'},{phase:'reserved'},{actionId:undefined},{operation:undefined},{effect:'unknown'},{effect:'resource'},{effect:'none'},
  ]){
    const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action({operation:request.operation,effect:'retained',providerResult:good,...extra}))});
    const result=await tool(request);assert.ok(result.isError===true||result.structuredContent?.providerResult===undefined);assert.ok(!JSON.stringify(result).includes(worker));
  }
  for(const providerResult of [{kind:'aws_instance',id:'i-xyz'},{kind:'aws_instance',id:'i-1234567'},{kind:'aws_instance',id:'i-'+'a'.repeat(33)}]){
    const tool=createActionTool(input(),{fetchImpl:async()=>Response.json(action({operation:payload.operation,providerResult}))});assert.equal((await tool(payload)).isError,true);
  }
  const config=input();config.control.workerToken='c'.repeat(16);
  const tool=createActionTool(config,{fetchImpl:async()=>Response.json(action({operation:request.operation,effect:'retained',providerResult:good}))});assert.equal((await tool(request)).isError,true);
});

test('inline artifact uploads with private identity before original action and verifies digest',async()=>{
  const artifact={files:[{path:'model.txt',contentBase64:Buffer.from('model').toString('base64')}]};
  for(const operation of ['hf.model.commit','github.branch.push']){
    const request={profileId:'spot',requestId:'inline-1',operation,parameters:operation==='hf.model.commit'?{artifactDigest:'a'.repeat(64),message:'upload'}:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)},artifact};
    const calls:any[]=[];const config=input();const tool=createActionTool(config,{fetchImpl:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init!.body))});return Response.json(calls.length===1?{artifactDigest:'a'.repeat(64)}:{requestId:request.requestId,phase:'intent'});}});
    assert.equal((await tool(request)).isError,undefined);assert.equal(calls.length,2);
    assert.ok(calls[0].url.endsWith('/external-artifact'));assert.deepEqual(calls[0].body,{lease:config.request.executionLease,runtimeId,profileId:'spot',artifact});
    const {artifact:_,...normal}=request;assert.deepEqual(calls[1].body.request,normal);
  }
});

test('artifact failure or digest mismatch prevents action and never echoes upload',async()=>{
  const request={...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'},artifact:{files:[{path:'model',contentBase64:'YQ=='}]}};
  for(const reply of [()=>Response.json({artifactDigest:'b'.repeat(64)}),()=>Response.json({error:worker},{status:403}),()=>Response.json({artifactDigest:'a'.repeat(64),raw:worker}),()=>Response.json({artifactDigest:'a'.repeat(64),extra:true})]){
    let calls=0;const tool=createActionTool(input(),{fetchImpl:async()=>{calls++;return reply();}});const result=await tool(request);assert.equal(result.isError,true);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(worker));
  }
});

test('artifact rejects empty malformed oversized forged and secret-bearing inputs before HTTP',async()=>{
  let calls=0;const tool=createActionTool(input(),{fetchImpl:async()=>{calls++;return Response.json({});}});
  const base={...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'}};
  const file={path:'model',contentBase64:'YQ=='};
  for(const artifact of [{files:[]},{files:Array(33).fill(file)},{files:[{...file,contentBase64:'%%%'}]},{files:[{...file,contentBase64:'YR=='}]},{files:[{...file,contentBase64:Buffer.alloc(262145).toString('base64')}]},{files:Array.from({length:5},(_,i)=>({path:String(i),contentBase64:Buffer.alloc(262144).toString('base64')}))},{files:[{...file,path:worker}]},{files:[{...file,contentBase64:Buffer.from(leaseToken).toString('base64')}]},{files:[file],runtimeId}])assert.equal((await tool({...base,artifact})).isError,true);
  assert.equal((await tool({...base,parameters:{...base.parameters,message:worker}})).isError,true);assert.equal(calls,0);
});

test('SDK stdio accepts bounded artifact above legacy cap with valid optional schema',async t=>{
  const h=await http(t);h.setReply((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/external-artifact')?{artifactDigest:'a'.repeat(64)}:{requestId:'request-1',phase:'intent'}));});
  const {path}=await privateFile(t,input(h.origin));const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/runtime/autonomous-action-mcp.ts',import.meta.url)),'--private-input',path],stderr:'pipe'});
  const client=new Client({name:'artifact-stdio',version:'1'});t.after(()=>client.close());await client.connect(transport);
  const schema=(await client.listTools()).tools[0]!.inputSchema;assert.ok(schema.properties?.artifact);assert.ok(!schema.required?.includes('artifact'));
  const request={...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'},artifact:{files:Array.from({length:4},(_,i)=>({path:'file'+i,contentBase64:Buffer.alloc(262144,97).toString('base64')}))}};
  assert.equal((await client.callTool({name:'action',arguments:request})).isError,undefined);assert.equal(h.calls.length,2);
});

test('artifact shares cancellation timeout and deadline across both hops',async()=>{
  const request={...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'},artifact:{files:[{path:'file',contentBase64:'YQ=='}]}};
  for(const mode of ['cancel','deadline','timeout','action-timeout']){
    let calls=0,now=Date.now();const config=input(),controller=new AbortController();config.executionDeadline=now+1000;
    const tool=createActionTool(config,{now:()=>now,timeoutMs:20,fetchImpl:async()=>{
      calls++;
      if(mode==='cancel')controller.abort();
      if(mode==='deadline')now=config.executionDeadline;
      if(mode==='timeout'||mode==='action-timeout'&&calls===2)return new Promise<Response>(()=>{});
      return Response.json({artifactDigest:'a'.repeat(64)});
    }});
    assert.equal((await tool(request,controller.signal)).isError,true);assert.equal(calls,mode==='action-timeout'?2:1);
  }
});

test('artifact response retains legacy cap and repeat upload preserves original requestId',async()=>{
  const request={...payload,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'},artifact:{files:[{path:'file',contentBase64:'YQ=='}]}};
  let calls=0;const rejected=createActionTool(input(),{fetchImpl:async()=>{calls++;return new Response(' '.repeat(65537),{headers:{'content-type':'application/json'}});}});
  assert.equal((await rejected(request)).isError,true);assert.equal(calls,1);
  const requests:any[]=[];const tool=createActionTool(input(),{fetchImpl:async(url,init)=>{requests.push(JSON.parse(String(init!.body)));return Response.json(String(url).endsWith('/external-artifact')?{artifactDigest:'a'.repeat(64)}:{requestId:request.requestId,phase:'intent'});}});
  for(let i=0;i<2;i++)assert.equal((await tool(request)).isError,undefined);
  assert.deepEqual(requests[0],requests[2]);assert.deepEqual(requests[1],requests[3]);assert.equal(requests[1].request.requestId,request.requestId);
});
