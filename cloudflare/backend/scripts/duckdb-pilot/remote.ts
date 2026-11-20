import {validBoundaryCheck,validDataPostcondition} from './remote/probe-policy.ts';
import {mkdir,readFile,writeFile,open,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {readSnapshot} from '../../src/files.ts';
import {validateLargeArtifacts,type LargeArtifactRef} from '../../src/large-artifact.ts';
import {terminal} from '../../src/contracts.ts';
import {atomicJson,cloudClient} from '../resource-validation/experiment.ts';
const HERE=dirname(fileURLToPath(import.meta.url));
const COMMIT='68d7555f68bd25c1a251ccca2e6338949c33986a';
const SOURCE_SHA='2e1a219620dd1ca6bf055600417bdf9a1700e04c5c1ff41e4029752595137785';
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
async function json(path:string):Promise<any>{return JSON.parse(await readFile(path,'utf8'));}
async function optional(path:string){try{return await json(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
function ref(value:any){return value?.ref??value;}
function receipt(result:any){
 try{
  const value=JSON.parse(result.process.stdout.trim().split('\n').at(-1));
  if(value.ninja?.encoding==='brotli-delta-v1'){
   const suffix=/^NINJA_EVIDENCE_V1 ([A-Za-z0-9+/=]+)$/m.exec(result.process.stderr)?.[1]??'';
   const data=value.ninja.data+suffix;
   if(createHash('sha256').update(Buffer.from(data,'base64')).digest('hex')!==value.ninja.sha256)return undefined;
   value.ninja.data=data;
  }
  return value;
 }catch{return undefined;}
}
function stopped(state:any){return [...(state.jobs??[]),...(state.integration?[state.integration]:[])].every((x:any)=>terminal(x.job.status)&&x.job.containerStopped===true);}
const cacheModes={ 'ccache-seed':'seed','ccache-cold':'cold','ccache-warm':'warm' } as const;
type CacheMode=typeof cacheModes[keyof typeof cacheModes];
function validCache(mode:CacheMode,stats:any,evidence:any):boolean {
 const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const count=(value:number)=>Number.isSafeInteger(value)&&value>=0;
 if(stats?.version!=='4.14.3'||![stats.hits,stats.directHits,stats.preprocessedHits,stats.misses,stats.uncacheable,stats.filesInCache,stats.sizeKiB].every(count)||
   stats.hits!==stats.directHits+stats.preprocessedHits||stats.hits+stats.misses===0||evidence?.mode!==mode||!count(evidence.restoreMs))return false;
 if(mode==='warm')return digest(evidence.restoredSha256)&&count(evidence.restoredBytes)&&evidence.restoredBytes>0&&evidence.published===undefined;
 if(evidence.restoredSha256!==undefined||evidence.restoredBytes!==undefined)return false;
 if(mode==='cold')return evidence.published===undefined;
 return digest(evidence.published?.sha256)&&count(evidence.published.sizeBytes)&&evidence.published.sizeBytes>0&&count(evidence.published.durationMs);
}
async function withLock(root:string,fn:()=>Promise<void>){
 const path=join(root,'operator.lock');let handle;
 try{handle=await open(path,'wx',0o600);}catch{
  const old=await optional(path);if(!old||old.host!==hostname()||!Number.isSafeInteger(old.pid))throw Error('Remote pilot lock needs inspection');
  let live=true;try{process.kill(old.pid,0);}catch{live=false;}if(live)throw Error('Remote pilot operator already running');
  await unlink(path);handle=await open(path,'wx',0o600);
 }
 try{await handle.writeFile(JSON.stringify({host:hostname(),pid:process.pid}));await fn();}finally{await handle.close();await unlink(path);}
}
export async function remotePilot(args:string[]){
 const [requestedPhase,directory,sourceRefPath,dataRefPath,origin,secrets,parallel]=args;
 const cacheMode=requestedPhase&&Object.hasOwn(cacheModes,requestedPhase)?cacheModes[requestedPhase as keyof typeof cacheModes]:undefined;
 const cacheCampaign=cacheMode?process.env.DUCKDB_CACHE_CAMPAIGN:undefined;
 if(cacheCampaign!==undefined&&!/^[a-z0-9-]{1,40}$/.test(cacheCampaign))throw Error('Pilot cache campaign is invalid');
 const controlled=requestedPhase==='jemalloc-off'||cacheMode!==undefined;
 const matrix=requestedPhase==='matrix'||controlled;
 const profiles=controlled?['C3','C4']:['C1','C2','C3','C4'];
 const concurrency=cacheMode?2:matrix?Number(parallel):1;
 if(![1,2,4].includes(concurrency))throw Error('Invalid pilot concurrency');
 const inlineBoundary=requestedPhase==='boundary-then-build';
 const phase=inlineBoundary||matrix?'build':requestedPhase;
 if(!['boundary','build'].includes(phase??'')||!directory||!sourceRefPath||!dataRefPath||!origin||!secrets)throw Error('Usage: remote.ts boundary|build|boundary-then-build|matrix|jemalloc-off|ccache-seed|ccache-cold|ccache-warm OUTPUT_ROOT SOURCE_REF_JSON DATA_REF_JSON_OR_- ORIGIN PRIVATE_CONTROL_JSON [CONCURRENCY]');
 const out=resolve(directory),root=join(out,phase!);await mkdir(root,{recursive:true,mode:0o700});
 await withLock(root,async()=>{
  const completed=await optional(join(root,'result.json'));if(completed){console.log(JSON.stringify({phase,status:completed.group?.status,verified:completed.validation?.passed===true,reused:true}));if(!completed.validation?.passed)throw Error('Existing pilot failed; preserve evidence and use a new run root');return;}
  const refs=validateLargeArtifacts([ref(await json(sourceRefPath)),...(dataRefPath==='-'?[]:[ref(await json(dataRefPath))])]);
  if(refs[0]!.name!=='source'||refs[0]!.sha256!==SOURCE_SHA||refs.length===2&&refs[1]!.name!=='data')throw Error('Pilot source or artifact names differ from approved fixture');
  if(controlled&&refs.length!==2)throw Error('Pinned Linux tools artifact required');
  const request=await cloudClient(origin,secrets);
  const health=await(await fetch(new URL('/health',origin),{redirect:'error',signal:AbortSignal.timeout(15000)})).json() as any;
  if(!/^[a-f0-9]{64}$/.test(health.expectedRuntimeRevision??''))throw Error('Runtime revision unavailable');
  if(matrix&&process.env.DUCKDB_MATRIX_RUNTIME!==health.expectedRuntimeRevision)throw Error('Runtime revision changed during matrix');
  const binding={commit:COMMIT,refs,runtimeRevision:health.expectedRuntimeRevision};
  if(phase==='build'&&!inlineBoundary&&!matrix){
   const prior=await optional(join(out,'boundary','result.json')),plan=await optional(join(out,'boundary','plan.json'));
   if(prior?.validation?.passed!==true||prior.group?.status!=='SUCCEEDED'||plan?.binding?.runtimeRevision!==binding.runtimeRevision||refs.some(r=>!plan.binding.refs.some((p:LargeArtifactRef)=>JSON.stringify(p)===JSON.stringify(r))))throw Error('Matching remote boundary must pass before build');
  }
  const snapshotDir=join(root,'snapshot');await mkdir(snapshotDir,{recursive:true,mode:0o700});
  await writeFile(join(snapshotDir,'runner.mjs'),await readFile(join(HERE,'remote','runner.mjs')),{mode:0o600});
  await writeFile(join(snapshotDir,'toolchain.ts'),await readFile(join(HERE,'remote','toolchain.ts')),{mode:0o600});
  await writeFile(join(snapshotDir,'probe-policy.ts'),await readFile(join(HERE,'remote','probe-policy.ts')),{mode:0o600});
  await writeFile(join(snapshotDir,'projection-tests.txt'),await readFile(join(HERE,'projection-tests.txt')),{mode:0o600});
  for(const name of ['build-evidence.mjs','install-build-tools.py','build-cpu.py','cache-stats.ts'])await writeFile(join(snapshotDir,name),await readFile(join(HERE,'remote',name)),{mode:0o600});
  await writeFile(join(snapshotDir,'inventory.py'),await readFile(join(HERE,'inventory.py')),{mode:0o600});
  await writeFile(join(snapshotDir,'runner-config.json'),JSON.stringify({phase,commit:COMMIT,...(controlled?{jemallocOff:true}:{}),...(cacheMode?{ccache:true,cacheCampaign}:{})}),{mode:0o600});
  await writeFile(join(snapshotDir,'integration.mjs'),'console.log(JSON.stringify({passed:true,kind:"lifecycle-aggregation",rebuild:false}));\n',{mode:0o600});
  const snapshot=await readSnapshot(snapshotDir);
  const spec={snapshotId:snapshot.digest,idempotencyKey:'duckdb-p0-'+phase+'-'+hash(cacheMode?JSON.stringify([root,snapshot.digest,cacheMode,binding.runtimeRevision]):root).slice(0,40),concurrency,instance:'standard-4',artifacts:refs,checks:matrix?profiles.map(id=>({id,argv:cacheMode?['node','runner.mjs',id,cacheMode]:['node','runner.mjs',id],timeoutMs:3600000})):[{id:phase,argv:['node','runner.mjs'],timeoutMs:phase==='build'?3600000:600000}],integration:{id:'aggregate',argv:['node','integration.mjs'],timeoutMs:120000}};
  const specSha256=hash(JSON.stringify(spec)),plan={binding,spec,specSha256};
  const oldPlan=await optional(join(root,'plan.json'));if(oldPlan&&JSON.stringify(oldPlan)!==JSON.stringify(plan))throw Error('Pilot input changed since submission');
  if(!oldPlan)await atomicJson(join(root,'plan.json'),plan);
  await atomicJson(join(root,'snapshot.json'),snapshot);await request('/v1/snapshots/'+snapshot.digest,'PUT',snapshot);
  let saved=await optional(join(root,'started.json'));
  if(saved&&saved.specSha256!==specSha256)throw Error('Pilot submission binding changed');
  if(!saved){const group=await request('/v1/compute-groups','POST',spec);saved={id:group.id,specSha256,createdAt:Date.now()};await atomicJson(join(root,'started.json'),saved);}
  const approved=await request('/v1/compute-groups/'+saved.id+'/approve','POST');
  if(!Number.isFinite(approved.deadline)||!Number.isFinite(approved.approvedAt))throw Error('Approved server deadline missing');
  if(saved.deadline!==undefined&&saved.deadline!==approved.deadline)throw Error('Server deadline changed on resume');
  saved.deadline=approved.deadline;saved.approvedAt=approved.approvedAt;await atomicJson(join(root,'started.json'),saved);
  let state:any;
  const path='/v1/compute-groups/'+saved.id;
  while(Date.now()<saved.deadline+30000){
   try{state=await request(path);await atomicJson(join(root,'latest.json'),state);}catch{await sleep(5000);continue;}
   if(['SUCCEEDED','FAILED','CANCELLED'].includes(state.group.status)&&stopped(state))break;
   await sleep(5000);
  }
  if(!state||!['SUCCEEDED','FAILED','CANCELLED'].includes(state.group.status)||!stopped(state)){
   await request(path+'/cancel','POST');await atomicJson(join(root,'cancel.json'),{requestedAt:Date.now(),reason:'server-deadline-observation-expired'});
   const until=Date.now()+120000;
   while(Date.now()<until){try{state=await request(path);await atomicJson(join(root,'latest.json'),state);if(stopped(state)&&['SUCCEEDED','FAILED','CANCELLED'].includes(state.group.status))break;}catch{}await sleep(5000);}
   if(!state||!stopped(state))throw Error('Cancellation reconciliation incomplete; inspect live group');
  }
  if(matrix){
   const outcomes=(state.jobs??[]).map((item:any)=>{
    const r=receipt(item.result), input=item.result?.largeArtifacts;
    const required=['source-write','source-delete','runtime-input-read','proc-root-runtime-input-read',...(controlled?['data-write','data-delete']:[])];
    const verified=item.job.status==='SUCCEEDED'&&item.job.containerStopped===true&&item.result?.boundary?.verified===true&&
     input?.receipts?.[0]?.sha256===refs[0]!.sha256&&input?.receipts?.[0]?.sizeBytes===refs[0]!.sizeBytes&&
     r?.profile===item.job.checkId&&r?.passed===true&&r.boundaries?.passed===true&&
     required.every(name=>r.boundaries.checks.some((check:any)=>check.name===name&&validBoundaryCheck(check)))&&
     r.test?.passed===true&&r.test.inventoryCount===16&&r.toolchain?.compiler?.id==='Clang'&&
     (!controlled||(validDataPostcondition(r.boundaries.data,refs[1]!)&&input?.receipts?.[1]?.sha256===refs[1]!.sha256&&
      r.buildCpu?.usageUsec>0&&typeof r.ninja?.data==='string'&&r.toolchain.cmakeVersion==='3.31.6'&&r.toolchain.ninjaVersion?.split('.git.')[0]==='1.13.0'))&&
     (!cacheMode||validCache(cacheMode,r.cacheStats,item.result?.buildCache));
    return {profile:item.job.checkId,verified,receipt:r};
   });
   const passed=state.group.status==='SUCCEEDED'&&stopped(state)&&receipt(state.integration?.result)?.passed===true&&
    outcomes.length===profiles.length&&profiles.every(profile=>outcomes.some((o:any)=>o.profile===profile&&o.verified));
   await atomicJson(join(root,'result.json'),{...state,outcomes,validation:{passed}});
   console.log(JSON.stringify({id:saved.id,concurrency,status:state.group.status,verified:passed}));
   if(!passed)throw Error('Pilot matrix did not satisfy verification');
   return;
  }
  const workload=state.jobs?.[0],body=receipt(workload?.result),integrated=receipt(state.integration?.result),preparation=workload?.result?.largeArtifacts;
  const inputVerified=Array.isArray(preparation?.receipts)&&preparation.receipts.length===refs.length&&refs.every((r,i)=>preparation.receipts[i]?.sha256===r.sha256&&preparation.receipts[i]?.sizeBytes===r.sizeBytes);
  const requiredChecks=['source-write','source-delete','runtime-input-read','proc-root-runtime-input-read',...(refs.length===2?['data-write','data-delete']:[])];
  const checks=body?.boundaries?.checks;
  const boundaryPassed=body?.boundaries?.passed===true&&Array.isArray(checks)&&checks.length===requiredChecks.length&&new Set(checks.map((x:any)=>x.name)).size===requiredChecks.length&&requiredChecks.every(name=>checks.some((x:any)=>x.name===name&&validBoundaryCheck(x)))&&body.boundaries.credentialsAbsent===true&&body.boundaries.scratchWritable===true&&body.boundaries.sourceUnchanged===true&&body.boundaries.sourceTree?.files===14010&&body.boundaries.sourceTree?.bytes===260659090;
  const dataVerified=refs.length===1||validDataPostcondition(body?.boundaries?.data,refs[1]!);
  const runtimeBoundaryPassed=workload?.result?.boundary?.verified===true;
  const toolchain=body?.toolchain;
  const toolchainVerified=phase!=='build'||toolchain?.compiler?.id==='Clang'&&toolchain.compiler.path==='/usr/bin/clang++'&&/^[0-9]+(?:\.[0-9]+){1,3}$/.test(toolchain.compiler.version??'')&&typeof toolchain.cmakeVersion==='string'&&typeof toolchain.ninjaVersion==='string'&&toolchain.platform==='linux'&&['x64','arm64'].includes(toolchain.arch)&&toolchain.flagsScope==='global-and-Release-cache-entries'&&/^[a-f0-9]{64}$/.test(toolchain.compilerConfigSha256??'')&&/^[a-f0-9]{64}$/.test(toolchain.cmakeCacheSha256??'');
  const passed=toolchainVerified&&runtimeBoundaryPassed&&state.group.status==='SUCCEEDED'&&stopped(state)&&workload?.job.status==='SUCCEEDED'&&body?.passed===true&&inputVerified&&boundaryPassed&&dataVerified&&integrated?.passed===true&&(phase!=='build'||body.test?.passed===true&&(!refs[1]||body.query9?.dataSha256===refs[1].sha256));
  const result={...state,validation:{passed,inputVerified,boundaryPassed,dataVerified,runtimeBoundaryPassed,toolchainVerified},receipt:body,observedAt:Date.now()};await atomicJson(join(root,'result.json'),result);
  console.log(JSON.stringify({phase,id:saved.id,status:state.group.status,verified:passed,seconds:(state.group.finishedAt-state.group.approvedAt)/1000}));
  if(!passed)throw Error('Pilot result did not satisfy verification');
 });
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)remotePilot(process.argv.slice(2)).catch(error=>{const message=error instanceof Error&&/^(Usage:|Remote pilot|Existing pilot|Pilot |Matching remote|Runtime revision|Approved server|Server deadline|Cancellation reconciliation)/.test(error.message)?error.message:'Remote pilot failed; inspect private evidence';console.error(message);process.exitCode=1;});
