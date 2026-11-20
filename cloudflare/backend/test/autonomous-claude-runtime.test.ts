import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
test('synthetic unsafe boundary refuses before fake CLI',async()=>{
 let called=false;
 await assert.rejects(executeAutonomousClaude(request(),{authorizer:syntheticAuthorizer(),boundaryCheck:async()=>({verified:false} as never),runProcess:async()=>{called=true;throw Error();}}));assert.equal(called,false);
});
import {createAutonomousBootstrap} from '../src/runtime/autonomous-bootstrap.ts';
test('synthetic private HTTP authenticates before body and bounds concurrency',async()=>{
 const server=createAutonomousBootstrap({token:'private-test-token',execute:async()=>{throw Error('secret');}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address() as {port:number};
 try{const response=await fetch(`http://127.0.0.1:${addr.port}/iteration`,{method:'POST',body:'bad'});assert.equal(response.status,401);assert.equal(await response.text(),'{"error":"Unauthorized"}');}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSnapshot,sha256} from '../src/snapshot.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import type {NativeAuthorizer} from '../src/runtime/autonomous-authorize.ts';
import type {NativeClaudeRequest} from '../../../packages/contracts/src/autonomous-native.ts';
const sessionId='12345678-1234-4234-8234-123456789abc',model='Fable-1';
const boundary=async()=>({platform:'linux',checkedAt:new Date().toISOString(),capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000'])),noNewPrivs:1,verified:true});
const request=():NativeClaudeRequest=>({version:1,executionLease:{taskId:'test-task',runId:'run-test',workerId:'worker-test',token:'lease-test',expiresAt:Date.now()+30000},taskId:'test-task',model,subagentModel:model,tools:['Bash','Agent'],goal:'synthetic test',session:{sessionId,model,sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-auth-token',maxRunMs:1000,initialSnapshot:createSnapshot([{path:'hello.txt',content:Buffer.from('hello').toString('base64'),sha256:sha256('hello'),executable:false}])});
test('synthetic fake CLI restores parent, child and workspace in fresh physical runtime',async()=>{
 const roots:string[]=[];let iteration=0;
 try{
 const execute=async(r:NativeClaudeRequest,usageMissing=false,reportedModel=model)=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'autonomous-fake-'));roots.push(root);const home=join(root,'home'),workspace=join(root,'workspace');
  return executeAutonomousClaude(r,{authorizer:syntheticAuthorizer(),home,workspace,boundaryCheck:boundary,verifyPrerequisites:async()=>{},runProcess:async(argv,opts)=>{
   assert.equal(argv.includes('--restricted'),true);assert.equal(argv.includes('--setting-sources='),true);assert.equal(argv.some(x=>x===''),false);assert.equal(argv[argv.indexOf('--model')+1],model);
   assert.equal(argv[argv.indexOf('--allowedTools')+1],'Bash,Agent');assert.equal(argv.includes('mcp__phase0__phase0_probe'),false);
   assert.equal(JSON.parse(argv[argv.indexOf('--agents')+1]!).worker.model,model);
   assert.deepEqual(JSON.parse(await readFile(join(home,'.hivemind-phase0/mcp.json'),'utf8')),{mcpServers:{}});
   assert.equal(opts.env.CLAUDE_CODE_OAUTH_TOKEN,r.subscriptionAuth);assert.equal(opts.env.CONTROL_TOKEN,undefined);assert.equal(opts.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN,undefined);assert.equal(opts.env.HIVEMIND_CONTROL_API_URL,undefined);assert.equal(opts.env.AWS_ACCESS_KEY_ID,undefined);
   const project=autonomousProjectDirectory(home);await mkdir(join(project,sessionId,'subagents'),{recursive:true});
   if(iteration===0){assert.equal(argv[argv.indexOf('--session-id')+1],sessionId);await writeFile(join(project,sessionId+'.jsonl'),'{}\n');await writeFile(join(project,sessionId,'subagents/agent-child.jsonl'),'{}\n');await writeFile(join(workspace,'hello.txt'),'changed');}
   else{assert.equal(argv[argv.indexOf('--resume')+1],sessionId);assert.equal(await readFile(join(workspace,'hello.txt'),'utf8'),'changed');assert.equal(await readFile(join(project,sessionId,'subagents/agent-child.jsonl'),'utf8'),'{}\n');}
   const usage={input_tokens:12,cache_read_input_tokens:7,cache_creation_input_tokens:3,...(!usageMissing?{output_tokens:2}:{})};
   return {status:'passed',exitCode:0,stderr:'',stdout:JSON.stringify({type:'system',subtype:'init',session_id:sessionId,model:reportedModel})+'\n'+JSON.stringify({type:'result',session_id:sessionId,subtype:'success',is_error:false,result:'{"outcome":"continue"}',usage}),durationMs:1,truncated:false};
  }});
 };
 const first=await execute(request());assert.equal(first.session.sequence,1);assert.deepEqual(first.usage,{inputTokens:12,cacheReadTokens:7,cacheWriteTokens:3,outputTokens:2});iteration++;
 const next={...request(),session:first.session};delete next.initialSnapshot;const second=await execute(next);assert.equal(second.session.sequence,2);assert.equal(second.session.sessionId,sessionId);
 await assert.rejects(execute({...next,session:second.session},true));await assert.rejects(execute({...next,session:second.session},false,'wrong-model'));
 }finally{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));}
});
import {verifyAutonomousPrerequisiteFiles} from '../src/runtime/autonomous-claude.ts';
import {createHash} from 'node:crypto';
test('synthetic production packaging accepts only expected immutable npm executable links',async()=>{
 const bytes=await readFile(new URL('../config/claude-managed-settings.json',import.meta.url),'utf8');let wrongTarget=false;
 const files={lstat:async(path:string)=>({uid:0,mode:0o755,isSymbolicLink:()=>['/usr/local/bin/claude','/usr/local/bin/codex'].includes(path)}),realpath:async(path:string)=>wrongTarget?'/tmp/evil':path.endsWith('claude')?'/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js':'/usr/local/lib/node_modules/@openai/codex/bin/codex.js',readFile:async(path:string)=>path==='/etc/claude-code/managed-settings.json'?bytes:path==='/opt/hivemind/backend/runtime-build.json'?JSON.stringify({files:{'backend/config/claude-managed-settings.json':createHash('sha256').update(bytes).digest('hex')}}):Promise.reject(Error('not in image'))};
 await assert.doesNotReject(verifyAutonomousPrerequisiteFiles(files));wrongTarget=true;await assert.rejects(verifyAutonomousPrerequisiteFiles(files));
});
test('prerequisite check pins the tool audit hooks: Pre blocks, Post never blocks, none may be missing',async()=>{
 const original=await readFile(new URL('../config/claude-managed-settings.json',import.meta.url),'utf8');
 const attempt=async(mutate:(s:any)=>void)=>{const settings=JSON.parse(original);mutate(settings);const bytes=JSON.stringify(settings);
  const files={lstat:async(path:string)=>({uid:0,mode:0o755,isSymbolicLink:()=>['/usr/local/bin/claude','/usr/local/bin/codex'].includes(path)}),realpath:async(path:string)=>path.endsWith('claude')?'/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js':'/usr/local/lib/node_modules/@openai/codex/bin/codex.js',readFile:async(path:string)=>path==='/etc/claude-code/managed-settings.json'?bytes:path==='/opt/hivemind/backend/runtime-build.json'?JSON.stringify({files:{'backend/config/claude-managed-settings.json':createHash('sha256').update(bytes).digest('hex')}}):Promise.reject(Error('not in image'))};
  return verifyAutonomousPrerequisiteFiles(files);};
 await assert.doesNotReject(attempt(()=>{}));
 await assert.rejects(attempt(s=>{delete s.hooks.PostToolUse;}));
 await assert.rejects(attempt(s=>{delete s.hooks.PostToolUseFailure;}));
 await assert.rejects(attempt(s=>{s.hooks.PreToolUse=s.hooks.PreToolUse.filter((h:any)=>h.matcher!=='.*');}));
 await assert.rejects(attempt(s=>{delete s.hooks.PreToolUse.find((h:any)=>h.matcher==='.*').hooks[0].onFailure;}));
 await assert.rejects(attempt(s=>{s.hooks.PostToolUse[0].hooks[0].onFailure='block';}));
 await assert.rejects(attempt(s=>{s.hooks.PostToolUse[0].hooks[0].command+=' extra';}));
});
test('bootstrap object listen overload binds loopback and rejects concurrent iterations',async()=>{
 let release!:(v:never)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
 const server=createAutonomousBootstrap({token:'private-test-token',execute:async()=>{started();return new Promise<never>(r=>{release=r;});}});await new Promise<void>(r=>server.listen({port:0},r));
 const address=server.address() as {port:number;address:string};assert.equal(address.address,'127.0.0.1');const url=`http://127.0.0.1:${address.port}/iteration`,headers={authorization:'Bearer private-test-token'};
 try{const first=fetch(url,{method:'POST',headers,body:'{}'});await ready;const second=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(second.status,409);release({} as never);assert.equal((await first).status,200);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
import {request as httpRequest} from 'node:http';
test('private HTTP disconnect propagates abort and keeps lane occupied until executor settles',async()=>{
 let started!:()=>void,aborted!:()=>void,finish!:()=>void;const ready=new Promise<void>(r=>{started=r;}),cancelled=new Promise<void>(r=>{aborted=r;}),settle=new Promise<void>(r=>{finish=r;});
 const server=createAutonomousBootstrap({token:'private-test-token',execute:async(_r,signal)=>{started();signal.addEventListener('abort',()=>aborted(),{once:true});await settle;throw Error('withheld');}});await new Promise<void>(r=>server.listen(0,r));const port=(server.address() as {port:number}).port;
 try{const request=httpRequest({host:'127.0.0.1',port,path:'/iteration',method:'POST',headers:{authorization:'Bearer private-test-token'} });request.on('error',()=>{});request.end('{}');await ready;request.destroy();await cancelled;
 const blocked=await fetch(`http://127.0.0.1:${port}/iteration`,{method:'POST',headers:{authorization:'Bearer private-test-token'},body:'{}'});assert.equal(blocked.status,409);finish();
 }finally{finish();await new Promise<void>(r=>server.close(()=>r()));}
});
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('opt-in direct entry requires token before listening and prints no environment secrets',()=>{
 const env={...process.env};delete env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN;
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../src/runtime/autonomous-bootstrap.ts',import.meta.url))],{env,encoding:'utf8',timeout:3000});
 assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr,'Autonomous runtime could not start\n');
});
test('native wire cannot select testing seams or unapproved tool subsets',async()=>{
 let called=false;const opts={boundaryCheck:boundary,verifyPrerequisites:async()=>{},runProcess:async()=>{called=true;throw Error();}};
 for(const tools of [[],['Agent'],['Bash','Bash'],['Bash','WebFetch']])await assert.rejects(executeAutonomousClaude({...request(),tools},opts));
 await assert.rejects(executeAutonomousClaude({...request(),verifyPrerequisites:true} as never,opts));assert.equal(called,false);
});
import {guardCanonicalNativePolicy} from '../src/runtime/autonomous-authorize.ts';
test('canonical approval is exact and cannot be replaced by private RPC input',()=>{
 const r=request(),spec={requestId:'req',goal:r.goal,provider:'claude' as const,model:r.model,endsAt:Date.now()+60000,budgetMicros:10,tools:r.tools,systems:[],credentialIds:['credential'],maxRunMs:r.maxRunMs,maxIterations:2};
 assert.doesNotThrow(()=>guardCanonicalNativePolicy(r,{taskId:r.taskId,spec,deadline:spec.endsAt}));assert.doesNotThrow(()=>guardCanonicalNativePolicy({...r,tools:[...r.tools].reverse()},{taskId:r.taskId,spec,deadline:spec.endsAt}));
 for(const changed of [{goal:'changed'},{model:'other'},{tools:['Bash']},{subagentModel:'unapproved-child'},{maxRunMs:2000}])assert.throws(()=>guardCanonicalNativePolicy({...r,...changed},{taskId:r.taskId,spec,deadline:spec.endsAt}));
 assert.throws(()=>guardCanonicalNativePolicy(r,{taskId:r.taskId,spec:{...spec,systems:['network']},deadline:spec.endsAt}));
 assert.throws(()=>guardCanonicalNativePolicy({...r,session:{...r.session,sequence:1}},{taskId:r.taskId,spec,deadline:spec.endsAt}));
});

function syntheticAuthorizer():NativeAuthorizer{return {async start(r){return {taskId:r.taskId,spec:{requestId:'synthetic',goal:r.goal,provider:'claude',model:r.model,...(r.subagentModel?{subagentModel:r.subagentModel}:{}),tools:r.tools,systems:[],credentialIds:['synthetic'],maxRunMs:r.maxRunMs,maxIterations:10,endsAt:Date.now()+60000,budgetMicros:10},deadline:Date.now()+r.maxRunMs,...(r.session.sequence>0?{checkpoint:{sessionId:r.session.sessionId,model:r.model,sequence:r.session.sequence,objectKey:'synthetic'}}:{})};},async heartbeat(lease){return {...lease,expiresAt:Date.now()+30000};}};}
import {createNativeHttpAuthorizer} from '../src/runtime/autonomous-authorize.ts';
test('trusted HTTP authorizer posts full lease, pins canonical policy and bounds response',async()=>{
 const r=request();r.executionLease.expiresAt=Date.now()-1000;const approved=await syntheticAuthorizer().start(r,'ignored',new AbortController().signal);let calls=0;
 const authorizer=createNativeHttpAuthorizer({url:'http://127.0.0.1:4321',token:'worker-transport-secret',fetchImpl:async(url,init)=>{
  calls++;assert.equal(init!.redirect,'error');assert.equal((init!.headers as Record<string,string>).authorization,'Bearer worker-transport-secret');const body=JSON.parse(init!.body as string);
  if(String(url).endsWith('native-start')){assert.deepEqual(body,{lease:r.executionLease,runtimeId:sessionId});return Response.json(approved);}
  assert.equal(String(url),'http://127.0.0.1:4321/v1/autonomous-tasks/test-task/heartbeat');assert.deepEqual(body,{lease:r.executionLease});return Response.json({...r.executionLease,expiresAt:Date.now()+30000});
 }});
 assert.deepEqual(await authorizer.start(r,sessionId,new AbortController().signal),approved);await authorizer.heartbeat(r.executionLease,new AbortController().signal);assert.equal(calls,2);
 for(const body of [{}, {...approved,spec:{...approved.spec,goal:'tampered'}}]){const bad=createNativeHttpAuthorizer({url:'https://control.example',token:'secret',fetchImpl:async()=>Response.json(body)});await assert.rejects(bad.start(r,sessionId,new AbortController().signal));}
 const oversize=createNativeHttpAuthorizer({url:'https://control.example',token:'secret',fetchImpl:async()=>new Response('x'.repeat(65537))});await assert.rejects(oversize.start(r,sessionId,new AbortController().signal));
 for(const url of ['http://control.example','https://user:password@control.example','https://control.example?token=secret'])assert.throws(()=>createNativeHttpAuthorizer({url,token:'secret'}));
});
test('authorization rejection happens before boundary checks, filesystem or fake CLI',async()=>{
 let boundaryCalled=false,cliCalled=false;
 await assert.rejects(executeAutonomousClaude(request(),{authorizer:{start:async()=>{throw Error('no approved lease');},heartbeat:async()=>{throw Error();}},boundaryCheck:async()=>{boundaryCalled=true;return boundary();},runProcess:async()=>{cliCalled=true;throw Error();}}));
 assert.equal(boundaryCalled,false);assert.equal(cliCalled,false);
});
test('synthetic heartbeat rejection aborts CLI and waits for fake child completion',async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});const root=await mkdtemp(join(await realpath(tmpdir()),'heartbeat-fake-'));let beats=0,childStopped=false;
 const r={...request(),maxRunMs:10000},authorizer=syntheticAuthorizer();authorizer.heartbeat=async()=>{beats++;throw Error('cancelled centrally');};
 try{await assert.rejects(executeAutonomousClaude(r,{home:join(root,'home'),workspace:join(root,'workspace'),authorizer,boundaryCheck:boundary,verifyPrerequisites:async()=>{},runProcess:async(_args,opts)=>{
  const aborted=new Promise<void>(resolve=>opts.signal!.addEventListener('abort',()=>resolve(),{once:true}));t.mock.timers.tick(5000);await aborted;await new Promise<void>(resolve=>setImmediate(resolve));childStopped=true;
  return {status:'error',exitCode:null,stdout:'',stderr:'',durationMs:1,truncated:false};
 }}));assert.equal(beats,1);assert.equal(childStopped,true);}finally{t.mock.timers.reset();await rm(root,{recursive:true,force:true});}
});
test('synthetic core deadline bounds actual CLI even if maxRunMs allows longer',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'deadline-fake-'));const authorizer=syntheticAuthorizer(),start=authorizer.start;authorizer.start=async(...args)=>({...await start(...args),deadline:Date.now()+100});let timedOut=false;
 try{await assert.rejects(executeAutonomousClaude(request(),{home:join(root,'home'),workspace:join(root,'workspace'),authorizer,boundaryCheck:boundary,verifyPrerequisites:async()=>{},runProcess:async(_args,opts)=>{
  assert.ok(opts.timeoutMs<=100&&opts.timeoutMs>0);await new Promise<void>(resolve=>{const keepAlive=setTimeout(resolve,500);opts.signal!.addEventListener('abort',()=>{timedOut=true;clearTimeout(keepAlive);resolve();},{once:true});});return {status:'error',exitCode:null,stdout:'',stderr:'',durationMs:1,truncated:false};
 }}));assert.equal(timedOut,true);}finally{await rm(root,{recursive:true,force:true});}
});
test('bootstrap generates one runtime identity per server and does not accept wire override',async()=>{
 const seen:string[]=[];const make=()=>createAutonomousBootstrap({token:'private-test-token',execute:async(_r,_s,id)=>{seen.push(id);return {} as never;}});const servers=[make(),make()];
 try{for(const server of servers){await new Promise<void>(r=>server.listen(0,r));const port=(server.address() as {port:number}).port;for(let i=0;i<2;i++)await fetch(`http://127.0.0.1:${port}/iteration`,{method:'POST',headers:{authorization:'Bearer private-test-token'},body:'{"runtimeId":"attacker"}'});}
 assert.equal(seen[0],seen[1]);assert.equal(seen[2],seen[3]);assert.notEqual(seen[0],seen[2]);assert.notEqual(seen[0],'attacker');
 }finally{await Promise.all(servers.map(s=>new Promise<void>(r=>s.close(()=>r()))));}
});

test('native runtime accepts consistent repeated root init but pins every model and root scope',async()=>{
 const run=async(patch:Record<string,unknown>={})=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'native-init-review-')),home=join(root,'home'),workspace=join(root,'workspace');
  try{return await executeAutonomousClaude(request(),{authorizer:syntheticAuthorizer(),home,workspace,boundaryCheck:boundary,verifyPrerequisites:async()=>{},runProcess:async()=>{
   const project=autonomousProjectDirectory(home);await mkdir(project,{recursive:true});await writeFile(join(project,sessionId+'.jsonl'),'{}\n');
   const init={type:'system',subtype:'init',session_id:sessionId,model};
   const result={type:'result',session_id:sessionId,subtype:'success',is_error:false,result:'{"outcome":"continue"}',usage:{input_tokens:1,cache_read_input_tokens:2,cache_creation_input_tokens:3,output_tokens:4}};
   return {status:'passed',exitCode:0,stderr:'',stdout:[init,{...init,...patch},result].map(x=>JSON.stringify(x)).join('\n'),durationMs:1,truncated:false};
  }});}finally{await rm(root,{recursive:true,force:true});}
 };
 assert.equal((await run()).session.sessionId,sessionId);
 for(const patch of [{model:'other-model'},{session_id:'87654321-1234-4234-8234-123456789abc'},{parent_tool_use_id:'toolu_child'},{parent_tool_use_id:''}])await assert.rejects(run(patch));
});
