import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPrivateConfig,readReadiness,TARGET} from '../scripts/autonomous-readiness.ts';
import {createPilotPlan} from '../scripts/autonomous-pilot.ts';
// @ts-expect-error Standalone model-free JavaScript probe has no declaration file.
import {dockerProbeArgs} from '../scripts/autonomous-docker-probe.mjs';
test('readiness sends GET only, rejects redirects and projects booleans without secrets',async()=>{
 const calls:unknown[]=[];
 const report=await readReadiness('canary',async(url,options)=>{calls.push([url,options?.method,options?.redirect]);return Response.json({workerVersion:TARGET.workerVersion,runtimeRevision:TARGET.runtimeRevision,ready:true,token:'canary'});});
 assert.equal(calls.length,2);assert.ok(calls.every((v:any)=>v[1]==='GET'&&v[2]==='error'));
 assert.equal(JSON.stringify(report).includes('canary'),false);assert.equal(report.versionMatches,true);
});
test('readiness fails closed on stale revisions and never reflects response errors',async()=>{
 const report=await readReadiness('canary',async()=>Response.json({error:'canary'}, {status:403}));
 assert.equal(report.ready,false);assert.equal(report.versionMatches,false);assert.equal(JSON.stringify(report).includes('canary'),false);
});
test('private config requires regular nonsymlink 0600 file and exact keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'autonomous-config-'));try{
 const file=join(dir,'config');await writeFile(file,JSON.stringify({controlToken:'fake-token'}),{mode:0o600});
 assert.equal((await readPrivateConfig(file)).controlToken,'fake-token');
 await symlink(file,join(dir,'link'));await assert.rejects(readPrivateConfig(join(dir,'link')));
 await chmod(file,0o644);await assert.rejects(readPrivateConfig(file));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('pilot is local deterministic bounded draft with explicit provider/model pin',()=>{
 assert.throws(()=>createPilotPlan({provider:'claude',model:'',requestId:'pilot',now:0}));
 const plan=createPilotPlan({provider:'claude',model:'operator-pin',requestId:'pilot',now:0});
 assert.equal(plan.draft.provider,'claude');assert.equal(plan.draft.maxIterations,2);assert.equal(plan.draft.maxRunMs,120000);assert.equal(plan.draft.endsAt,600000);
 assert.deepEqual(plan.snapshot.files.map((f:any)=>f.path),['counter.txt']);assert.equal(plan.draft.execution.snapshotId,plan.snapshot.digest);
 assert.equal(plan.draft.execution.checks[0]!.argv[0],'node');assert.equal(plan.remoteMutation,false);assert.equal(plan.target.accountId,TARGET.accountId);
 assert.throws(()=>createPilotPlan({provider:'codex',model:'x',requestId:'pilot',now:0}));
});
test('Docker probe forbids auth mounts/network and keeps official amd64 sandbox boundary',()=>{
 const args=dockerProbeArgs('sha256:'+'a'.repeat(64));
 for(const required of ['--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--platform=linux/amd64','--pull=never'])assert.ok(args.includes(required));
 assert.ok(!args.some((v:string)=>v.includes('mount')||v==='--privileged'));assert.throws(()=>dockerProbeArgs('--privileged'));
});
test('Docker output projection suppresses unexpected canary and labels emulation evidence',async()=>{
 // @ts-expect-error Standalone model-free JavaScript probe has no declaration file.
 const {runDockerProbe}=await import('../scripts/autonomous-docker-probe.mjs');
 const report=runDockerProbe('a'.repeat(64),(_command:string,_args:string[],options:any)=>{
  assert.ok(!options.input.includes('claude --'));
  assert.ok(options.input.includes('NoNewPrivs:\\s'));
  return {status:0,stdout:JSON.stringify({passed:true,uid:true,caps:true,noNewPrivileges:true,authAbsent:true,managedBoundary:true,nativeAuth:true,actualSandbox:true,secret:'fake-canary'})};
 });
 assert.equal(report.passed,true);assert.equal(report.cloudflareEvidence,false);assert.equal(JSON.stringify(report).includes('fake-canary'),false);
});
test('existing operator config accepts base four and optional roles but projects only control token',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'autonomous-config-'));try{
 const file=join(dir,'config');
 const base={CONTROL_TOKEN:'fake-control',AUTH_STORAGE_KEY:'fake-storage',AUTH_RETURN_PUBLIC_KEY:'fake-public',AUTH_RETURN_PRIVATE_KEY:'fake-private'};
 const save=async(value:unknown)=>writeFile(file,JSON.stringify(value),{mode:0o600});
 await save(base);assert.deepEqual(await readPrivateConfig(file),{controlToken:'fake-control'});
 await save({...base,AUTONOMOUS_WORKER_TOKEN:'fake-worker',AUTONOMOUS_REPORTER_TOKEN:'fake-reporter',AUTONOMOUS_SESSION_KEY:'fake-session'});
 assert.deepEqual(await readPrivateConfig(file),{controlToken:'fake-control'});
 for(const value of [{...base,UNKNOWN:'fake'}, {...base,controlToken:'ambiguous'}, {...base,CONTROL_TOKEN:''}, {...base,CONTROL_TOKEN:'bad\nheader'}, {...base,AUTH_STORAGE_KEY:123}, {CONTROL_TOKEN:'incomplete'}, ['fake'], null]){
  await save(value);await assert.rejects(readPrivateConfig(file));
 }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual boundary probe uses only fixed Codex sandbox namespace-guard and filtered env',async()=>{
 const {boundaryProbeArgs,boundaryProbeEnvironment}=await import('../src/runtime/autonomous-boundary-probe.ts');
 const args=boundaryProbeArgs(1234);
 assert.equal(args[0],'sandbox');assert.ok(args.includes('/opt/hivemind/bin/namespace-guard'));
 assert.ok(!args.includes('exec')&&!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.ok(args.at(-1)!.includes('/runtime/private/canary'));
 assert.ok(args.at(-1)!.includes("'/proc/1234/'+p"));assert.ok(args.at(-1)!.includes("'environ'"));
 assert.throws(()=>boundaryProbeArgs(0));assert.throws(()=>boundaryProbeArgs(NaN));
 const env=boundaryProbeEnvironment();
 for(const key of ['CONTROL_TOKEN','AUTONOMOUS_WORKER_TOKEN','AUTONOMOUS_REPORTER_TOKEN','AUTONOMOUS_SESSION_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','NODE_OPTIONS'])assert.equal(env[key],undefined);
 assert.equal(env.CODEX_HOME,'/home/node/.codex-guard');
 const mounts=dockerProbeArgs('a'.repeat(64)).filter((v:string)=>v.startsWith('--tmpfs='));
 assert.ok(mounts.some((v:string)=>v.startsWith('--tmpfs=/home/node:')&&!v.includes('noexec')));
 assert.ok(mounts.some((v:string)=>v.startsWith('--tmpfs=/workspace:')&&!v.includes('noexec')));
});
test('Docker configuration success cannot substitute for actual sandbox proof',async()=>{
 // @ts-expect-error Standalone model-free JavaScript probe has no declaration file.
 const {runDockerProbe}=await import('../scripts/autonomous-docker-probe.mjs');
 const report=runDockerProbe('a'.repeat(64),()=>({status:0,stdout:JSON.stringify({passed:true,uid:true,caps:true,noNewPrivileges:true,authAbsent:true,managedBoundary:true,nativeAuth:true,actualSandbox:false})}));
 assert.equal(report.actualSandbox,false);assert.equal(report.passed,false);
});
test('generated pilot passes real core approval/cloud claim and native Bash policy',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');
 const {validateAutonomousPolicy,autonomousToolGate}=await import('../src/runtime/autonomous-tool-hook.ts');
 const plan=createPilotPlan({provider:'claude',model:'claude-opus-5-5',requestId:'real-core-pilot',now:1000});
 const engine=new AutonomousEngine();
 const task=engine.create(plan.draft,1000,'pilot-task');
 engine.approve(task.id,task.revision,'synthetic test approval',1001);
 assert.ok(engine.claimCloud(task.id,'worker','fake-lease','run',1002));
 const policy=validateAutonomousPolicy({version:1,tools:plan.draft.tools,model:plan.draft.model,subagentModel:plan.draft.model});
 assert.doesNotThrow(()=>autonomousToolGate({tool_name:'Bash',tool_input:{command:'node -e "0"'}},policy));
 assert.throws(()=>autonomousToolGate({tool_name:'Agent',tool_input:{}},policy));
 assert.equal(plan.draft.budgetMicros,1);assert.deepEqual(plan.draft.systems,[]);
 assert.equal(plan.costDisclosure.modelPlatformMonetaryCap,false);
 assert.equal(plan.costDisclosure.modelCost,'unknown');assert.equal(plan.costDisclosure.platformCost,'unknown');
});
test('boundary parent must have no actual auth before fixture creation',async()=>{
 const {boundaryParentAuthAbsent}=await import('../src/runtime/autonomous-boundary-probe.ts');
 assert.equal(boundaryParentAuthAbsent({PATH:'/usr/bin',HIVEMIND_NATIVE_GATE:'fake-native-gate'}),true);
 for(const name of ['CONTROL_TOKEN','AUTH_STORAGE_KEY','AUTH_RETURN_PRIVATE_KEY','AUTONOMOUS_WORKER_TOKEN','AUTONOMOUS_REPORTER_TOKEN','AUTONOMOUS_SESSION_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY'])assert.equal(boundaryParentAuthAbsent({[name]:'fake-auth'}),false);
});
test('offline sandbox parent seeds fixed fake canaries for namespace guard removal',async()=>{
 const {boundaryProbeCanaryEnvironment,boundaryProbeArgs}=await import('../src/runtime/autonomous-boundary-probe.ts');
 const env=boundaryProbeCanaryEnvironment();
 assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,'FAKE_PROVIDER_CANARY');assert.equal(env.CONTROL_TOKEN,'FAKE_CONTROL_CANARY');assert.equal(env.AUTH_STORAGE_KEY,'FAKE_STORE_CANARY');
 assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.ANTHROPIC_API_KEY,undefined);
 const script=boundaryProbeArgs(1234).at(-1)!;
 assert.ok(script.includes("process.env.HIVEMIND_NAMESPACE_GUARD==='seccomp-v1'"));
 assert.ok(script.includes("k!=='HIVEMIND_NAMESPACE_GUARD'"));
});
test('baseline readiness remains blocked by missing endpoint',async()=>{
 const report=await readReadiness('fake',async url=>url.endsWith('/health')?Response.json({workerVersion:TARGET.workerVersion,expectedRuntimeRevision:TARGET.runtimeRevision}):new Response(null,{status:404}));
 assert.equal(report.ready,false);assert.equal(report.endpointAvailable,false);
});
test('explicit candidate revisions permit postdeploy readiness without changing baseline',async()=>{
 const runtime='a'.repeat(64),version='12345678-1234-4234-8234-123456789abc';
 const fake=async(url:string)=>Response.json(url.endsWith('/health')?{workerVersion:version,expectedRuntimeRevision:runtime}:{ready:true});
 const report=await readReadiness('fake',fake,{expectedRuntimeRevision:runtime,expectedWorkerVersion:version});
 assert.equal(report.ready,true);assert.equal(report.baseline.runtimeRevision,TARGET.runtimeRevision);assert.equal(report.desired.runtimeRevision,runtime);assert.equal(report.desired.workerVersion,version);
 const unpinned=await readReadiness('fake',fake,{expectedRuntimeRevision:runtime});
 assert.equal(unpinned.ready,true);assert.equal(unpinned.desired.workerVersion,null);assert.equal(unpinned.versionMatches,null);
 const stale=await readReadiness('fake',fake);assert.equal(stale.ready,false);
 await assert.rejects(readReadiness('fake',fake,{expectedRuntimeRevision:'invalid'}));
 await assert.rejects(readReadiness('fake',fake,{expectedWorkerVersion:'invalid'}));
});
test('readiness CLI accepts explicit candidate pins and rejects duplicate/unknown flags',async()=>{
 const {parseReadinessArgs}=await import('../scripts/autonomous-readiness.ts');
 const runtime='a'.repeat(64),version='12345678-1234-4234-8234-123456789abc';
 assert.deepEqual(parseReadinessArgs(['--config','private','--expected-runtime',runtime,'--expected-version',version]),{configPath:'private',options:{expectedRuntimeRevision:runtime,expectedWorkerVersion:version}});
 for(const args of [['--config','private','--execute'],['--config','a','--config','b'],['--expected-runtime',runtime],['--config','private','--expected-version','invalid']])assert.throws(()=>parseReadinessArgs(args));
});
test('pilot goal specifies exact LF bytes and iteration outcome JSON without changing checks',()=>{
 const plan=createPilotPlan({provider:'claude',model:'claude-opus-5-5',requestId:'goal-fixture',now:1000});
 assert.ok(plan.draft.goal.includes('Bash with Node'));
 assert.ok(plan.draft.goal.includes('0x31 0x0a'));assert.ok(plan.draft.goal.includes('0x32 0x0a'));
 assert.ok(plan.draft.goal.includes('only {"outcome":"continue"}'));
 assert.ok(plan.draft.goal.includes('only {"outcome":"complete"}'));
 assert.equal(plan.draft.execution.checks[0]!.argv[2],"const fs=require('node:fs');const s=fs.readFileSync('counter.txt','utf8');if(!/^[12]\\n$/.test(s))process.exit(1)");
 assert.equal(plan.draft.requestId,'goal-fixture');assert.equal(plan.draft.model,'claude-opus-5-5');
});

test('pilot rejects inputs that cannot pass downstream core without echoing them',()=>{
 const base={provider:'claude',model:'claude-opus-5-5',requestId:'review-plan',now:1000};
 for(const change of [{model:'unsafe model'},{model:'x'.repeat(101)},{requestId:' '},{requestId:'x'.repeat(257)},{requestId:'private\0value'},{now:Number.MAX_SAFE_INTEGER}])assert.throws(()=>createPilotPlan({...base,...change}));
});

test('malformed private JSON errors cannot expose content and hardlinks are rejected',async()=>{
 const {link}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'readiness-review-'));
 try{
  const file=join(dir,'config');await writeFile(file,'{"controlToken":"PRIVATE_JSON_CANARY", trailing}',{mode:0o600});
  await assert.rejects(readPrivateConfig(file),error=>error instanceof Error&&error.message==='Invalid private configuration');
  await writeFile(file,JSON.stringify({controlToken:'private-canary'}));await link(file,join(dir,'hardlink'));
  await assert.rejects(readPrivateConfig(file));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('readiness consumes bounded bytes and never reflects a token shaped like version metadata',async()=>{
 const token='12345678-1234-4234-8234-123456789abc';let pulls=0;
 const bounded=await readReadiness(token,async()=>new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(40000));if(pulls%3===0)controller.close();}},{highWaterMark:0})));
 assert.equal(bounded.ready,false);assert.ok(pulls<=4);
 const echoed=await readReadiness(token,async url=>Response.json(url.endsWith('/health')?{workerVersion:token,runtimeRevision:TARGET.runtimeRevision}:{ready:true}));
 assert.equal(JSON.stringify(echoed).includes(token),false);
});

test('readiness CLI reports a failed gate with a nonzero exit and no secret output',async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const dir=await mkdtemp(join(tmpdir(),'readiness-cli-'));
 try{
  const file=join(dir,'config');await writeFile(file,JSON.stringify({controlToken:'PRIVATE_CLI_CANARY'}),{mode:0o600});
  const url=new URL('../scripts/autonomous-readiness.ts',import.meta.url);
  const script=`globalThis.fetch=async()=>new Response(null,{status:503});process.argv=[process.execPath,${JSON.stringify(fileURLToPath(url))},'--config',${JSON.stringify(file)}];await import(${JSON.stringify(url.href)});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});
  assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_CLI_CANARY/);assert.equal(JSON.parse(result.stdout).ready,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Docker timeout cleans up only the container identified by its private cidfile',async()=>{
 // @ts-expect-error Standalone model-free JavaScript probe has no declaration file.
 const {runDockerProbe}=await import('../scripts/autonomous-docker-probe.mjs');const {writeFileSync}=await import('node:fs');
 const calls:string[][]=[];const cid='b'.repeat(64);
 const report=runDockerProbe('a'.repeat(64),(_command:string,args:string[])=>{calls.push(args);if(args[0]==='run'){const flag=args.find(v=>v.startsWith('--cidfile='));assert.ok(flag,'timed run must identify its own container');writeFileSync(flag.slice('--cidfile='.length),cid);return {status:null,error:new Error('fake timeout'),stdout:''};}return {status:0};});
 assert.equal(report.passed,false);assert.deepEqual(calls[1],['rm','--force',cid]);
});

for(const timeout of [false,true])test(`boundary no-model child cleans descendant process group (timeout=${timeout})`,async()=>{
 const {runBoundaryProbeChild}=await import('../src/runtime/autonomous-boundary-probe.ts');
 const {spawn}=await import('node:child_process');const {access}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'probe-process-review-'));const marker=join(dir,'escaped-descendant');
 try{
  const descendant=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),450)`;
  const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),${timeout?2000:80});`;
  const fake=(()=>spawn(process.execPath,['-e',parent],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}})) as typeof spawn;
  assert.equal(await runBoundaryProbeChild(fake,timeout?180:1000),!timeout);
  await new Promise(resolve=>setTimeout(resolve,550));await assert.rejects(access(marker));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('boundary cleanup preserves replaced user files and directories',async()=>{
 const {cleanupBoundaryFixtures}=await import('../src/runtime/autonomous-boundary-probe.ts');
 const {lstat,rename,mkdir,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'probe-cleanup-review-'));
 try{
  const path=join(dir,'fixture');await writeFile(path,'owned');const original=await lstat(path);
  await rename(path,join(dir,'original'));await writeFile(path,'USER_DATA');
  assert.equal(await cleanupBoundaryFixtures([{path,dev:original.dev,ino:original.ino}]),false);assert.equal(await readFile(path,'utf8'),'USER_DATA');
  const directory=join(dir,'cache');await mkdir(directory);const owned=await lstat(directory);
  await rename(directory,join(dir,'old-cache'));await mkdir(directory);await writeFile(join(directory,'user-file'),'USER_DATA');
  assert.equal(await cleanupBoundaryFixtures([{path:directory,dev:owned.dev,ino:owned.ino}]),false);assert.equal(await readFile(join(directory,'user-file'),'utf8'),'USER_DATA');
  const file=join(dir,'ours');await writeFile(file,'owned');const info=await lstat(file);
  assert.equal(await cleanupBoundaryFixtures([{path:file,dev:info.dev,ino:info.ino}]),true);await assert.rejects(lstat(file));
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('Docker cannot pass when the runner reports transport failure despite success-shaped JSON',async()=>{
 // @ts-expect-error Standalone model-free JavaScript probe has no declaration file.
 const {runDockerProbe}=await import('../scripts/autonomous-docker-probe.mjs');
 const report=runDockerProbe('a'.repeat(64),()=>({status:0,error:new Error('fake transport error'),stdout:JSON.stringify({passed:true,uid:true,caps:true,noNewPrivileges:true,authAbsent:true,managedBoundary:true,nativeAuth:true,actualSandbox:true})}));
 assert.equal(report.passed,false);
});

test('Docker private exclusions remain after broad source inclusion',async()=>{
 const {readFile}=await import('node:fs/promises');const rules=(await readFile(new URL('../../.dockerignore',import.meta.url),'utf8')).split('\n');
 const include=rules.indexOf('!backend/src/**');assert.ok(include>=0);
 for(const rule of ['**/.git/**','**/.ssh/**','**/.aws/**','**/.hivemind/**','**/.codex/**','**/.claude/**','**/node_modules/**','**/.npmrc','**/.git-credentials','**/*.sqlite*'])assert.ok(rules.lastIndexOf(rule)>include,rule);
});

test('boundary cleanup never recursively deletes a refused replacement through its owned parent',async()=>{
 const {cleanupBoundaryFixtures}=await import('../src/runtime/autonomous-boundary-probe.ts');
 const {mkdir,lstat,rename,readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'probe-parent-review-'));
 try{
  const parent=join(dir,'owned');await mkdir(parent);const parentInfo=await lstat(parent),path=join(parent,'fixture');await writeFile(path,'owned');const fileInfo=await lstat(path);
  await rename(path,join(dir,'original'));await writeFile(path,'USER_DATA');
  assert.equal(await cleanupBoundaryFixtures([{path:parent,dev:parentInfo.dev,ino:parentInfo.ino},{path,dev:fileInfo.dev,ino:fileInfo.ino}]),false);
  assert.equal(await readFile(path,'utf8'),'USER_DATA');
 }finally{await rm(dir,{recursive:true,force:true});}
});
