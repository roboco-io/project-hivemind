import test from 'node:test';
import assert from 'node:assert/strict';
import {autonomousToolGate,validateAutonomousPolicy} from '../src/runtime/autonomous-tool-hook.ts';
import {guardCanonicalNativePolicy} from '../src/runtime/autonomous-authorize.ts';
import {validateAutonomousCloudInput} from '../src/autonomous-cloud-protocol.ts';
import type {NativeClaudeRequest} from '../../../packages/contracts/src/autonomous-native.ts';
import {createSnapshot} from '../src/snapshot.ts';
const action='mcp__hivemind__action',sessionId='12345678-1234-4234-8234-123456789abc';
const policy={version:1 as const,model:'pinned',subagentModel:'child',tools:['Bash','Agent','WebFetch',action],web:{allowedHosts:['docs.example.com']},externalProfiles:['aws-profile','hf-profile','github-profile']};
function request():NativeClaudeRequest{return {version:1,taskId:'task',executionLease:{taskId:'task',runId:'run',workerId:'worker',token:'fixture-lease',expiresAt:Date.now()+60000},model:'pinned',subagentModel:'child',goal:'work',tools:policy.tools,session:{sessionId,model:'pinned',sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-fixture-token',maxRunMs:10000,initialSnapshot:createSnapshot([]),...{web:policy.web,externalProfiles:policy.externalProfiles}};}
test('managed policy binds WebFetch to exact HTTPS hosts and MCP to profile IDs',()=>{
 assert.deepEqual(validateAutonomousPolicy(policy),policy);
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:'WebFetch',tool_input:{url:'https://docs.example.com/a',prompt:'read'}},policy));
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:action,tool_input:{profileId:'aws-profile'}},policy));
 for(const url of ['http://docs.example.com','https://other.example.com','https://docs.example.com:444','https://user@docs.example.com','https://127.0.0.1'])assert.throws(()=>autonomousToolGate({tool_name:'WebFetch',tool_input:{url,prompt:'read'}},policy));
 assert.throws(()=>autonomousToolGate({tool_name:action,tool_input:{profileId:'unapproved'}},policy));
 assert.throws(()=>autonomousToolGate({tool_name:'WebFetch',tool_input:{url:'https://docs.example.com',prompt:'read'}},undefined));
});
test('native canonical authorization deep compares approved web and profiles',()=>{
 const r=request(),approved={taskId:'task',deadline:Date.now()+10000,spec:{requestId:'request',goal:r.goal,provider:'claude' as const,model:r.model,subagentModel:r.subagentModel,endsAt:Date.now()+60000,budgetMicros:100,maxRunMs:r.maxRunMs,maxIterations:4,tools:r.tools,systems:['aws','hf','github'],credentialIds:['subscription'],web:policy.web,externalProfiles:policy.externalProfiles}};
 assert.equal(guardCanonicalNativePolicy(r,approved),approved);
 assert.throws(()=>guardCanonicalNativePolicy({...r,...{web:{allowedHosts:['other.example.com']}}},approved));
 assert.throws(()=>guardCanonicalNativePolicy({...r,...{externalProfiles:['other']}},approved));
});
test('private envelope accepts only trusted outer gates and strict request capability scopes',()=>{
 const input={version:1,jobId:'job',attempt:sessionId,runtimeId:sessionId,allowWebFetch:true,quotaPauseEnabled:true,request:request(),control:{origin:'https://control.example.com',workerToken:'fixture-worker',reporterToken:'fixture-reporter'},authReturnPublicKey:'-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----'};
 assert.equal(validateAutonomousCloudInput(input),input);
 for(const r of [{...input.request,executionDeadline:Date.now()+120000},{...input.request,quotaPauseEnabled:true},{...input.request,allowWebFetch:true},{...input.request,web:{...policy.web,secret:'no'}}])assert.throws(()=>validateAutonomousCloudInput({...input,request:r}));
});
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {mkdtemp,realpath,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('native CLI receives only scoped MCP config and dedicated private projection',async(t)=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'policy-native-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const r=request(),home=join(root,'home'),workspace=join(root,'workspace'),workerToken='fixture-action-worker';let calls=0;
 const approved={taskId:r.taskId,deadline:Date.now()+10000,spec:{requestId:'request',goal:r.goal,provider:'claude' as const,model:r.model,subagentModel:r.subagentModel,endsAt:Date.now()+60000,budgetMicros:100,maxRunMs:r.maxRunMs,maxIterations:4,tools:r.tools,systems:['aws','hf','github'],credentialIds:['subscription'],web:policy.web,externalProfiles:policy.externalProfiles}};
 const options={runtimeId:sessionId,allowWebFetch:true,actionChannel:{origin:'https://control.example.com',workerToken},authorizer:{start:async()=>approved,heartbeat:async(lease:NativeClaudeRequest['executionLease'])=>lease},home,workspace,verifyPrerequisites:async()=>{},boundaryCheck:async()=>({platform:'linux' as const,checkedAt:'synthetic',verified:true,noNewPrivs:1 as const,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),runProcess:async(argv:string[],opts:{env:NodeJS.ProcessEnv})=>{
  calls++;assert.equal(argv[argv.indexOf('--tools')+1],'Bash,Agent,WebFetch');assert.equal(argv[argv.indexOf('--allowedTools')+1],r.tools.join(','));
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--agents')+1]!).worker.tools,['Bash']);
  const config=JSON.parse(await readFile(argv[argv.indexOf('--mcp-config')+1]!,'utf8'));
  const args=config.mcpServers.hivemind.args as string[],path=args.at(-1)!;
  assert.deepEqual(args.slice(0,-1),['/opt/hivemind/backend/src/runtime/autonomous-action-mcp.ts','--private-input']);
  assert.equal((await stat(path)).mode&0o777,0o600);
  const input=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(Object.keys(input).sort(),['control','executionDeadline','request','runtimeId','version']);assert.equal(input.executionDeadline,approved.deadline);assert.deepEqual(input.request.executionLease,r.executionLease);assert.deepEqual(Object.keys(input.request).sort(),['executionLease','externalProfiles','maxRunMs','taskId']);assert.equal(input.control.workerToken,workerToken);assert.equal(input.request.subscriptionAuth,undefined);
  assert.equal(JSON.stringify(argv).includes(workerToken),false);assert.equal(JSON.stringify(opts.env).includes(workerToken),false);
  const p=autonomousProjectDirectory(home);await mkdir(p,{recursive:true});await writeFile(join(p,sessionId+'.jsonl'),'{}\n');
  return {status:'passed' as const,exitCode:0,stderr:'',durationMs:1,truncated:false,stdout:JSON.stringify({type:'system',subtype:'init',session_id:sessionId,model:r.model})+'\n'+JSON.stringify({type:'result',session_id:sessionId,subtype:'success',is_error:false,result:'{"outcome":"continue"}',usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}})};
 }};
 await executeAutonomousClaude(r,options);assert.equal(calls,1);
 const r2={...r,session:{...r.session,sessionId:'87654321-1234-4234-8234-123456789abc'}};
 await assert.rejects(executeAutonomousClaude(r2,{...options,allowWebFetch:false,home:join(root,'denied-home'),workspace:join(root,'denied-workspace')}));assert.equal(calls,1);
});
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'),shortCircuit:true};
 if(specifier==='cloudflare:sockets')return {url:'data:text/javascript,'+encodeURIComponent('export const connect=(...args)=>Reflect.get(globalThis,"syntheticNativeWebConnector")(...args);'),shortCircuit:true};
 return next(specifier,context);
}});
test('actual native entrypoint uses per-container grant with synthetic DNS and IP-pinned TLS',async(t)=>{
 const {NativeClaudeOutbound}=await import('../src/cloudflare/worker.ts');
 const env={AUTONOMOUS_CONTROL_ORIGIN:'https://control.example.com',AUTONOMOUS_WEB_ENABLED:'true',AUTONOMOUS_WEB_ALLOWED_HOSTS:'docs.example.com,other.example.com'};
 let queries=0;const addresses:unknown[]=[],sni:string[]=[];
 Reflect.set(globalThis,'syntheticNativeWebConnector',(address:unknown)=>{addresses.push(address);const tls={opened:Promise.resolve(),closed:Promise.resolve(),readable:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'));c.close();}}),writable:new WritableStream({write(){}}),async close(){}};return {...tls,startTls({expectedServerHostname}:{expectedServerHostname:string}){sni.push(expectedServerHostname);return tls;}};});
 t.after(()=>Reflect.deleteProperty(globalThis,'syntheticNativeWebConnector'));
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{queries++;const url=new URL(String(input));assert.equal(url.origin,'https://cloudflare-dns.com');const name=url.searchParams.get('name')!,type=url.searchParams.get('type')==='A'?1:28;return Response.json({Status:0,TC:false,Question:[{name,type}],Answer:[{name,type,TTL:1,data:type===1?'93.184.216.34':'2606:4700:4700::1111'}]});});
 function entry(host:string,enabled='true'){return new NativeClaudeOutbound({props:{webGrant:{taskId:host,jobId:'job',attempt:'attempt',expiresAt:Date.now()+60000,allowedHosts:[host]}}} as never,{...env,AUTONOMOUS_WEB_ENABLED:enabled} as never);}
 const a=entry('docs.example.com'),b=entry('other.example.com');
 assert.equal(await (await a.fetch(new Request('https://docs.example.com/a'))).text(),'hello');
 assert.equal((await a.fetch(new Request('https://other.example.com',{headers:{'x-hivemind-web-hosts':'other.example.com'}}))).status,403);
 assert.equal(queries,2);assert.equal(addresses.length,1);
 assert.equal(await (await b.fetch(new Request('https://other.example.com/b'))).text(),'hello');
 assert.deepEqual(addresses,[{hostname:'93.184.216.34',port:443},{hostname:'93.184.216.34',port:443}]);assert.deepEqual(sni,['docs.example.com','other.example.com']);
 assert.equal((await entry('docs.example.com','false').fetch(new Request('https://docs.example.com'))).status,403);assert.equal(queries,4);
});
import {runAutonomousFromFile,writeNativePrivate,NATIVE_FILES} from '../src/runtime/autonomous-from-file.ts';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
test('private file bootstrap forwards trusted web quota and action channel without adding request secrets',async(t)=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'policy-fromfile-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),r=request();
 const input={version:1,jobId:'job',attempt:sessionId,runtimeId:sessionId,allowWebFetch:true,quotaPauseEnabled:true,request:r,control:{origin:'https://control.example.com',workerToken:'fixture-worker',reporterToken:'fixture-reporter'},authReturnPublicKey:pair.publicKey.export({format:'pem',type:'spki'}).toString()};
 await writeNativePrivate(join(dir,NATIVE_FILES.input),input);
 const result=await runAutonomousFromFile(dir,{execute:async(req,options)=>{assert.deepEqual(req,r);assert.equal(options?.allowWebFetch,true);assert.equal(options?.quotaPauseEnabled,true);assert.equal(options?.reporter?.quotaPauseEnabled,true);assert.deepEqual(options?.actionChannel,{origin:input.control.origin,workerToken:input.control.workerToken});return {version:1,session:{...r.session,sequence:1,data:{version:1,sessionId,model:r.model,workspacePath:'/workspace',snapshot:createSnapshot([]),transcripts:[{path:sessionId+'.jsonl',content:'{}\n'}]}},usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},outcome:'continue',boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};}});
 assert.equal(result?.ok,true);
});
import {AutonomousEngine} from '../../../packages/core/src/autonomous.ts';
import {AutonomousService,type AutonomousStorage} from '../src/autonomous-service.ts';
import {Scheduler} from '../src/scheduler.ts';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';
import {nativeJobKey,nativeApprovalKey,nativeConfigurationFingerprint} from '../src/cloudflare/autonomous-ports.ts';
import manifest from '../runtime-build.json' with {type:'json'};
test('actual quota completion preserves proof then actor restart waits for next daily occurrence and claims once',async(t)=>{
 const day=86400000,wake=Date.parse('2026-11-20T09:00:00Z'),reset=wake+3600000;
 t.mock.timers.enable({apis:['Date'],now:wake-1000});const snapshot=createSnapshot([]),core=new AutonomousEngine();
 const task=core.create({requestId:'daily-quota-actor',goal:'synthetic',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:wake+3*day,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'},execution:{backend:'cloudflare',mode:'long_running',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},wake-1000,'daily-quota');
 core.approve(task.id,1,'approved',wake-999);const lease=core.claimCloud(task.id,'worker','fixture-lease','run',wake+2000)!;core.nativeStart(lease,sessionId,wake+2001);
 const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},quota={kind:'rejected' as const,resetsAt:reset,evidence:'claude_rate_limit_event' as const};
 core.recordNativeReceipt(lease,{runId:'run',runtimeId:sessionId,sessionId,model:'pinned',sequence:1,usage:zero,stopped:true,outcome:'wait',wakeAt:reset,quota,usageUnavailable:true},wake+2002);
 const rows=new Map<string,unknown>(),creds=new Map<string,unknown>();
 const storage:AutonomousStorage & {alarm:number|null;getAlarm():Promise<number|null>;setAlarm(value:number):Promise<void>}={async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},alarm:null as number|null,async getAlarm(){return this.alarm;},async setAlarm(value:number){this.alarm=value;},async transaction<T>(fn:(tx:AutonomousStorage)=>Promise<T>):Promise<T>{return fn(storage);}};
 await storage.put('autonomous-state',core.snapshot());
 const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture-credential',quarantined:false});
 const job=scheduler.submit({provider:'claude',credentialId:'shared',snapshotId:snapshot.digest,instructions:'synthetic',checks:task.spec.execution!.checks,timeoutMs:120000,idempotencyKey:'first'},wake+2000,'native-first');scheduler.state.jobs[job.id]!.autonomous={taskId:task.id,runId:'run'};scheduler.dispatch(wake+2000);await storage.put('state',scheduler.state);
 await storage.put(nativeJobKey(job.id),{task:core.get(task.id),lease,runtimeId:sessionId,sessionId});
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),auth='sk-ant-oat01-synthetic-actor-auth';let launches=0;
 const env={AUTONOMOUS_QUOTA_PAUSE_ENABLED:'true',AUTONOMOUS_LONG_RUNNING_ENABLED:'true',AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example.com',AUTONOMOUS_SESSION_KEY:randomBytes(32).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTH_RETURN_PUBLIC_KEY:pair.publicKey.export({format:'pem',type:'spki'}).toString(),AUTH_RETURN_PRIVATE_KEY:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),CLAUDE_NESTED_APPROVED:'true',RUNNER:{getByName(){return {stop:async()=>true,ensure:async()=>({ready:false,lost:false,prepared:false,launchIssued:false}),launchNative:async()=>{launches++;}};}},CREDENTIALS:{async get(key:string){const value=creds.get(key);return value===undefined?null:{json:async()=>JSON.parse(value as string)};},async put(key:string,value:unknown){creds.set(key,value);return {};}},ARTIFACTS:{async get(){return {json:async()=>snapshot};},async put(){return {};}}};
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
 async function actor(){const pending:Promise<unknown>[]=[];const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};const a=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);return a as any;}
 t.mock.timers.setTime(wake+3000);const owner=await actor();
 const response={version:1,session:{sessionId,model:'pinned',sequence:1,data:{version:1,sessionId,model:'pinned',workspacePath:'/workspace',snapshot,transcripts:[{path:sessionId+'.jsonl',content:'{}\n'}]}},usage:zero,outcome:'wait',wakeAt:reset,quota,usageUnavailable:true,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
 await owner.completeNative(owner.scheduler.get(job.id),{version:1,jobId:job.id,attempt:job.attempt,ok:true,response,authReturn:sealAuth(auth,env.AUTH_RETURN_PUBLIC_KEY)});
 const row=await storage.get<any>(nativeJobKey(job.id));assert.deepEqual(row.result.quota,quota);assert.equal(row.result.usageUnavailable,true);
 for(const check of owner.scheduler.dispatch(Date.now()))owner.scheduler.computeFinished(check.id,check.attempt,{success:true,containerStopped:true,sourceUnchanged:true},Date.now());await storage.put('state',owner.scheduler.state);
 const service=new AutonomousService(storage);await service.execute('finishCloud',{lease,result:row.result,checksPassed:true});
 await storage.put('autonomous-cloud:'+task.id,{taskId:task.id,runId:'run',workerId:'worker',token:lease.token,jobId:job.id,phase:'done',snapshotId:snapshot.digest});
 await storage.put(nativeApprovalKey(task.id),{revision:1,fingerprint:nativeConfigurationFingerprint(env,manifest.digest)});
 t.mock.timers.setTime(reset);storage.alarm=null;await (await actor()).alarm();
 let state=await service.execute('get',{id:task.id}) as import('../../../packages/contracts/src/autonomous.ts').AutonomousTask;
 assert.equal(state.nextRunAt,wake+day);assert.equal(state.iteration,1);assert.equal(storage.alarm,wake+day);assert.equal(state.runs[0]!.wakeAt,reset);assert.equal(state.runs[0]!.scheduledAt,wake);
 t.mock.timers.setTime(wake+day);storage.alarm=null;await (await actor()).alarm();
 t.mock.timers.setTime(wake+day+2000);storage.alarm=null;await (await actor()).alarm();
 state=await service.execute('get',{id:task.id}) as typeof state;assert.equal(state.iteration,2);assert.equal(state.activeScheduleAt,wake+day);assert.ok(state.lease);
 t.mock.timers.setTime(wake+day+2001);await (await actor()).alarm();assert.equal((await service.execute('get',{id:task.id}) as typeof state).iteration,2);assert.equal(launches,0);
});
test('server quota gate rejects reporter quota proof when capability is disabled',async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');const pending:Promise<unknown>[]=[];
 const storage={async get(){},async put(){},async getAlarm(){return null;},async setAlarm(){}};
 const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 const env={CONTROL_TOKEN:'operator',AUTONOMOUS_WORKER_TOKEN:'worker',AUTONOMOUS_REPORTER_TOKEN:'reporter'};
 const actor=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);
 const r=request(),reset=Date.now()+30000;
 const response=await actor.fetch(new Request('https://control.example.com/v1/autonomous-tasks/task/native-receipt',{method:'POST',headers:{authorization:'Bearer reporter','content-type':'application/json'},body:JSON.stringify({lease:r.executionLease,receipt:{runId:'run',runtimeId:sessionId,sessionId,model:'pinned',sequence:1,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},stopped:true,outcome:'wait',wakeAt:reset,quota:{kind:'rejected',resetsAt:reset,evidence:'claude_rate_limit_event'},usageUnavailable:true}})}));
 assert.equal(response.status,503);
});
test('actor external approval is default closed until trusted composition is installed',async()=>{
 const {SchedulerDO}=await import('../src/cloudflare/worker.ts');const pending:Promise<unknown>[]=[];let approvals=0;
 const storage={async get(){},async put(){},async getAlarm(){return null;},async setAlarm(){}};
 const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 const actor=new SchedulerDO(ctx as never,{CONTROL_TOKEN:'operator'} as never);await Promise.all(pending);
 Object.assign(actor,{autonomy:{async execute(operation:string){if(operation==='get')return {id:'task',revision:1,spec:{externalProfiles:['aws-profile']}};if(operation==='approve'){approvals++;return {};}if(operation==='listPage')return {items:[]};throw Error('Unexpected');}}});
 const r=await actor.fetch(new Request('https://control.example.com/v1/autonomous-tasks/task/approve',{method:'POST',headers:{authorization:'Bearer operator'},body:JSON.stringify({revision:1,reason:'approve',externalProfileHashes:{'aws-profile':'a'.repeat(64)}})}));
 assert.equal(r.status,503);assert.equal(approvals,0);
});
test('R4 managed policy rejects known model aliases for parent and child case-insensitively',()=>{
 for(const alias of ['default','inherit','latest','best','opus','sonnet','haiku','opusplan'])for(const value of [alias,alias.toUpperCase()])for(const field of ['model','subagentModel'])assert.throws(()=>validateAutonomousPolicy({...policy,[field]:value}),field+':'+value);
});
test('R4 model pin preflight rejects aliases before private authorization or CLI',async()=>{
 let calls=0;for(const alias of ['inherit','SONNET','default','opusplan'])for(const field of ['model','subagentModel']){
  const r=request();r[field as 'model'|'subagentModel']=alias;if(field==='model')r.session.model=alias;
  await assert.rejects(executeAutonomousClaude(r,{authorizer:{async start(){calls++;throw Error('Authorization must not run');},async heartbeat(){throw Error();}},runProcess:async()=>{calls++;throw Error('CLI must not run');}}));
 }assert.equal(calls,0);
});
test('R4 pin syntax does not guess provider availability numeric IDs or model-name prefixes',()=>{
 for(const value of ['123','Fable-1','claude-sonnet-5-5','vendor-opus-v3','sonnet-custom','latest-v2','default.custom'])assert.doesNotThrow(()=>validateAutonomousPolicy({...policy,model:value,subagentModel:value}));
});
