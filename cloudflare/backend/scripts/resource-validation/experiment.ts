import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,open,unlink,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {hostname,platform,arch,cpus,totalmem} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {readSnapshot,restoreSnapshot} from '../../src/files.ts';
import {validateSnapshot} from '../../src/snapshot.ts';
import type {Snapshot} from '../../src/contracts.ts';
import {createHostSampler,summarizeHost,type HostSample} from './host-metrics.ts';

type Concurrency=1|2|4;
interface Condition {id:string;block:number;environment:'local'|'cloudflare';concurrency:Concurrency}
interface Manifest {version:1;id:string;createdAt:string;inputCommit:string;inputSnapshotId:string;fixtureRoot:string;probeRepo:string;
 seed:number;conditions:Condition[];jobs:{id:string;argv:string[];timeoutMs:number}[];integration:{id:string;argv:string[];timeoutMs:number};
 instance:'standard-3';baselineMs:number;sampleIntervalMs:number;machine:{platform:string;arch:string;cpuCount:number;memoryBytes:number};}
interface LocalProcess {id:string;startedAt:number;finishedAt:number;exitCode:number|null;signal:string|null;timedOut:boolean;result?:unknown;outputSha256:string;stderrSha256:string;capturedBytes:number;truncated:boolean;}
interface RunRecord {id:string;status:'PREPARING'|'RUNNING'|'SUCCEEDED'|'FAILED'|'INTERRUPTED';startedAt:number;finishedAt?:number;verifiedAt?:number;
 remoteId?:string;draftAt?:number;approvalAt?:number;jobs?:LocalProcess[];integration?:LocalProcess;remote?:unknown;hostSummary?:ReturnType<typeof summarizeHost>;error?:string;}
interface Ledger {version:1;manifestSha256:string;baseline?:{startedAt:number;finishedAt:number;hostSummary:ReturnType<typeof summarizeHost>};runs:Record<string,RunRecord>}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export async function atomicJson(path:string,value:unknown){
 const temporary=path+'.'+randomUUID()+'.tmp';const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 await rename(temporary,path);
}
export function matrix(seed:number):Condition[]{
 let state=seed>>>0;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
 const rows:Condition[]=[];
 for(let block=1;block<=3;block++){
  const values:Condition[]=[];
  for(const environment of ['local','cloudflare'] as const)for(const concurrency of [1,2,4] as const)
   values.push({id:`a-b${block}-${environment}-c${concurrency}`,block,environment,concurrency});
  for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j]!,values[i]!];}
  rows.push(...values);
 }
 return rows;
}
async function ownRunDirectory(root:string,fn:()=>Promise<void>){
 await mkdir(root,{recursive:true,mode:0o700});
 const lockPath=join(root,'operator.lock');
 let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch{throw Error('An experiment operator lock already exists. Inspect its PID before removing it.');}
 try{await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname()}));await lock.sync();await fn();}
 finally{await lock.close();await unlink(lockPath);}
}
export function safeEnv(){
 const env:NodeJS.ProcessEnv={PATH:dirname(process.execPath)+':'+process.env.PATH,HOME:process.env.HOME,CI:'1',TERM:'dumb'};
 for(const key of ['TMPDIR','TMP','TEMP','LANG','LC_ALL','HURL_BIN','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'])if(process.env[key])env[key]=process.env[key];
 return env;
}
export function validFixtureReceipt(job:LocalProcess){
 const result=job.result as {passed?:boolean;files?:number;requests?:number}|undefined;
 const shard=Number(job.id.replace('shard-',''));
 const expected=job.id==='full-regression'?[13,154]:[[3,49],[3,44],[3,27],[4,34]][shard];
 return job.exitCode===0&&!job.truncated&&!job.timedOut&&result?.passed===true&&!!expected&&result.files===expected[0]&&result.requests===expected[1];
}
export async function executeLocal(spec:Manifest['integration'],workspace:string,roots:Set<number>):Promise<LocalProcess>{
 const startedAt=Date.now();
 return new Promise((resolveResult,reject)=>{
  const child=spawn(spec.argv[0]!,spec.argv.slice(1),{cwd:workspace,env:safeEnv(),detached:true,stdio:['ignore','pipe','pipe']});
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,truncated=false,timedOut=false;
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},spec.timeoutMs);
  const hardTimer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}},spec.timeoutMs+2000);
  child.on('spawn',()=>{if(child.pid)roots.add(child.pid);});
  const capture=(target:Buffer[],data:Buffer)=>{bytes+=data.length;if(bytes>1024*1024){truncated=true;kill();return;}target.push(data);};
  child.stdout.on('data',d=>capture(stdout,d));child.stderr.on('data',d=>capture(stderr,d));
  child.on('error',()=>{clearTimeout(timer);clearTimeout(hardTimer);reject(Error('Local fixture process could not start'));});
  child.on('close',async(exitCode,signal)=>{
   clearTimeout(timer);clearTimeout(hardTimer);if(child.pid)roots.delete(child.pid);
   kill();
   if(child.pid){const until=Date.now()+1500;let alive=true;while(alive&&Date.now()<until){try{process.kill(-child.pid,0);await sleep(20);}catch{alive=false;}}if(alive)try{process.kill(-child.pid,'SIGKILL');}catch{}}
   const out=Buffer.concat(stdout),err=Buffer.concat(stderr);
   let result:unknown;
   try{result=JSON.parse(out.toString('utf8').trim().split('\n').at(-1)!);}catch{}
   resolveResult({id:spec.id,startedAt,finishedAt:Date.now(),exitCode,signal,timedOut,result,outputSha256:hash(out),stderrSha256:hash(err),capturedBytes:bytes,truncated});
  });
 });
}
export async function measure(root:string,name:string,manifest:Manifest,roots:Set<number>,operation:()=>Promise<void>){
 const path=join(root,name+'.host.jsonl');const file=await open(path,'a',0o600);
 const samples:HostSample[]=[],sampler=createHostSampler(()=>[...roots],manifest.probeRepo);
 let done=false;
 const monitor=(async()=>{while(!done){const sample=await sampler();samples.push(sample);await file.write(JSON.stringify(sample)+'\n');if(!done)await sleep(manifest.sampleIntervalMs);}})();
 try{await operation();}finally{done=true;await monitor;await file.sync();await file.close();}
 return summarizeHost(samples);
}
export async function cloudClient(origin:string,secrets:string){
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Use an HTTPS backend origin');
 const info=await stat(secrets);if(!info.isFile()||info.mode&0o077)throw Error('Control-secret file must be private');
 const {CONTROL_TOKEN}=JSON.parse(await readFile(secrets,'utf8'));
 if(typeof CONTROL_TOKEN!=='string'||!CONTROL_TOKEN||/[\r\n]/.test(CONTROL_TOKEN))throw Error('Control token missing');
 return async(path:string,method='GET',body?:unknown)=>{
  const response=await fetch(new URL(path,url),{method,headers:{authorization:'Bearer '+CONTROL_TOKEN,'content-type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw Error('Backend request rejected '+response.status);
  return response.json() as Promise<any>;
 };
}
async function initialize(root:string,fixtureRoot:string,probeRepo:string){
 const snapshot=await readSnapshot(fixtureRoot);
 if(await stat(join(root,'manifest.json')).catch(()=>false))throw Error('Manifest already exists');
 const inputCommit=execFileSync('git',['-C',probeRepo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const manifest:Manifest={version:1,id:randomUUID(),createdAt:new Date().toISOString(),inputCommit,inputSnapshotId:snapshot.digest,
  fixtureRoot,probeRepo,seed:20261113,conditions:matrix(20261113),jobs:[0,1,2,3].map(i=>({id:'shard-'+i,argv:['node','run-shard.mjs',String(i)],timeoutMs:600000})),
  integration:{id:'full-regression',argv:['node','run-shard.mjs','all'],timeoutMs:600000},instance:'standard-3',baselineMs:300000,sampleIntervalMs:1000,
  machine:{platform:platform(),arch:arch(),cpuCount:cpus().length,memoryBytes:totalmem()}};
 await atomicJson(join(root,'snapshot.json'),snapshot);await atomicJson(join(root,'manifest.json'),manifest);
 const manifestSha256=hash(await readFile(join(root,'manifest.json')));
 await atomicJson(join(root,'ledger.json'),{version:1,manifestSha256,runs:{}} satisfies Ledger);
 console.log(JSON.stringify({id:manifest.id,snapshot:snapshot.digest,conditions:manifest.conditions.length}));
}
export async function runExperiment(args:string[]){
 const [command,directory,fixtureOrOrigin,secretsOrRepo]=args;
 if(!directory)throw Error('Usage: experiment.ts init|baseline|local|local-prefix|cloud|all DIRECTORY [FIXTURE|ORIGIN] [REPO|CONTROL_SECRETS]');
 const root=resolve(directory);
 await ownRunDirectory(root,async()=>{
  if(command==='init'){
   if(!fixtureOrOrigin)throw Error('Fixture directory required');
   await initialize(root,resolve(fixtureOrOrigin),resolve(secretsOrRepo??process.cwd()));return;
  }
  const manifestBytes=await readFile(join(root,'manifest.json'));
  const manifest:Manifest=JSON.parse(manifestBytes.toString());const ledger:Ledger=JSON.parse(await readFile(join(root,'ledger.json'),'utf8'));
  if(ledger.manifestSha256!==hash(manifestBytes))throw Error('Experiment manifest changed');
  const snapshot:Snapshot=validateSnapshot(JSON.parse(await readFile(join(root,'snapshot.json'),'utf8')));
  if(snapshot.digest!==manifest.inputSnapshotId)throw Error('Experiment snapshot changed');
  const save=()=>atomicJson(join(root,'ledger.json'),ledger);
  const roots=new Set<number>();
  if(command==='baseline'){
   if(ledger.baseline){console.log('Baseline already recorded');return;}
   const startedAt=Date.now();
   const hostSummary=await measure(root,'baseline',manifest,roots,async()=>{await sleep(manifest.baselineMs);});
   ledger.baseline={startedAt,finishedAt:Date.now(),hostSummary};await save();console.log(JSON.stringify(ledger.baseline));return;
  }
  if(!['local','local-prefix','cloud','all'].includes(command??''))throw Error('Unknown experiment command');
  const request=(command==='local'||command==='local-prefix')?undefined:await cloudClient(fixtureOrOrigin??'',secretsOrRepo??'');
  if(!ledger.baseline)throw Error('Record the 5-minute idle baseline first');
  for(const condition of manifest.conditions){
   if(command==='local'&&condition.environment!=='local'||command==='cloud'&&condition.environment!=='cloudflare')continue;
   let record=ledger.runs[condition.id];
   if(record&&['SUCCEEDED','FAILED','INTERRUPTED'].includes(record.status))continue;
   if(command==='local-prefix'&&condition.environment!=='local')break;
   if(record?.status==='RUNNING'&&condition.environment==='local'){
    record.status='INTERRUPTED';record.finishedAt=Date.now();record.error='Local operator interrupted; this attempt remains a failed observation';await save();continue;
   }
   record??={id:condition.id,status:'PREPARING',startedAt:Date.now()};ledger.runs[condition.id]=record;await save();
   const current=record;
   console.log(JSON.stringify({condition:condition.id,state:'starting'}));
   current.hostSummary=await measure(root,condition.id,manifest,roots,async()=>{
    try{
     if(condition.environment==='local'){
      current.status='RUNNING';current.approvalAt=Date.now();current.jobs=[];await save();
      let cursor=0;
      const pool=Array.from({length:condition.concurrency},async()=>{
       while(cursor<manifest.jobs.length){
        const spec=manifest.jobs[cursor++]!;
        const workspace=join(root,'work',condition.id,spec.id);await mkdir(workspace,{recursive:true,mode:0o700});await restoreSnapshot(workspace,snapshot);
        current.jobs!.push(await executeLocal(spec,workspace,roots));await save();
       }
      });await Promise.all(pool);
      if(current.jobs.every(validFixtureReceipt)){
       const workspace=join(root,'work',condition.id,'integration');await mkdir(workspace,{recursive:true,mode:0o700});await restoreSnapshot(workspace,snapshot);
       current.integration=await executeLocal(manifest.integration,workspace,roots);
      }
      current.status=current.integration&&validFixtureReceipt(current.integration)?'SUCCEEDED':'FAILED';
      current.verifiedAt=current.integration?.finishedAt;
     }else{
      await request!('/v1/snapshots/'+snapshot.digest,'PUT',snapshot);
      if(!current.remoteId){
       const group=await request!('/v1/compute-groups','POST',{snapshotId:snapshot.digest,idempotencyKey:manifest.id+':'+condition.id,
        concurrency:condition.concurrency,checks:manifest.jobs,integration:manifest.integration,instance:manifest.instance});
       current.remoteId=group.id;current.draftAt=Date.now();await save();
      }
      const group=await request!('/v1/compute-groups/'+current.remoteId+'/approve','POST');
      current.status='RUNNING';current.approvalAt=group.approvedAt;await save();
      const deadline=Date.now()+3600000;
      while(Date.now()<deadline){
       let result:any;
       try{result=await request!('/v1/compute-groups/'+current.remoteId);}catch{await sleep(2000);continue;}
       current.remote=result;await save();
       if(['SUCCEEDED','FAILED','CANCELLED'].includes(result.group.status)){
        current.status=result.group.status==='SUCCEEDED'?'SUCCEEDED':'FAILED';current.verifiedAt=result.group.finishedAt;break;
       }
       await sleep(2000);
      }
      if(current.status==='RUNNING')throw Error('Remote experiment wait expired');
     }
    }catch(error){
     current.error=error instanceof Error&&/^(Backend request rejected \d+|Remote experiment wait expired|Local fixture process could not start)$/.test(error.message)?error.message:'Experiment execution failed';
     // Preserve the remote identity so a resumed operator reconciles the same group.
     if(!current.remoteId)current.status='FAILED';
     throw error;
    }finally{if(current.status==='SUCCEEDED'||current.status==='FAILED')current.finishedAt=Date.now();await save();}
   });
   await save();console.log(JSON.stringify({condition:condition.id,status:current.status,seconds:(current.finishedAt!-current.startedAt)/1000,approvalToVerifiedSeconds:current.verifiedAt&&current.approvalAt?(current.verifiedAt-current.approvalAt)/1000:null,host:current.hostSummary}));
   if(current.status==='FAILED')throw Error('Experiment condition failed; inspect evidence before continuing');
  }
 });
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 runExperiment(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error&&/^(Usage:|Fixture |Manifest |Experiment |Control|Use an |Backend |Record |Unknown |An experiment)/.test(error.message)?error.message:'Resource experiment failed');process.exitCode=1;});
}
