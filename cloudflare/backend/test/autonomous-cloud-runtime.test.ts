import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {createSnapshot} from '../src/snapshot.ts';
import {createBootstrap} from '../src/runtime/bootstrap.ts';
import {validateAutonomousCloudInput,validateAutonomousCloudOutput} from '../src/autonomous-cloud-protocol.ts';
import {runAutonomousFromFile,writeNativePrivate,readNativePrivate,NATIVE_FILES} from '../src/runtime/autonomous-from-file.ts';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'}).toString();
function input(){return {version:1,jobId:randomUUID(),attempt:randomUUID(),runtimeId:randomUUID(),request:{version:1,taskId:'task-1',executionLease:{taskId:'task-1',runId:'run-1',workerId:'worker-1',token:'lease-token',expiresAt:Date.now()+10000},model:'claude-sonnet-4-6',tools:['Bash'],goal:'test',session:{sessionId:randomUUID(),model:'claude-sonnet-4-6',sequence:0,data:null},subscriptionAuth:'sk-ant-oat01-testtoken',maxRunMs:5000,initialSnapshot:createSnapshot([])},control:{origin:'https://control.example',workerToken:'worker-secret',reporterToken:'reporter-secret'},authReturnPublicKey:key};}
const response=()=>({version:1 as const,session:{sessionId:randomUUID(),model:'claude-sonnet-4-6',sequence:1,data:{private:'session'}},usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},outcome:'complete' as const,boundary:{platform:'linux' as const,verified:true as const,noNewPrivs:1 as const,capabilitiesDropped:true as const}});
async function fixture(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'native-cloud-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('protocol rejects identity, private keys, extra fields and invalid outputs',()=>{const v=input();assert.equal(validateAutonomousCloudInput(v).jobId,v.jobId);assert.equal(validateAutonomousCloudInput(v).attempt,v.attempt);for(const change of [{version:2},{attempt:0},{attempt:1},{attempt:''},{attempt:'../unsafe'},{runtimeId:'bad'},{extra:true},{authReturnPublicKey:'private'}])assert.throws(()=>validateAutonomousCloudInput({...v,...change}));assert.throws(()=>validateAutonomousCloudOutput({version:1,jobId:v.jobId,attempt:v.attempt,ok:true}));});
test('exclusive private files reject symlinks and broad permissions',async()=>fixture(async dir=>{await writeNativePrivate(join(dir,'safe'),{ok:true});assert.equal((await stat(join(dir,'safe'))).mode&0o777,0o600);await assert.rejects(writeNativePrivate(join(dir,'safe'),{}));await symlink(join(dir,'safe'),join(dir,'link'));await assert.rejects(readNativePrivate(join(dir,'link')));await writeFile(join(dir,'wide'),'{}',{mode:0o644});await assert.rejects(readNativePrivate(join(dir,'wide')));}));
test('runner persists intent once and seals auth; private envelope only',async()=>fixture(async dir=>{await writeNativePrivate(join(dir,NATIVE_FILES.input),input());let calls=0;const execute=async(r:import('../../../packages/contracts/src/autonomous-native.ts').NativeClaudeRequest)=>{calls++;assert.ok(await readNativePrivate(join(dir,NATIVE_FILES.started)));return {...response(),session:{...r.session,sequence:1,data:{private:'session'}}};};const result=await runAutonomousFromFile(dir,{execute});assert.equal(result?.ok,true);assert.ok(result?.authReturn);assert.equal(JSON.stringify(result).includes('sk-ant-oat01'),false);await runAutonomousFromFile(dir,{execute});assert.equal(calls,1);}));
test('cancel aborts executor and persists generic failure',async()=>fixture(async dir=>{await writeNativePrivate(join(dir,NATIVE_FILES.input),input());const result=await runAutonomousFromFile(dir,{pollMs:5,execute:async(_r,options)=>{await writeNativePrivate(join(dir,NATIVE_FILES.cancel),true);await new Promise<void>(resolve=>{if(options!.signal!.aborted)resolve();else options!.signal!.addEventListener('abort',()=>resolve(),{once:true});});throw Error('private secret');}});assert.equal(result?.errorCode,'NATIVE_EXECUTION_FAILED');assert.equal(JSON.stringify(result).includes('private secret'),false);}));
test('native gate precedes parsing; prepare is idempotent and state safe; legacy health unchanged',async()=>fixture(async dir=>{const previous=process.env.HIVEMIND_NATIVE_GATE_TOKEN;process.env.HIVEMIND_NATIVE_GATE_TOKEN='gate-secret';const server=createBootstrap(dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;assert.equal((await fetch(url+'/autonomous/prepare',{method:'POST',body:'{'})).status,403);const body=JSON.stringify(input()),headers={'x-hivemind-native':'gate-secret'};assert.equal((await fetch(url+'/autonomous/prepare',{method:'POST',headers,body})).status,201);assert.equal((await fetch(url+'/autonomous/prepare',{method:'POST',headers,body})).status,200);const state=await(await fetch(url+'/autonomous/state',{headers})).text();assert.equal(state.includes('secret'),false);assert.equal(state.includes('request'),false);assert.equal((await fetch(url+'/health')).status,200);assert.equal((await fetch(url+'/autonomous/state/extra',{headers})).status,404);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.HIVEMIND_NATIVE_GATE_TOKEN;else process.env.HIVEMIND_NATIVE_GATE_TOKEN=previous;}}));
test('invalid RSA preflight cannot invoke executor and intent is never replayed',async()=>fixture(async dir=>{const value=input();value.authReturnPublicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();await writeNativePrivate(join(dir,NATIVE_FILES.input),value);let calls=0;const result=await runAutonomousFromFile(dir,{execute:async()=>{calls++;return response();}});assert.equal(calls,0);assert.equal(result?.errorCode,'NATIVE_EXECUTION_FAILED');assert.equal(result?.authReturn,undefined);await runAutonomousFromFile(dir,{execute:async()=>{calls++;return response();}});assert.equal(calls,0);}));
test('crashed started intent cannot start another executor',async()=>fixture(async dir=>{await writeNativePrivate(join(dir,NATIVE_FILES.input),input());await writeNativePrivate(join(dir,NATIVE_FILES.started),{});let calls=0;assert.equal(await runAutonomousFromFile(dir,{execute:async()=>{calls++;return response();}}),undefined);assert.equal(calls,0);}));
test('deadline propagates abort and records only generic failure',async()=>fixture(async dir=>{const value=input();value.request.maxRunMs=80;await writeNativePrivate(join(dir,NATIVE_FILES.input),value);let aborted=false;const result=await runAutonomousFromFile(dir,{execute:async(_r,options)=>{await new Promise<void>(resolve=>options!.signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));throw Error('withheld');}});assert.equal(aborted,true);assert.equal(result?.ok,false);}));
test('native entry import does not create files or invoke a model',async()=>{const {spawnSync}=await import('node:child_process');const child=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../src/runtime/autonomous-from-file.ts',import.meta.url).href)})`],{encoding:'utf8',timeout:3000});assert.equal(child.status,0);assert.equal(child.stdout,'');assert.equal(child.stderr,'');});
test('native child receives only public TLS CA variables from parent environment',async()=>fixture(async dir=>{
 const {executeAutonomousClaude}=await import('../src/runtime/autonomous-claude.ts');const {realpath}=await import('node:fs/promises');const root=await realpath(dir),r=validateAutonomousCloudInput(input()).request;r.subagentModel=r.model;
 const names=['SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','CONTROL_TOKEN','HIVEMIND_NATIVE_GATE_TOKEN','AWS_SECRET_ACCESS_KEY'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));Object.assign(process.env,{SSL_CERT_FILE:'/public/ca.pem',NODE_EXTRA_CA_CERTS:'/public/extra.pem',CONTROL_TOKEN:'private-control',HIVEMIND_NATIVE_GATE_TOKEN:'private-gate',AWS_SECRET_ACCESS_KEY:'private-aws'});let checked=false;
 try{await assert.rejects(executeAutonomousClaude(r,{home:join(root,'home'),workspace:join(root,'workspace'),authorizer:{start:async()=>({taskId:r.taskId,spec:{requestId:'fixture',provider:'claude',goal:r.goal,model:r.model,tools:r.tools,systems:[],credentialIds:['credential'],maxRunMs:r.maxRunMs,maxIterations:1,budgetMicros:0,endsAt:Date.now()+60000},deadline:Date.now()+10000}),heartbeat:async lease=>lease},boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),verified:true,noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),verifyPrerequisites:async()=>{},runProcess:async(_argv,options)=>{assert.equal(options.env.SSL_CERT_FILE,'/public/ca.pem');assert.equal(options.env.NODE_EXTRA_CA_CERTS,'/public/extra.pem');for(const name of names.slice(2))assert.equal(options.env[name],undefined);checked=true;throw Error('stop fake CLI');}}));assert.equal(checked,true);}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
}));

test('UUID attempt is preserved across input, intent and private result',async()=>fixture(async dir=>{const value=input();await writeNativePrivate(join(dir,NATIVE_FILES.input),value);const result=await runAutonomousFromFile(dir,{execute:async r=>({...response(),session:{...r.session,sequence:1,data:{}}})});assert.equal(result?.attempt,value.attempt);assert.equal(result?.jobId,value.jobId);const started=await readNativePrivate(join(dir,NATIVE_FILES.started)) as {jobId:string;attempt:string};assert.equal(started.attempt,value.attempt);assert.equal(started.jobId,value.jobId);const persisted=validateAutonomousCloudOutput(await readNativePrivate(join(dir,NATIVE_FILES.result)));assert.equal(persisted.attempt,value.attempt);assert.throws(()=>validateAutonomousCloudOutput({...persisted,attempt:1}));}));
test('trusted cloud nested setting is optional boolean and passed explicitly to executor',async()=>{
 for(const flag of [undefined,false,true])await fixture(async dir=>{const value={...input(),...(flag!==undefined?{claudeNestedCompatible:flag}:{})};validateAutonomousCloudInput(value);await writeNativePrivate(join(dir,NATIVE_FILES.input),value);let seen:unknown='unset';const result=await runAutonomousFromFile(dir,{execute:async(r,options)=>{seen=options?.nestedCompatible;return {...response(),session:{...r.session,sequence:1,data:{}}};}});assert.equal(seen,flag===true);assert.equal(result?.ok,true);});
 assert.throws(()=>validateAutonomousCloudInput({...input(),claudeNestedCompatible:'true'}));
 assert.throws(()=>validateAutonomousCloudInput({...input(),request:{...input().request,nestedCompatible:true}}));
});
test('native settings use trusted nested option while strict default and boundary remain mandatory',async()=>{
 const {executeAutonomousClaude}=await import('../src/runtime/autonomous-claude.ts'),{claudeSettings}=await import('../src/runtime/providers.ts'),{realpath,readFile}=await import('node:fs/promises');
 for(const flag of [undefined,false,true])await fixture(async dir=>{
  const root=await realpath(dir),home=join(root,'home'),workspace=join(root,'workspace'),r=validateAutonomousCloudInput(input()).request;r.subagentModel=r.model;let checked=false;
  const authorizer={start:async()=>({taskId:r.taskId,spec:{requestId:'fixture',provider:'claude' as const,goal:r.goal,model:r.model,tools:r.tools,systems:[],credentialIds:['credential'],maxRunMs:r.maxRunMs,maxIterations:1,budgetMicros:0,endsAt:Date.now()+60000},deadline:Date.now()+10000}),heartbeat:async(lease:typeof r.executionLease)=>lease};
  await assert.rejects(executeAutonomousClaude(r,{...(flag===undefined?{}:{nestedCompatible:flag}),home,workspace,authorizer,boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),verified:true,noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(k=>[k,'0000']))}),verifyPrerequisites:async()=>{},runProcess:async()=>{const actual=JSON.parse(await readFile(join(home,'.hivemind-phase0/settings.json'),'utf8'));assert.equal(actual.sandbox.failIfUnavailable,true);assert.equal(actual.sandbox.allowUnsandboxedCommands,false);assert.deepEqual(actual,claudeSettings({home,workspace,privateDir:join(home,'.hivemind-phase0'),scriptRoot:'/opt/hivemind/scripts/phase0'},flag===true));checked=true;throw Error('stop fake CLI');}}));assert.equal(checked,true);
  let called=false;await assert.rejects(executeAutonomousClaude(r,{nestedCompatible:flag,authorizer,boundaryCheck:async()=>({verified:false} as never),runProcess:async()=>{called=true;throw Error();}}));assert.equal(called,false);
 });
});
test('protocol requires UUID attempt and native-safe model/tool syntax',()=>{const v=input();for(const attempt of ['attempt','1','a'.repeat(36)]){assert.throws(()=>validateAutonomousCloudInput({...v,attempt}));assert.throws(()=>validateAutonomousCloudOutput({version:1,jobId:v.jobId,attempt,ok:false,errorCode:'NATIVE_EXECUTION_FAILED'}));}for(const request of [{...v.request,model:'bad model',session:{...v.request.session,model:'bad model'}},{...v.request,subagentModel:'--unsafe'},{...v.request,tools:['Agent']}])assert.throws(()=>validateAutonomousCloudInput({...v,request}));});
test('atomic private publication never exposes partial JSON to readers',async()=>fixture(async dir=>{
 const {open}=await import('node:fs/promises'),probe=await open(join(dir,'probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe),original=prototype.writeFile;await probe.close();
 const path=join(dir,'large.json'),value={data:'atomic-publication-canary'},bytes=JSON.stringify(value);let release!:()=>void,ready!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),partial=new Promise<void>(resolve=>{ready=resolve;});
 prototype.writeFile=async function(data:unknown,...args:unknown[]){if(data!==bytes)return original.call(this,data,...args);await original.call(this,bytes.slice(0,5));ready();await held;await original.call(this,bytes.slice(5));};
 const writing=writeNativePrivate(path,value);
 try{await partial;await assert.rejects(readNativePrivate(path),{code:'ENOENT'});}finally{release();await writing;prototype.writeFile=original;}
 assert.deepEqual(await readNativePrivate(path),value);
}));
test('private reader rejects hardlinks and FIFO without blocking',async()=>fixture(async dir=>{const {link}=await import('node:fs/promises'),{spawnSync}=await import('node:child_process');await writeNativePrivate(join(dir,'safe'),{});await link(join(dir,'safe'),join(dir,'hard'));await assert.rejects(readNativePrivate(join(dir,'hard')));const fifo=join(dir,'fifo');assert.equal(spawnSync('mkfifo',['-m','600',fifo]).status,0);await assert.rejects(readNativePrivate(fifo));}));
test('cancel settles even when injected executor ignores its AbortSignal',{timeout:10000},async t=>fixture(async dir=>{
 await writeNativePrivate(join(dir,NATIVE_FILES.input),input());
 let entered!:()=>void,release!:()=>void,returned!:()=>void,executorSignal:AbortSignal|undefined,executorReturned=false;
 const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),finished=new Promise<void>(resolve=>{returned=resolve;});
 // The test timeout is only a deadlock guard, never the cancellation oracle.
 t.signal.addEventListener('abort',release,{once:true});
 const running=runAutonomousFromFile(dir,{pollMs:2,execute:async(r,options)=>{
  executorSignal=options!.signal;entered();await held;
  executorReturned=true;returned();return {...response(),session:{...r.session,sequence:1,data:{}}};
 }});
 try{
  await started;assert.equal(executorSignal?.aborted,false);
  await writeNativePrivate(join(dir,NATIVE_FILES.cancel),true);
  // A non-cooperative executor stays pending until AFTER durable cancellation.
  const result=await running;
  assert.equal(t.signal.aborted,false);assert.equal(executorReturned,false);
  assert.equal(executorSignal?.aborted,true);assert.equal(executorSignal?.reason?.name,'AbortError');
  assert.equal(result?.ok,false);assert.equal(result?.errorCode,'NATIVE_EXECUTION_FAILED');assert.ok(result?.authReturn);
  const persisted=await readNativePrivate(join(dir,NATIVE_FILES.result));assert.deepEqual(persisted,result);
  assert.equal((await stat(join(dir,NATIVE_FILES.resultReady))).size,0);
  release();await finished;
  assert.deepEqual(await readNativePrivate(join(dir,NATIVE_FILES.result)),persisted);
 }finally{
  release();t.signal.removeEventListener('abort',release);await running;
 }
}));
test('direct native authorization honors abort when injected authorizer ignores signal',async()=>{
 const {executeAutonomousClaude}=await import('../src/runtime/autonomous-claude.ts'),r=validateAutonomousCloudInput(input()).request;r.subagentModel=r.model;let called=false;
 const running=executeAutonomousClaude(r,{signal:AbortSignal.timeout(20),authorizer:{start:async()=>{await new Promise(resolve=>setTimeout(resolve,200));return {taskId:r.taskId,spec:{requestId:'fixture',provider:'claude',model:r.model,goal:r.goal,tools:r.tools,systems:[],credentialIds:['credential'],maxRunMs:r.maxRunMs,maxIterations:1,budgetMicros:0,endsAt:Date.now()+10000},deadline:Date.now()+5000};},heartbeat:async l=>l},runProcess:async()=>{called=true;throw Error('should not run');}}).then(()=> 'unexpected-success',()=> 'aborted');
 const early=await Promise.race([running,new Promise<'late'>(resolve=>setTimeout(()=>resolve('late'),80))]);assert.equal(early,'aborted');assert.equal(called,false);await running;
});
test('private reader rejects inode link changes during bounded read',async()=>fixture(async dir=>{
 const {open,link}=await import('node:fs/promises'),path=join(dir,'race.json');await writeNativePrivate(path,{canary:'reader-link-race'});const probe=await open(path,'r'),prototype=Object.getPrototypeOf(probe),original=prototype.read;await probe.close();let raced=false;
 prototype.read=async function(...args:unknown[]){const result=await original.apply(this,args);if(!raced&&Buffer.isBuffer(args[0])&&args[0].toString().includes('reader-link-race')){raced=true;await link(path,join(dir,'other-link'));}return result;};
 try{await assert.rejects(readNativePrivate(path),/changed/);assert.equal(raced,true);}finally{prototype.read=original;}
}));
test('bootstrap waits for completion proof through hardlink publication window',async()=>fixture(async dir=>{
 const {link,unlink}=await import('node:fs/promises'),previous=process.env.HIVEMIND_NATIVE_GATE_TOKEN;process.env.HIVEMIND_NATIVE_GATE_TOKEN='publication-gate';const server=createBootstrap(dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={'x-hivemind-native':'publication-gate'},value=input(),output={version:1,jobId:value.jobId,attempt:value.attempt,ok:true,response:response()};
  await writeNativePrivate(join(dir,'pending-output'),output);await link(join(dir,'pending-output'),join(dir,NATIVE_FILES.result));
  const pending=await fetch(url+'/autonomous/state',{headers});assert.equal(pending.status,200);assert.equal((await pending.json() as {resultReady:boolean}).resultReady,false);assert.equal((await fetch(url+'/autonomous/result',{headers})).status,404);
  await unlink(join(dir,'pending-output'));await writeFile(join(dir,'autonomous-result.ready'),'',{mode:0o600});
  const ready=await fetch(url+'/autonomous/state',{headers});assert.equal(ready.status,200);const text=await ready.text();assert.equal(JSON.parse(text).resultReady,true);assert.equal(text.includes('session'),false);assert.equal((await fetch(url+'/autonomous/result',{headers})).status,200);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.HIVEMIND_NATIVE_GATE_TOKEN;else process.env.HIVEMIND_NATIVE_GATE_TOKEN=previous;}
}));
test('polling bootstrap during a large pending result never parses partial output or exposes its body',async()=>fixture(async dir=>{
 const {open}=await import('node:fs/promises'),value=input();await writeNativePrivate(join(dir,NATIVE_FILES.input),value);
 const previous=process.env.HIVEMIND_NATIVE_GATE_TOKEN;process.env.HIVEMIND_NATIVE_GATE_TOKEN='large-publication-gate';const server=createBootstrap(dir);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const probe=await open(join(dir,'probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe),original=prototype.writeFile;await probe.close();let release!:()=>void,ready!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),partial=new Promise<void>(resolve=>{ready=resolve;});const canary='large-private-output-canary';
 prototype.writeFile=async function(data:unknown,...args:unknown[]){if(typeof data!=='string'||!data.includes(canary))return original.call(this,data,...args);await original.call(this,data.slice(0,200));ready();await held;await original.call(this,data.slice(200));};
 const running=runAutonomousFromFile(dir,{execute:async r=>({...response(),session:{...r.session,sequence:1,data:{private:canary+'x'.repeat(1024*1024)}}})});
 try{await partial;const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={'x-hivemind-native':'large-publication-gate'};
  for(let i=0;i<3;i++){const state=await fetch(url+'/autonomous/state',{headers});assert.equal(state.status,200);const body=await state.text();assert.equal(JSON.parse(body).resultReady,false);assert.equal(body.includes(canary),false);assert.equal((await fetch(url+'/autonomous/result',{headers})).status,404);}
  release();assert.equal((await running)?.ok,true);const final=await fetch(url+'/autonomous/state',{headers});assert.equal(final.status,200);assert.equal((await final.json() as {resultReady:boolean}).resultReady,true);assert.equal((await fetch(url+'/autonomous/result',{headers})).status,200);
 }finally{release();await running;prototype.writeFile=original;await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.HIVEMIND_NATIVE_GATE_TOKEN;else process.env.HIVEMIND_NATIVE_GATE_TOKEN=previous;}
}));
