import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeAutonomousClaude} from '../src/runtime/autonomous-claude.ts';
const lease={taskId:'task',runId:'run',workerId:'worker',token:'lease-secret',expiresAt:Date.now()+30000};
const runtimeId='12345678-1234-4234-8234-123456789abc';
const request=()=>({version:1 as const,taskId:'task',executionLease:lease,model:'Fable-1',subagentModel:'Fable-1',tools:['Bash'],goal:'test',session:{sessionId:runtimeId,model:'Fable-1',sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-synthetic-token',maxRunMs:10000});
function authorizer(subscription=true){return {async start(){const r=request();return {taskId:r.taskId,spec:{requestId:'r',provider:'claude' as const,goal:r.goal,model:r.model,tools:r.tools,systems:[],credentialIds:['c'],maxRunMs:r.maxRunMs,maxIterations:2,budgetMicros:10,endsAt:Date.now()+60000,...(subscription?{billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}}:{})},deadline:Date.now()+10000};},async heartbeat(){return lease;}};}
test('canonical subscription ready precedes boundary and filesystem',async()=>{
 const events:string[]=[];
 await assert.rejects(executeAutonomousClaude(request(),{authorizer:authorizer(),runtimeId,reporter:{async ready(l,id){assert.deepEqual(l,lease);assert.equal(id,runtimeId);events.push('ready');throw Error('refused');},async record(){events.push('record');}},boundaryCheck:async()=>{events.push('boundary');throw Error();}}));
 assert.deepEqual(events,['ready']);
});
import {createNativeHttpReporter,nativeReporterFromEnvironment} from '../src/runtime/autonomous-reporter.ts';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {autonomousProjectDirectory} from '../src/runtime/autonomous-session.ts';
import {createSnapshot} from '../src/snapshot.ts';
const signal=()=>new AbortController().signal;
const receipt={runId:lease.runId,runtimeId,sessionId:runtimeId,model:'Fable-1',sequence:1,outcome:'continue' as const,usage:{inputTokens:1,cacheReadTokens:2,cacheWriteTokens:3,outputTokens:4},stopped:true as const};
test('HTTP reporter bounds transport, authenticates and validates acknowledgements',async()=>{
 const seen:string[]=[];
 const reporter=createNativeHttpReporter({url:'http://127.0.0.1:4321',token:'report-secret',fetchImpl:async(url,init)=>{
  seen.push(String(url));assert.equal(init!.redirect,'error');assert.equal((init!.headers as Record<string,string>).authorization,'Bearer report-secret');assert.ok(init!.signal);
  const body=JSON.parse(init!.body as string);assert.deepEqual(body.lease,lease);
  if(String(url).endsWith('native-ready')){assert.equal(body.runtimeId,runtimeId);return Response.json({ready:true});}
  assert.deepEqual(body.receipt,receipt);return Response.json({recorded:true});
 }});
 await reporter.ready(lease,runtimeId,signal());await reporter.record(lease,receipt,signal());assert.equal(seen.length,2);
 for(const response of [Response.json({ready:false}),Response.json({ready:true,secret:'extra'}),new Response('x'.repeat(1025)),new Response('report-secret',{status:401})]){
  let calls=0;const bad=createNativeHttpReporter({url:'https://control.example',token:'report-secret',fetchImpl:async()=>{calls++;return response;}});
  await assert.rejects(bad.ready(lease,runtimeId,signal()),{message:'Native report refused or failed'});assert.equal(calls,1);
 }
 for(const url of ['http://control.example','https://u:secret@control.example','https://control.example?token=secret','https://control.example#fragment'])assert.throws(()=>createNativeHttpReporter({url,token:'secret'}));
 const aborted=new AbortController();aborted.abort();await assert.rejects(reporter.ready(lease,runtimeId,aborted.signal));assert.equal(seen.length,2);
});
test('environment reporter rejects worker and private ingress tokens',()=>{
 const keys=['HIVEMIND_CONTROL_API_URL','HIVEMIND_NATIVE_REPORTER_TOKEN','HIVEMIND_AUTONOMOUS_WORKER_TOKEN','HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN'];const saved=keys.map(k=>process.env[k]);
 try{process.env.HIVEMIND_CONTROL_API_URL='https://control.example';process.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN='worker-secret';process.env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN='ingress-secret';
 for(const token of ['worker-secret','ingress-secret','']){process.env.HIVEMIND_NATIVE_REPORTER_TOKEN=token;assert.throws(()=>nativeReporterFromEnvironment());}
 process.env.HIVEMIND_NATIVE_REPORTER_TOKEN='independent-secret';assert.ok(nativeReporterFromEnvironment());
 }finally{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
});
const boundary=async()=>({platform:'linux',checkedAt:new Date().toISOString(),capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000'])),noNewPrivs:1,verified:true});
async function synthetic(options:{signal?:AbortSignal;subscription?:boolean;secret?:string;badUsage?:boolean;badModel?:boolean;reportFailure?:boolean;onRecord?:()=>Promise<void>;heartbeat?:()=>Promise<typeof lease>;reporterSecrets?:readonly string[];outcome?:{outcome:string;wakeAt?:number}}={}){
 const root=await mkdtemp(join(await realpath(tmpdir()),'reporter-test-')),home=join(root,'home'),workspace=join(root,'workspace'),events:string[]=[];
 try{const result=await executeAutonomousClaude({...request(),initialSnapshot:createSnapshot([])},{signal:options.signal,home,workspace,runtimeId,authorizer:{...authorizer(options.subscription??true),...(options.heartbeat?{heartbeat:options.heartbeat}:{})},reporterSecrets:options.reporterSecrets,boundaryCheck:boundary,verifyPrerequisites:async()=>{},reporter:{async ready(){events.push('ready');},async record(l,r){events.push('record');assert.deepEqual(r,{...receipt,...options.outcome});assert.deepEqual(l,lease);await options.onRecord?.();if(options.reportFailure)throw Error('secret-error');}},runProcess:async(_argv,opts)=>{
 events.push('cli');assert.equal(opts.env.HIVEMIND_NATIVE_REPORTER_TOKEN,undefined);assert.equal(opts.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN,undefined);assert.equal(opts.env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN,undefined);
 const project=autonomousProjectDirectory(home);await mkdir(project,{recursive:true});await writeFile(join(project,runtimeId+'.jsonl'),JSON.stringify({text:options.secret??'safe'})+'\n');events.push('closed');
 return {status:'passed',exitCode:0,stderr:'',stdout:[{type:'system',subtype:'init',session_id:runtimeId,model:options.badModel?'wrong':'Fable-1'},{type:'result',session_id:runtimeId,subtype:'success',is_error:false,result:JSON.stringify(options.outcome??{outcome:'continue'}),usage:{input_tokens:1,cache_read_input_tokens:2,cache_creation_input_tokens:3,...(options.badUsage?{}:{output_tokens:4})}}].map(x=>JSON.stringify(x)).join('\n'),durationMs:1,truncated:false};
 }});events.push('response');return {result,events};}catch(error){throw Object.assign(error as Error,{events});}finally{await rm(root,{recursive:true,force:true});}
}
test('receipt follows closed CLI and verified bundle; default policy never reports',async()=>{
 assert.deepEqual((await synthetic()).events,['ready','cli','closed','record','response']);
 assert.deepEqual((await synthetic({subscription:false})).events,['cli','closed','response']);
 for(const opts of [{badUsage:true},{badModel:true}])await assert.rejects(synthetic(opts),(e:Error&{events:string[]})=>!e.events.includes('record'));
 await assert.rejects(synthetic({reportFailure:true}),{message:'Native Claude iteration refused or failed'});
});
test('all configured authority secret values are rejected in subscription bundles',async()=>{
 const keys=['HIVEMIND_NATIVE_REPORTER_TOKEN','HIVEMIND_AUTONOMOUS_WORKER_TOKEN','HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN'],saved=keys.map(k=>process.env[k]);
 try{for(let i=0;i<keys.length;i++)process.env[keys[i]!]='sensitive-authority-'+i;
 for(const key of keys)await assert.rejects(synthetic({secret:process.env[key]}),(e:Error&{events:string[]})=>!e.events.includes('record'));
 }finally{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
});

test('receipt attests wait and input outcomes exactly',async()=>{
 for(const outcome of [{outcome:'wait',wakeAt:Date.now()+60000},{outcome:'input'}]){
  const {result}=await synthetic({outcome});assert.equal(result.outcome,outcome.outcome);assert.equal(result.wakeAt,'wakeAt' in outcome?outcome.wakeAt:undefined);
 }
});
test('heartbeat remains independent throughout receipt submission',async(t)=>{
 t.mock.timers.enable({apis:['setInterval']});let beats=0;
 try{await synthetic({heartbeat:async()=>{beats++;return lease;},onRecord:async()=>{t.mock.timers.tick(5000);await new Promise<void>(r=>setImmediate(r));assert.equal(beats,1);}});
 await assert.rejects(synthetic({heartbeat:async()=>{throw Error('cancelled');},onRecord:async()=>{t.mock.timers.tick(5000);await new Promise<void>(r=>setImmediate(r));}}),{message:'Native Claude iteration refused or failed'});
 }finally{t.mock.timers.reset();}
});
test('injected reporter can supply private known secret values',async()=>{
 await assert.rejects(synthetic({secret:'closure-only-private-token',reporterSecrets:['closure-only-private-token']}),(e:Error&{events:string[]})=>!e.events.includes('record'));
});
test('missing reporter configuration refuses before runtime boundary',async()=>{
 const saved=process.env.HIVEMIND_NATIVE_REPORTER_TOKEN;delete process.env.HIVEMIND_NATIVE_REPORTER_TOKEN;let boundaryCalled=false;
 try{await assert.rejects(executeAutonomousClaude(request(),{authorizer:authorizer(),boundaryCheck:async()=>{boundaryCalled=true;return boundary();}}));assert.equal(boundaryCalled,false);}
 finally{if(saved!==undefined)process.env.HIVEMIND_NATIVE_REPORTER_TOKEN=saved;}
});
// Entry/release gates establish ordering. Test timeouts only detect deadlocks;
// elapsed time (including synthetic filesystem cleanup) is never the oracle.
function gate(){
 let resolve!:()=>void;let released=false;
 const promise=new Promise<void>(r=>{resolve=r;});
 return {promise,get released(){return released;},release(){released=true;resolve();}};
}
test('HTTP reporter aborts even when fetch or response body ignores signal',{timeout:5000},async()=>{
 for(const stalledBody of [false,true]){
  const controller=new AbortController(),entered=gate(),blocked=gate();
  const reporter=createNativeHttpReporter({url:'https://control.example',token:'secret',fetchImpl:async()=>{
   if(stalledBody)return new Response(new ReadableStream({pull(){entered.release();return blocked.promise;},cancel(){return blocked.promise;}}));
   entered.release();await blocked.promise;return Response.json({ready:true});
  }});
  const pending=reporter.ready(lease,runtimeId,controller.signal);
  const rejected=assert.rejects(pending,{message:'Native report refused or failed'});
  try{await entered.promise;controller.abort();await rejected;assert.equal(blocked.released,false,'report must reject before transport is released');}
  finally{blocked.release();await pending.catch(()=>{});}
 }
});
test('runtime aborts while injected reporter ignores signal',{timeout:5000},async()=>{
 const controller=new AbortController(),entered=gate(),blocked=gate();let calls=0;
 const pending=executeAutonomousClaude(request(),{signal:controller.signal,authorizer:authorizer(),runtimeId,reporter:{ready:async(l,id,reportSignal)=>{
  assert.deepEqual(l,lease);assert.equal(id,runtimeId);entered.release();controller.abort();assert.equal(reportSignal.aborted,true);await blocked.promise;
 },record:async()=>{assert.fail('cancelled ready must not record a receipt');}},boundaryCheck:async()=>{calls++;return boundary();}});
 const rejected=assert.rejects(pending,{message:'Native Claude iteration refused or failed'});
 try{await entered.promise;await rejected;assert.equal(blocked.released,false,'runtime must reject before ready is released');assert.equal(calls,0);}
 finally{blocked.release();await pending.catch(()=>{});}
});
test('malformed canonical billing policy fails before any runtime action',async()=>{
 for(const billingPolicy of [{model:'subscription',budget:'all'},{model:'subscription',budget:'external_actions',extra:true}]){
  let calls=0;const base=authorizer();
  await assert.rejects(executeAutonomousClaude(request(),{authorizer:{...base,start:async()=>({...await base.start(),spec:{...(await base.start()).spec,billingPolicy} as never})},reporter:{ready:async()=>{calls++;},record:async()=>{}},boundaryCheck:async()=>{calls++;throw Error();}}));assert.equal(calls,0);
 }
});

test('runtime cancellation during stuck receipt submission never returns success',{timeout:5000},async()=>{
 const controller=new AbortController(),entered=gate(),blocked=gate();
 const pending=synthetic({signal:controller.signal,onRecord:async()=>{entered.release();await blocked.promise;}});
 const rejected=assert.rejects(pending,(error:Error&{events:string[]})=>{
  assert.equal(error.message,'Native Claude iteration refused or failed');
  assert.deepEqual(error.events,['ready','cli','closed','record']);return true;
 });
 try{await entered.promise;controller.abort();await rejected;assert.equal(blocked.released,false,'runtime must reject before receipt submission is released');}
 finally{blocked.release();await pending.catch(()=>{});}
});

test('reporter client and environment reject whitespace and control characters',()=>{
 for(const token of [' worker-secret','ingress-secret ','report key','report\tkey','report\nkey','report\u007fkey','report\u0085key'])assert.throws(()=>createNativeHttpReporter({url:'https://control.example',token}));
 const keys=['HIVEMIND_CONTROL_API_URL','HIVEMIND_NATIVE_REPORTER_TOKEN','HIVEMIND_AUTONOMOUS_WORKER_TOKEN','HIVEMIND_OPERATOR_TOKEN'];const saved=keys.map(k=>process.env[k]);
 try{process.env.HIVEMIND_CONTROL_API_URL='https://control.example';process.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN='worker';process.env.HIVEMIND_OPERATOR_TOKEN='operator';for(const token of [' worker','operator ']){process.env.HIVEMIND_NATIVE_REPORTER_TOKEN=token;assert.throws(()=>nativeReporterFromEnvironment());}}finally{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
});
