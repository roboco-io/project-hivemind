import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,privateDecrypt,constants,createDecipheriv} from 'node:crypto';
import {createSnapshot} from '../src/snapshot.ts';
import {createBootstrap} from '../src/runtime/bootstrap.ts';
import {executeRuntime,runFromFile,checkRuntimeBoundary} from '../src/runtime/run.ts';
import * as runtime from '../src/runtime/run.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {runProcess} from '../src/runtime/process.ts';
import {providerArgs,claudeSettings,buildEnv,parseProviderResult,validateRuntimeInput} from '../src/runtime/providers.ts';
import type {ProcessResult} from '../src/contracts.ts';
const paths={home:'/home/node',privateDir:'/home/node/.hivemind-runtime',workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'};
const result=(stdout:string):ProcessResult=>({status:'passed',exitCode:0,stdout,stderr:'',durationMs:1,truncated:false});
const empty=createSnapshot([]);
test('compute rejects model authentication and arbitrary runtime fields',()=>{
 const valid={version:1,jobId:'job-1',attempt:'attempt-1',mode:'compute',snapshot:empty,argv:['node','--test'],timeoutMs:1000};
 assert.equal(validateRuntimeInput(valid).mode,'compute');
 assert.throws(()=>validateRuntimeInput({...valid,snapshot:{...empty,digest:'0'.repeat(64)}}),/snapshot|digest/i);
 assert.throws(()=>validateRuntimeInput({...valid,auth:'private'}),/auth|compute/i);
 assert.throws(()=>validateRuntimeInput({...valid,provider:'claude'}),/provider|compute/i);
 assert.throws(()=>validateRuntimeInput({...valid,command:'sh -c unexpected'}),/field|unknown/i);
});
test('provider argv keeps official sandbox, native agents and no bypass flags',()=>{
 const codex=providerArgs('codex','change code',paths);
 assert.ok(codex.includes('default_permissions="hivemind"'));assert.ok(codex.includes('agents.enabled=true'));assert.ok(!codex.includes('--ephemeral'));
 const claude=providerArgs('claude','change code',paths);assert.ok(claude.includes('dontAsk'));assert.ok(claude.includes('Bash,Agent'));assert.ok(claude.includes('Write,Edit,NotebookEdit'));
 assert.ok(![...codex,...claude].some(x=>x.includes('dangerously-skip')||x.includes('bypassPermissions')));
 const settings=claudeSettings(paths,false) as any;
 assert.ok(settings.sandbox.filesystem.denyRead.includes('/proc'));assert.deepEqual(settings.sandbox.credentials.envVars,[{name:'CLAUDE_CODE_OAUTH_TOKEN',mode:'deny'}]);
 assert.equal(settings.sandbox.enabled,true);assert.equal(settings.sandbox.failIfUnavailable,true);assert.equal(settings.sandbox.allowUnsandboxedCommands,false);assert.equal(settings.sandbox.enableWeakerNestedSandbox,false);
 assert.equal((claudeSettings(paths,true) as any).sandbox.enableWeakerNestedSandbox,true);
});
test('Codex named workspace permissions deny private files without conflicting legacy sandbox settings',()=>{
 const codex=providerArgs('codex','change code',paths);const policy=codex.find(arg=>arg.startsWith('permissions.hivemind='));
 assert.ok(policy,'named permission profile must be passed to the official CLI');assert.match(policy,/extends=":workspace"/);
 for(const denied of ['/runtime','/proc',paths.home+'/.codex/auth.json',paths.privateDir])assert.ok(policy.includes(`${JSON.stringify(denied)}="deny"`));
 assert.ok(!policy.includes(`${JSON.stringify(paths.home+'/.codex')}="deny"`),'native sandbox helpers remain executable');
 assert.ok(!codex.includes('--sandbox'));assert.ok(!codex.some(arg=>arg.startsWith('sandbox_mode=')||arg.startsWith('sandbox_workspace_write.')));
 const escaped=providerArgs('codex','change code',{...paths,home:'/home/space user',privateDir:'/home/space user/private"dir'}).find(arg=>arg.startsWith('permissions.hivemind='));
 assert.ok(escaped!.includes(`${JSON.stringify('/home/space user/private"dir')}="deny"`));
 assert.ok(codex.includes('agents.max_concurrent_threads_per_session=3'));assert.ok(codex.includes('mcp_servers.phase0.required=true'));
});
test('provider and compute environments never receive control credentials or cross-provider auth',()=>{
 const source={PATH:'/bin',HOME:'/private',CLOUDFLARE_API_TOKEN:'management',PROBE_TOKEN:'control',AWS_SECRET_ACCESS_KEY:'aws',OPENAI_API_KEY:'billing',CODEX_API_KEY:'billing',ANTHROPIC_API_KEY:'billing',CLAUDE_CODE_OAUTH_TOKEN:'wrong',HTTPS_PROXY:'https://proxy'};
 const compute=buildEnv(source,'/runtime/home');
 assert.equal(compute.HOME,'/runtime/home');assert.equal(compute.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(compute.CLOUDFLARE_API_TOKEN,undefined);assert.equal(compute.AWS_SECRET_ACCESS_KEY,undefined);
 const claude=buildEnv(source,'/home/node','claude','selected');assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN,'selected');assert.equal(claude.ANTHROPIC_API_KEY,undefined);
 const codex=buildEnv(source,'/home/node','codex');assert.equal(codex.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(codex.CODEX_API_KEY,undefined);
});
test('zero exit alone cannot pass missing, refused, denied or malformed native results',()=>{
 assert.equal(parseProviderResult('codex',result('{"type":"thread.started","thread_id":"x"}\n')).success,false);
 assert.equal(parseProviderResult('codex',result('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n')).success,true);
 for(const raw of ['{malformed}\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,result:'not valid'}),JSON.stringify([null,{type:'result',subtype:'success',is_error:false,result:'not valid'}]),'oops',JSON.stringify({type:'result',subtype:'success',is_error:true,result:'failed'}),JSON.stringify({type:'result',subtype:'success',is_error:false,result:'denied',permission_denials:[{}]})])assert.equal(parseProviderResult('claude',result(raw)).success,false);
 assert.equal(parseProviderResult('claude',result(JSON.stringify([{type:'system'}, {type:'result',subtype:'success',is_error:false,result:'done',session_id:'s'}]))).success,true);
 assert.equal(parseProviderResult('claude',result(JSON.stringify([{type:'result',subtype:'success',is_error:false,result:'one'},{type:'result',subtype:'success',is_error:false,result:'two'}]))).success,false);
});
test('subprocess output is bounded and timeout terminates before a late effect',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-'));try{
  const capped=await runProcess([process.execPath,'-e',"process.stdout.write('x'.repeat(5000))"],{cwd:dir,env:{PATH:process.env.PATH},timeoutMs:3000,maxBytes:100});assert.equal(capped.truncated,true);assert.ok(capped.stdout.length<=100);
  const marker=join(dir,'late');const timed=await runProcess([process.execPath,'-e',`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),700);setInterval(()=>{},1000)`],{cwd:dir,env:{PATH:process.env.PATH},timeoutMs:100});assert.equal(timed.status,'timed_out');await delay(750);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('cancellation waits for subprocess closure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-abort-'));const controller=new AbortController();try{
  const promise=runProcess([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:dir,env:{PATH:process.env.PATH},timeoutMs:5000,signal:controller.signal});setTimeout(()=>controller.abort(),80);const run=await promise;assert.equal(run.status,'error');assert.equal(run.exitCode,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('process intervals bracket actual child work and agree with execution duration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-process-time-'));try{
  const before=Date.now();const run=await runProcess([process.execPath,'-e',"console.log(Date.now());setTimeout(()=>console.log(Date.now()),120)"],{cwd:dir,env:{PATH:process.env.PATH},timeoutMs:3000});const after=Date.now();
  const timed=run as typeof run&{startedAt:number;finishedAt:number};const [childStarted,childFinished]=run.stdout.trim().split('\n').map(Number);
  assert.equal(run.status,'passed');assert.ok(Number.isSafeInteger(timed.startedAt));assert.ok(Number.isSafeInteger(timed.finishedAt));
  assert.ok(before<=timed.startedAt&&timed.startedAt<=childStarted!);assert.ok(childFinished!<=timed.finishedAt&&timed.finishedAt<=after);
  assert.equal(run.durationMs,timed.finishedAt-timed.startedAt);assert.ok(run.durationMs>=100);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed launches and timed out children retain settled process intervals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-process-failure-time-'));try{
  const options={cwd:dir,env:{PATH:process.env.PATH},timeoutMs:80};
  for(const argv of [[join(dir,'missing-executable')],[process.execPath,'-e','setInterval(()=>{},1000)'],[process.execPath,'-e','process.exit(3)']]){
   const before=Date.now();const run=await runProcess(argv,options);const after=Date.now();const timed=run as typeof run&{startedAt:number;finishedAt:number};
   assert.ok(before<=timed.startedAt&&timed.startedAt<=timed.finishedAt&&timed.finishedAt<=after);assert.equal(run.durationMs,timed.finishedAt-timed.startedAt);assert.notEqual(run.status,'passed');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-access-private-value',refresh_token:'fixture-refresh-private-value'}});
function unseal(envelope:any):string {
 const key=privateDecrypt({key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(Buffer.from('hivemind-phase0-auth-return-v1'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString();
}
const oneFile=(content='before\n')=>createSnapshot([{path:'value.txt',content:Buffer.from(content).toString('base64'),sha256:createHash('sha256').update(content).digest('hex'),executable:false}]);
const inputAgent=()=>({version:1 as const,jobId:'job-1',attempt:'attempt-1',mode:'agent' as const,provider:'codex' as const,instructions:'Change the source',snapshot:oneFile(),timeoutMs:5000,auth,authReturnPublicKey:publicKey});
const safeStatus=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>`${name}:\t0000000000000000`).join('\n')+'\nNoNewPrivs:\t1\n';
test('Linux runtime boundary requires all five zero capabilities and no-new-privileges',()=>{
 const check=(runtime as any).checkRuntimeBoundary;
 assert.equal(typeof check,'function','capability boundary validation must exist');
 assert.equal(check(safeStatus,'linux').verified,true);
 for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){
  assert.equal(check(safeStatus.replace(`${field}:\t0000000000000000`,`${field}:\t0000000000000001`),'linux').verified,false);
  assert.equal(check(safeStatus.replace(`${field}:\t0000000000000000\n`,''),'linux').verified,false);
 }
 for(const status of [safeStatus+'CapEff:\t0\n',safeStatus.replace('NoNewPrivs:\t1','NoNewPrivs:\t0'),safeStatus.replace('NoNewPrivs:\t1','NoNewPrivs:\t11')])assert.equal(check(status,'linux').verified,false);
 assert.equal(check(safeStatus,'darwin').verified,false);
});
test('runtime boundary reads fresh real process status without accepting an input attestation',async()=>{
 const read=(runtime as any).readRuntimeBoundary;
 assert.equal(typeof read,'function','live capability boundary inspection must exist');
 const boundary=await read();assert.equal(boundary.platform,process.platform);
 assert.ok(Math.abs(Date.now()-Date.parse(boundary.checkedAt))<5000);
 if(process.platform!=='linux')assert.equal(boundary.verified,false);
});
test('production file runner fails closed before launching a CLI when capabilities are unsafe',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-capguard-'));try{
  const runtimeDir=join(dir,'runtime');await import('node:fs/promises').then(fs=>fs.mkdir(runtimeDir));
  const marker=join(dir,'launched'),cli=join(dir,'fake.cjs');await writeFile(cli,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'bad');console.log(JSON.stringify({type:'turn.completed'}));`,{mode:0o755});
  await writeFile(join(runtimeDir,'input.json'),JSON.stringify(inputAgent()));
  const result=await runFromFile(runtimeDir,{workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli},boundaryCheck:async()=>({platform:'linux',checkedAt:new Date().toISOString(),capabilities:{CapEff:'0000000000000001'},noNewPrivs:1,verified:false})} as any);
  assert.equal(result!.process.status,'error');assert.equal((result as any).boundary.verified,false);assert.equal(unseal(result!.authReturn),auth);await assert.rejects(readFile(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('bootstrap prepares one immutable attempt without launching commands and supports private cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-bootstrap-'));const server=createBootstrap(dir);try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any;const url=`http://127.0.0.1:${address.port}`;
  const body=inputAgent();const post=(value:unknown)=>fetch(url+'/prepare',{method:'POST',body:JSON.stringify(value)});
  assert.equal((await post(body)).status,201);assert.equal((await post(body)).status,200);assert.equal((await post({...body,jobId:'other'})).status,409);
  const state=await (await fetch(url+'/state')).json() as {started:unknown};assert.equal(state.started,null);
  assert.equal((await fetch(url+'/exec',{method:'POST',body:'unexpected'})).status,404);
  assert.equal((await fetch(url+'/cancel',{method:'POST'})).status,202);
  assert.equal(await readFile(join(dir,'cancel'),'utf8'),'cancel');
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('runtime executes a real fake CLI process, returns source changes and only encrypted auth',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-cli-'));try{
  const cli=join(dir,'fake.cjs');await writeFile(cli,`#!${process.execPath}\nrequire('fs').writeFileSync('value.txt','after\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done fixture-access-private-value'}}));console.log(JSON.stringify({type:'turn.completed'}));\n`,{mode:0o755});
  const result=await executeRuntime(inputAgent(),{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli}});
  assert.equal(result.process.status,'passed');assert.equal(Buffer.from(result.snapshot!.files[0]!.content,'base64').toString(),'after\n');
  assert.equal(unseal(result.authReturn),auth);assert.ok(!JSON.stringify(result).includes('fixture-access-private-value'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runtime does not export source files containing known subscription credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-leak-'));try{
  const cli=join(dir,'fake.cjs');await writeFile(cli,`#!${process.execPath}\nrequire('fs').writeFileSync('leak.txt','fixture-access-private-value');console.log(JSON.stringify({type:'turn.completed'}));\n`,{mode:0o755});
  const result=await executeRuntime(inputAgent(),{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli}});
  assert.equal(result.process.status,'error');assert.equal(result.snapshot,undefined);assert.equal(unseal(result.authReturn),auth);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('materialization failures still write a failed result with recoverable encrypted auth and consume the attempt once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-fail-'));try{
  const runtime=join(dir,'runtime'),workspace=join(dir,'workspace');await import('node:fs/promises').then(fs=>Promise.all([fs.mkdir(runtime),fs.mkdir(workspace)]));
  await writeFile(join(workspace,'unexpected'),'keep');await writeFile(join(runtime,'input.json'),JSON.stringify(inputAgent()));
  const options={runtimeDir:runtime,workspace,home:join(dir,'home'),boundaryCheck:async()=>checkRuntimeBoundary(safeStatus,'linux')};const result=await runFromFile(runtime,options);
  assert.equal(result!.process.status,'error');assert.equal(unseal(result!.authReturn),auth);assert.equal(JSON.parse(await readFile(join(runtime,'result.json'),'utf8')).jobId,'job-1');assert.equal(await runFromFile(runtime,options),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('compute result reports source modification failure without any model auth return',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-runtime-compute-'));try{
  const input={version:1 as const,jobId:'check-1',attempt:'attempt-1',mode:'compute' as const,snapshot:oneFile(),argv:[process.execPath,'-e',"require('fs').writeFileSync('value.txt','changed');console.log('checks done')"],timeoutMs:5000};
  const result=await executeRuntime(input,{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),computePrefix:[]});
  assert.equal(result.credentialsAbsent,true);assert.equal(result.authReturn,undefined);assert.equal(result.sourceUnchanged,false);assert.equal(result.process.status,'error');assert.match(result.process.stdout,/checks done/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
