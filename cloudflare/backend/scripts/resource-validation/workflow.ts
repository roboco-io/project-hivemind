import {readFile,mkdir,writeFile,stat,unlink} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {userInfo} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {readSnapshot,restoreSnapshot} from '../../src/files.ts';
import {mergeWorkflowOutputs,validateWorkflowSpec,type WorkflowSpec} from '../../src/workflow.ts';
import {validateSnapshot} from '../../src/snapshot.ts';
import {processDiagnostic} from '../../src/runtime/process-diagnostic.ts';
import {runProcess} from '../../src/runtime/process.ts';
import {extractClaudeResultMetrics} from '../../src/claude-result-metrics.ts';
import {atomicJson,cloudClient,safeEnv} from './experiment.ts';
import {createHostSampler,summarizeHost,type HostSample} from './host-metrics.ts';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['SUCCEEDED','FAILED','CANCELLED']);
interface Settings {version:1;fixture:string;probeRepo:string;workers:[{provider:'codex'|'claude';credentialId:string;target:'articles'|'comments';model:string;effort:'medium';writes:string[];instructions:string},{provider:'codex'|'claude';credentialId:string;target:'articles'|'comments';model:string;effort:'medium';writes:string[];instructions:string}];roundLimit:number;workerTimeoutMs:number;integrationTimeoutMs:number;}
interface ModelReceipt {success:boolean;sessionId?:string;model?:string;usage?:Record<string,number>;error?:string;claudeResultMetrics?:ReturnType<typeof extractClaudeResultMetrics>}
function readReceipt(provider:'codex'|'claude',stdout:string):ModelReceipt {
 let events:any[];
 try{const raw=JSON.parse(stdout);events=Array.isArray(raw)?raw:[raw];}
 catch{try{events=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return {success:false,error:'Provider output was not valid JSON'};}}
 if(provider==='codex'){
  const start=events.find(e=>e.type==='thread.started');const end=events.filter(e=>e.type==='turn.completed').at(-1);
  const bad=events.some(e=>e.type==='turn.failed'||e.type==='error');
  const usage=end?.usage&&Object.fromEntries(Object.entries(end.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0));
  return {success:!!end&&!bad,sessionId:typeof start?.thread_id==='string'?start.thread_id:undefined,usage};
 }
 const result=events.filter(e=>e.type==='result').at(-1);
 const model=Object.keys(result?.modelUsage??{});
 const usage=result?.usage&&Object.fromEntries(Object.entries(result.usage).filter(([,v])=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0));
 return {success:result?.subtype==='success'&&result.is_error===false&&result.stop_reason!=='refusal'&&!(result.permission_denials?.length),
  sessionId:typeof result?.session_id==='string'?result.session_id:undefined,model:model.length===1?model[0]:undefined,usage,claudeResultMetrics:extractClaudeResultMetrics(result)};
}
function nativeArgs(worker:Settings['workers'][number],sessionId:string|undefined,prompt:string){
 if(worker.provider==='codex'){
  const args=[process.env.CODEX_BIN??'codex','-a','never','--sandbox','workspace-write','-c','model='+JSON.stringify(worker.model),
   '-c','model_reasoning_effort='+JSON.stringify(worker.effort),'-c','shell_environment_policy.inherit="none"','exec'];
  if(sessionId)args.push('resume',sessionId);
  else args.push('--ignore-user-config');
  return [...args,'--json','--skip-git-repo-check','-'];
 }
 const tools='Read,Edit,Write,Glob,Grep';
 return [process.env.CLAUDE_BIN??'claude','--print','--output-format','json','--restricted','--safe-mode','--model',worker.model,'--effort',worker.effort,
  '--permission-mode','acceptEdits','--tools',tools,'--allowedTools',tools,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
  '--disable-slash-commands','--settings','{"disableAllHooks":true}',...(sessionId?['--resume',sessionId]:[])];
}
async function modelProcess(argv:string[],workspace:string,prompt:string,timeoutMs:number){
 // Bounded output and descendant cleanup reuse the native runtime process runner.
 return runProcess(argv,{cwd:workspace,env:{...safeEnv(),USER:userInfo().username},input:prompt,timeoutMs,maxBytes:2*1024*1024});
}
async function localWorkflow(root:string,settings:Settings,concurrency:1|2){
 const versions=Object.fromEntries(['codex','claude','node'].map(command=>[command,execFileSync(command==='codex'?(process.env.CODEX_BIN??command):command==='claude'?(process.env.CLAUDE_BIN??command):command,['--version'],{env:safeEnv(),encoding:'utf8'}).trim()]));
 const snapshot=await readSnapshot(settings.fixture),roots=new Set<number>([process.pid]),sampler=createHostSampler(()=>[...roots],settings.probeRepo);
 const samples:HostSample[]=[];let stopped=false;
 const monitor=(async()=>{while(!stopped){samples.push(await sampler());if(!stopped)await sleep(1000);}})();
 const startedAt=Date.now();
 const workers:any[]=[];
 try{
  const run=async(worker:Settings['workers'][number])=>{
   const workspace=join(root,worker.provider);await mkdir(workspace,{mode:0o700});await restoreSnapshot(workspace,snapshot);
   execFileSync('git',['init','-q'],{cwd:workspace,stdio:'ignore'});
   let sessionId:string|undefined,success=false;
   const rounds:any[]=[],deadline=Date.now()+settings.workerTimeoutMs;
   for(let round=1;round<=settings.roundLimit&&Date.now()<deadline;round++){
    const feedback=rounds.at(-1)?.check?.failedChecks;
    const prompt=worker.instructions+(feedback?.length?'\nPrior independent verification failed: '+feedback.join(', '):'');
    const process=await modelProcess(nativeArgs(worker,sessionId,prompt),workspace,prompt,Math.max(1,deadline-Date.now()));
    const receipt=readReceipt(worker.provider,process.stdout);
    if(sessionId&&receipt.sessionId&&sessionId!==receipt.sessionId)throw Error('Provider session identity changed');
    sessionId??=receipt.sessionId;
    const record:any={round,process:processDiagnostic(process),durationMs:process.durationMs,receipt};rounds.push(record);
    if(process.status!=='passed'||!receipt.success||!sessionId)break;
    const current=await readSnapshot(workspace);
    // Validate each worker's exact write scope before running the independent check.
    const allowed=new Set(worker.writes);
    const old=new Map(snapshot.files.map(f=>[f.path,f.sha256]));
    const changed=new Set(current.files.filter(f=>old.get(f.path)!==f.sha256).map(f=>f.path));
    for(const file of snapshot.files)if(!current.files.some(f=>f.path===file.path))changed.add(file.path);
    if(!changed.size||[...changed].some(path=>!allowed.has(path))){record.check={passed:false,failedChecks:['write-scope']};continue;}
    const check=await runProcess(['node','acceptance.mjs',worker.target],{cwd:workspace,env:safeEnv(),timeoutMs:Math.min(settings.integrationTimeoutMs,Math.max(1,deadline-Date.now())),maxBytes:131072});
    let output:any;try{output=JSON.parse(check.stdout.trim().split('\n').at(-1)!);}catch{}
    record.check={passed:check.status==='passed'&&output?.passed===true,durationMs:check.durationMs,exitCode:check.exitCode,
      failedChecks:output?.checks?.filter((c:any)=>!c.passed).map((c:any)=>c.name)??['acceptance-result-missing'],outputSha256:hash(check.stdout)};
    if(record.check.passed){success=true;break;}
   }
   const output=await readSnapshot(workspace);
   const evidence={provider:worker.provider,model:worker.model,effort:worker.effort,sessionId,success,rounds,outputSnapshotId:output.digest};
   workers.push(evidence);await atomicJson(join(root,worker.provider+'-result.json'),evidence);
   return {success,output};
  };
  // Wait for both bounded native processes even when one worker's verification throws.
  const settled=concurrency===2?await Promise.allSettled(settings.workers.map(run)):[...(await Promise.allSettled([run(settings.workers[0])])),...(await Promise.allSettled([run(settings.workers[1])]))];
  const rejected=settled.filter(outcome=>outcome.status==='rejected').length;
  if(rejected)await atomicJson(join(root,'worker-errors.json'),{failedWorkers:rejected,message:'Worker execution or independent verification failed; native processes have settled.'});
  const outcomes=settled.flatMap(outcome=>outcome.status==='fulfilled'?[outcome.value]:[]);
  let integration:any;
  if(outcomes.length===2&&outcomes.every(o=>o.success)){
   const merged=mergeWorkflowOutputs(snapshot,outcomes.map(o=>o.output),settings.workers.map(w=>w.writes));
   const path=join(root,'integration');await mkdir(path,{mode:0o700});await restoreSnapshot(path,merged);
   const result=await runProcess(['node','integration.mjs'],{cwd:path,env:safeEnv(),timeoutMs:settings.integrationTimeoutMs,maxBytes:262144});
   let evidence:any;try{evidence=JSON.parse(result.stdout.trim().split('\n').at(-1)!);}catch{}
   integration={process:processDiagnostic(result),durationMs:result.durationMs,result:evidence,stdoutSha256:hash(result.stdout),snapshotId:merged.digest};
  }
  return {limitations:['Local Claude file tools differ from remote Bash/Agent tools; elapsed-time differences are not environment-causal.','Codex observed model unavailable in JSON events; requested model is recorded.'],status:integration?.process.status==='passed'&&integration?.result?.passed===true?'SUCCEEDED':'FAILED',versions,startedAt,finishedAt:Date.now(),workers,integration};
 }finally{stopped=true;await monitor;await atomicJson(join(root,'host.json'),{summary:summarizeHost(samples),samples});}
}
async function observeOnce(id:string,origin:string,secretsPath:string):Promise<{result:any;lifecycle:{pid:number;startedAt:number;exitedAt:number;exitCode:number}}> {
 const startedAt=Date.now();
 return new Promise((resolveResult,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./observer.ts',import.meta.url)),id,origin,secretsPath],{stdio:['ignore','pipe','pipe']});
  const chunks:Buffer[]=[];let bytes=0;
  const timeout=setTimeout(()=>child.kill('SIGTERM'),35000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024)child.kill('SIGTERM');else chunks.push(chunk);});
  child.stderr.resume();child.once('error',()=>reject(Error('Workflow observer could not start')));
  child.once('close',code=>{
   clearTimeout(timeout);
   if(code!==0||bytes>16*1024*1024){reject(Error('Workflow observer failed'));return;}
   try{resolveResult({result:JSON.parse(Buffer.concat(chunks).toString()),lifecycle:{pid:child.pid!,startedAt,exitedAt:Date.now(),exitCode:code}});}
   catch{reject(Error('Workflow observer returned invalid data'));}
  });
 });
}
export async function runWorkflowExperiment(args:string[]){
 const [mode,directory,settingsPath,origin,secretsPath]=args;
 if(!mode||!directory||!settingsPath)throw Error('Usage: workflow.ts local|remote-sequential|remote-parallel|disconnect OUTPUT SETTINGS [ORIGIN CONTROL_SECRETS]');
 const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});
 const settings:Settings=JSON.parse(await readFile(settingsPath,'utf8'));
 if(settings.version!==1||settings.workers.length!==2||settings.roundLimit<1||settings.roundLimit!==3)throw Error('Invalid workflow experiment settings');
 const marker=join(root,'started.json');
 const frozenPath=join(root,'snapshot.json');
 let frozen;try{frozen=validateSnapshot(JSON.parse(await readFile(frozenPath,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;frozen=await readSnapshot(settings.fixture);await atomicJson(frozenPath,frozen);}
 const fixture=join(root,'frozen-fixture');await mkdir(fixture,{recursive:true,mode:0o700});await restoreSnapshot(fixture,frozen);
 settings.fixture=fixture;
 if(mode==='local'){
  await writeFile(marker,JSON.stringify({mode,settingsSha256:hash(await readFile(settingsPath)),startedAt:Date.now()}),{mode:0o600,flag:'wx'});
  const result=await localWorkflow(root,settings,2);await atomicJson(join(root,'result.json'),result);console.log(JSON.stringify({status:result.status,seconds:(result.finishedAt-result.startedAt)/1000}));return;
 }
 if(!['remote-sequential','remote-parallel','disconnect'].includes(mode))throw Error('Unknown workflow experiment mode');
 const samples:HostSample[]=[],sampler=createHostSampler(()=>[process.pid],settings.probeRepo);let monitoring=true;
 const monitor=(async()=>{while(monitoring){samples.push(await sampler());if(monitoring)await sleep(1000);}})();
 try{
 const request=await cloudClient(origin??'',secretsPath??'');
 const snapshot=await readSnapshot(settings.fixture),contract=snapshot.files.find(f=>f.path==='contract.md');
 if(!contract)throw Error('Fixture contract missing');
 const spec:WorkflowSpec=validateWorkflowSpec({snapshotId:snapshot.digest,contractPath:'contract.md',contractHash:contract.sha256,
  idempotencyKey:'resource-'+hash(root).slice(0,32),concurrency:mode==='remote-sequential'?1:2,instance:'standard-3',
  workers:settings.workers.map(w=>({provider:w.provider,credentialId:w.credentialId,model:w.model,effort:w.effort,writes:w.writes,
   instructions:w.instructions,timeoutMs:settings.workerTimeoutMs,checks:[{id:w.target,argv:['node','acceptance.mjs',w.target],timeoutMs:settings.integrationTimeoutMs}]})),
  integration:{id:'integration',argv:['node','integration.mjs'],timeoutMs:settings.integrationTimeoutMs}});
 await request('/v1/snapshots/'+snapshot.digest,'PUT',snapshot);
 let saved:any;
 try{saved=JSON.parse(await readFile(marker,'utf8'));}catch{}
 if(saved&&saved.specSha256!==hash(JSON.stringify(spec)))throw Error('Workflow input changed since submission');
 if(!saved){const workflow=await request('/v1/workflows','POST',spec);saved={mode,specSha256:hash(JSON.stringify(spec)),id:workflow.id,createdAt:Date.now()};await atomicJson(marker,saved);}
 const approved=await request('/v1/workflows/'+saved.id+'/approve','POST');
 saved.approvedAt=approved.approvedAt;await atomicJson(marker,saved);
 let disconnected=await readFile(join(root,'disconnect.json'),'utf8').then(JSON.parse,()=>undefined);
 if(disconnected&&!disconnected.reconnectedAt){
  await sleep(Math.max(0,disconnected.startedAt+disconnected.durationMs-Date.now()));
  disconnected.reconnectedAt=Date.now();await atomicJson(join(root,'disconnect.json'),disconnected);
 }
 const until=Math.min(saved.approvedAt+3600000,approved.deadline??saved.approvedAt+3600000)+30000;
 while(Date.now()<until){
  let observed:Awaited<ReturnType<typeof observeOnce>>|undefined,state:any;
  try{observed=mode==='disconnect'?await observeOnce(saved.id,origin!,secretsPath!):undefined;state=observed?.result??await request('/v1/workflows/'+saved.id);}catch{await sleep(2000);continue;}
  await atomicJson(join(root,'latest.json'),state);
  if(mode==='disconnect'&&!disconnected&&state.workers?.some((w:any)=>w.status==='RUNNING')){
   disconnected={startedAt:Date.now(),durationMs:300000,observer:observed?.lifecycle,before:state.workers.map((w:any)=>({id:w.id,status:w.status,startedAt:w.startedAt}))};
   await atomicJson(join(root,'disconnect.json'),disconnected);
   // The one-shot observer has exited before the gap. The parent stores only the resume marker and timer.
   await sleep(300000);
   disconnected.reconnectedAt=Date.now();await atomicJson(join(root,'disconnect.json'),disconnected);continue;
  }
  if(terminal.has(state.workflow.status)){
   const result=await request('/v1/workflows/'+saved.id+'/result');
   if(disconnected){
    const ended=result.workers.map((w:any)=>w.job).concat(result.integration?.job?[result.integration.job]:[]);
    disconnected.completedDuringGap=ended.filter((w:any)=>w.finishedAt>=disconnected.startedAt&&w.finishedAt<=disconnected.reconnectedAt).map((w:any)=>w.id);
    const again=await request('/v1/workflows/'+saved.id+'/result');
    const artifacts=(value:any)=>({outputSnapshotId:value.output?.digest??null,integrationResultSha256:hash(JSON.stringify(value.integration?.result??null)),workerResultSha256:value.workers.map((w:any)=>({id:w.job.id,sha256:hash(JSON.stringify(w.result??null))}))});
    disconnected.firstArtifacts=artifacts(result);disconnected.requeriedArtifacts=artifacts(again);
    disconnected.artifactsStable=JSON.stringify(disconnected.firstArtifacts)===JSON.stringify(disconnected.requeriedArtifacts);
    disconnected.integrationCompletedDuringGap=!!result.integration?.job&&disconnected.completedDuringGap.includes(result.integration.job.id);
    disconnected.verified=disconnected.integrationCompletedDuringGap&&disconnected.artifactsStable&&result.workflow.status==='SUCCEEDED';
    await atomicJson(join(root,'disconnect.json'),disconnected);
   }
   await atomicJson(join(root,'result.json'),result);console.log(JSON.stringify({status:result.workflow.status,id:saved.id,disconnect:disconnected?.verified??false}));return;
  }
  await sleep(2000);
 }
 const cancellations:any[]=[];
 // Cancel all still-live child jobs; the server also enforces its persisted workflow deadline.
 try{const latest=await request('/v1/workflows/'+saved.id);for(const job of [...latest.workers,...(latest.integration?[latest.integration]:[])]){if(!terminal.has(job.status)){try{await request('/v1/jobs/'+job.id+'/cancel','POST');cancellations.push({id:job.id,requested:true});}catch{cancellations.push({id:job.id,requested:false});}}}}catch{}
 await atomicJson(join(root,'observation-timeout.json'),{at:Date.now(),id:saved.id,serverDeadline:approved.deadline,cancellations,requiresReconciliation:true});
 throw Error('Workflow observation deadline reached; cancellation requested; reconcile same workflow');
 }finally{monitoring=false;await monitor;await atomicJson(join(root,'host.json'),{summary:summarizeHost(samples),samples});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 runWorkflowExperiment(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error&&/^(Usage:|Invalid |Fixture |Workflow |Unknown |Backend |Control|Use an )/.test(error.message)?error.message:'Workflow experiment failed');process.exitCode=1;});
}
