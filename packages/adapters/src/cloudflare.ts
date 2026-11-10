import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CloudPort, CloudTask, CloudSubmission, CloudPoll, CloudEvidence, CloudProcess } from '../../contracts/src/cloudflare.js';
import type { RepositoryPolicy } from '../../contracts/src/index.js';
import { createWorkspace, type Workspace } from './workspace.js';
import { processEnvironment, runProcess } from './process.js';

export interface CloudPortOptions {
  baseUrl:string; controlToken:string; repositoryPath:string; worktreeRoot:string; policy:RepositoryPolicy;
  credentialIds:{codex:string;claude:string}; checks:Array<{id:string;argv:string[];timeoutMs:number}>;
  timeoutMs?:number; moduleRoot?:string;
}
interface Snapshot {version:1;digest:string;files:Array<{path:string;content:string;sha256:string;executable:boolean}>}
interface Spec {provider:'codex'|'claude';credentialId:string;snapshotId:string;instructions:string;checks:CloudPortOptions['checks'];timeoutMs:number;idempotencyKey:string}
interface Job {id:string;kind:string;provider?:string;credentialId?:string;snapshotId:string;outputSnapshotId?:string;status:string;checks:Spec['checks'];childIds:string[];parentId?:string;checkId?:string;argv?:string[];containerStopped:boolean;authSynced:boolean;errorCode?:string}
interface Result {process:CloudProcess;summary:string;sourceUnchanged:boolean;credentialsAbsent?:boolean}
interface ClientResult {job:Job;input:Snapshot;output:Snapshot;result?:Result;checks?:Array<{job:Job;result?:Result}>}
interface Client {upload(value:Snapshot):Promise<string>;submit(value:Spec):Promise<Job>;get(id:string):Promise<Job>;result(id:string):Promise<ClientResult>}
interface Native {
 createClient(url:string,token:string,fetchImpl:typeof fetch):Client;
 readSnapshot(path:string):Promise<Snapshot>;
 applySnapshot(path:string,input:Snapshot,output:Snapshot):Promise<void>;
 validateSnapshot(value:unknown):Snapshot;
 validateJobSpec(value:unknown):Spec;
}
const terminalStates=new Set(['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED']);
const validId=(id:string)=>/^[A-Za-z0-9_-]{1,120}$/.test(id);
const safeError=()=>new Error('Cloudflare operation could not complete.');
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

export function createCloudPort(input:CloudPortOptions,fetchImpl:typeof fetch=fetch):CloudPort {
  const options=structuredClone(input),scrub=(text:string)=>text.replaceAll(options.controlToken,'[REDACTED]');
  let origin:URL;
  try {
    origin=new URL(options.baseUrl);
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!options.controlToken.trim()||options.controlToken.length>4096||/[\r\n]/.test(options.controlToken)||!/^[a-f0-9]{40}$/.test(options.policy.baseCommit))throw safeError();
  }catch{throw new Error('Invalid Cloudflare port configuration.');}
  const moduleRoot=options.moduleRoot??fileURLToPath(new URL('../../../../',import.meta.url));
  let nativePromise:Promise<Native>|undefined;
  const native=()=>nativePromise??=Promise.all(['client','files','snapshot','scheduler'].map(async name=>{
    const moduleUrl=pathToFileURL(join(moduleRoot,'cloudflare/backend/src',name+'.ts')).href;
    return import(moduleUrl) as Promise<Partial<Native>>;
  })).then(parts=>Object.assign({},...parts) as Native);
  const deadline=()=>AbortSignal.timeout(30000);
  const request=async(path:string,method='GET')=>{
    const response=await fetchImpl(new URL(path,origin),{method,headers:{authorization:`Bearer ${options.controlToken}`},redirect:'error',signal:deadline()});
    if(!response.ok)throw safeError();
    const reader=response.body?.getReader();if(!reader)throw safeError();
    const chunks:Uint8Array[]=[];let bytes=0;
    try{while(true){const value=await reader.read();if(value.done)break;bytes+=value.value.length;if(bytes>1024*1024){await reader.cancel();throw safeError();}chunks.push(value.value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
  const processDto=(process:CloudProcess):CloudProcess=>({status:process.status,exitCode:process.exitCode,durationMs:process.durationMs,stdout:scrub(process.stdout),stderr:scrub(process.stderr),truncated:process.truncated});
  const binding=(job:Job,spec:Spec)=>{
    if(job.kind!=='agent'||job.snapshotId!==spec.snapshotId||job.provider!==spec.provider||job.credentialId!==spec.credentialId||!equal(job.checks,spec.checks)||!Array.isArray(job.childIds)||typeof job.authSynced!=='boolean'||typeof job.containerStopped!=='boolean')throw safeError();
  };
  const submission=async(value:CloudSubmission)=>{
    const api=await native(),snapshot=api.validateSnapshot(value.snapshot),spec=api.validateJobSpec(value.spec);
    if(snapshot.digest!==spec.snapshotId||spec.credentialId!==options.credentialIds[spec.provider]||!equal(spec.checks,options.checks))throw safeError();
    const path=await realpath(value.worktreePath),root=await realpath(options.worktreeRoot),repo=await realpath(options.repositoryPath),rel=relative(root,path);
    if(!rel||rel.startsWith('..')||isAbsolute(rel)||path===repo||relative(root,path)!==spec.idempotencyKey.slice('dashboard-'.length)||!spec.idempotencyKey.startsWith('dashboard-'))throw safeError();
    const workspace:Workspace={path,artifactPath:join(root,'.artifacts',rel),repositoryPath:repo,baseCommit:options.policy.baseCommit};
    await mkdir(join(workspace.artifactPath,'home'),{recursive:true});
    const env=processEnvironment(join(workspace.artifactPath,'home'));
    const git=async(args:string[],extra:NodeJS.ProcessEnv={},maxOutputBytes=64000)=>{
      const result=await runProcess(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:path,signal:deadline(),timeoutMs:30000,env:{...env,...extra},maxOutputBytes});
      if(result.status!=='passed')throw safeError();return result;
    };
    const common=await runProcess(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','rev-parse','--path-format=absolute','--git-common-dir'],{cwd:repo,signal:deadline(),timeoutMs:30000,env});
    if(common.status!=='passed'||(await git(['rev-parse','HEAD'])).stdout.trim()!==workspace.baseCommit||(await git(['rev-parse','--abbrev-ref','HEAD'])).stdout.trim()!=='HEAD'||(await git(['rev-parse','--show-toplevel'])).stdout.trim()!==path||await realpath((await git(['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim())!==await realpath(common.stdout.trim()))throw safeError();
    return {api,snapshot,spec,workspace,git};
  };
  return {
    async connection(){
      const checkedAt=new Date().toISOString();
      try {
        const health=await request('/health') as {ok?:unknown},credentials=await request('/v1/credentials');
        if(health?.ok!==true||!Array.isArray(credentials)||!Object.entries(options.credentialIds).every(([provider,id])=>credentials.some((value:unknown)=>{if(!value||typeof value!=='object')return false;const entry=value as Record<string,unknown>;return entry.id===id&&entry.provider===provider&&entry.quarantined===false&&Number.isSafeInteger(entry.generation)&&Number(entry.generation)>=0;})))throw safeError();
        return {status:'ready',message:null,checkedAt};
      }catch{return {status:'unavailable',message:'Cloudflare connection or credential metadata is unavailable.',checkedAt};}
    },
    async prepare(task:CloudTask){
      try {
        if(!validId(task.id)||task.provider!=='codex'&&task.provider!=='claude'||task.runtime!=='cloudflare'||task.repositoryId!==options.policy.id||task.baseCommit!==options.policy.baseCommit||task.testProfile!==options.policy.testProfile||!equal(task.testCommand,options.policy.testCommand))throw safeError();
        const api=await native();
        let recovered=false;
        const worktreePath=join(options.worktreeRoot,task.id);
        try{await lstat(worktreePath);recovered=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const workspace=recovered?{path:await realpath(worktreePath)}:await createWorkspace({repositoryPath:options.repositoryPath,worktreeRoot:options.worktreeRoot,runId:task.id,baseCommit:options.policy.baseCommit},deadline());
        const snapshot=await api.readSnapshot(workspace.path);
        const spec=api.validateJobSpec({provider:task.provider,credentialId:options.credentialIds[task.provider],snapshotId:snapshot.digest,instructions:scrub(`Task: ${task.title}\n\n${task.instructions}`),checks:options.checks,timeoutMs:options.timeoutMs??600000,idempotencyKey:'dashboard-'+task.id});
        const prepared={snapshot,spec:{...spec},worktreePath:workspace.path};
        const checked=await submission(prepared);
        if(recovered&&(await checked.git(['status','--porcelain','--untracked-files=all'])).stdout.trim())throw safeError();
        return prepared;
      }catch{throw Object.assign(safeError(),{retryable:false});}
    },
    async submit(value){
      try{const {api,snapshot,spec}=await submission(value),client=api.createClient(origin.href,options.controlToken,fetchImpl);await client.upload(snapshot);const job=await client.submit(spec);binding(job,spec);return scrub(job.id);}catch{throw safeError();}
    },
    async poll(jobId,value):Promise<CloudPoll>{
      try {
        const {api,snapshot,spec,workspace,git}=await submission(value),client=api.createClient(origin.href,options.controlToken,fetchImpl);
        const job=await client.get(jobId);binding(job,spec);
        const evidence:CloudEvidence={phase:scrub(job.status),jobId:scrub(job.id),inputSnapshotId:job.snapshotId,outputSnapshotId:job.outputSnapshotId??null,containerStopped:job.containerStopped,authSynced:job.authSynced,agent:null,checks:[],errorCode:job.errorCode?scrub(job.errorCode):null};
        const poll:CloudPoll={phase:evidence.phase,terminal:terminalStates.has(job.status)&&job.containerStopped,success:false,cancelled:job.status==='CANCELLED'&&job.containerStopped,evidence,summary:null,diff:null,diffTruncated:false};
        if(!job.outputSnapshotId)return poll;
        const result=await client.result(jobId);binding(result.job,spec);
        if(result.input.digest!==snapshot.digest||result.output.digest!==job.outputSnapshotId||result.job.status!==job.status||result.job.authSynced!==job.authSynced||result.job.containerStopped!==job.containerStopped)throw safeError();
        if(result.checks){
          for(const entry of result.checks){
            const expected=spec.checks.find(check=>check.id===entry.job.checkId);
            if(!expected||!equal(entry.job.argv,expected.argv)||entry.job.provider!==undefined||entry.job.credentialId!==undefined)throw safeError();
            evidence.checks.push({id:scrub(expected.id),name:scrub(expected.id),status:scrub(entry.job.status),command:expected.argv.map(scrub),process:entry.result?processDto(entry.result.process):null,credentialsAbsent:entry.result?.credentialsAbsent??null,sourceUnchanged:entry.result?.sourceUnchanged??null});
          }
        }
        if(job.status==='SUCCEEDED'&&evidence.checks.length!==spec.checks.length)throw safeError();
        evidence.agent=result.result?processDto(result.result.process):null;
        poll.summary=result.result?scrub(result.result.summary):null;
        // A repeated poll after a crash may already have applied this exact output.
        const current=await api.readSnapshot(workspace.path);
        if(current.digest!==result.output.digest){if(current.digest!==snapshot.digest)throw safeError();await api.applySnapshot(workspace.path,snapshot,result.output);}
        if((await api.readSnapshot(workspace.path)).digest!==result.output.digest)throw safeError();
        const temporary=await mkdtemp(join(workspace.artifactPath,'index-'));
        try {
          const isolated={GIT_INDEX_FILE:join(temporary,'index')};
          await git(['read-tree',options.policy.baseCommit],isolated);
          const paths=[...new Set([...snapshot.files,...result.output.files].map(file=>file.path))];
          if(paths.length)await git(['--literal-pathspecs','add','--all','--',...paths],isolated);
          const diff=await git(['diff','--cached','--binary','--no-ext-diff','--no-textconv',options.policy.baseCommit,'--'],isolated,720000);
          poll.diff=scrub(diff.stdout.slice(0,180000));poll.diffTruncated=diff.truncated||diff.stdout.length>180000;
        }finally{await rm(temporary,{recursive:true,force:true});}
        poll.success=poll.terminal&&job.status==='SUCCEEDED'&&job.authSynced&&evidence.agent?.status==='passed'&&evidence.agent.exitCode===0&&evidence.checks.length===spec.checks.length&&evidence.checks.every(check=>check.status==='SUCCEEDED'&&check.process?.status==='passed'&&check.process.exitCode===0&&check.credentialsAbsent===true&&check.sourceUnchanged===true)&&result.checks!.every(check=>check.job.containerStopped&&check.job.snapshotId===result.output.digest&&(check.job.outputSnapshotId===undefined||check.job.outputSnapshotId===result.output.digest));
        return poll;
      }catch{throw safeError();}
    },
    async cancel(jobId){try{if(!validId(jobId))throw safeError();await request('/v1/jobs/'+encodeURIComponent(jobId)+'/cancel','POST');}catch{throw safeError();}},
  };
}
