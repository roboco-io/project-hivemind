import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {projectTeamResponse,teamPageQuery,teamBlockInput,teamReviewInput,workflowDigest,workflowId,type CloudWorkflowPort,type WorkflowBinding} from '../../contracts/src/workflow.js';
import type {CloudPortOptions} from './cloudflare.js';
import {createWorkspace} from './workspace.js';
import {processEnvironment,runProcess} from './process.js';

export type WorkflowChecks = {codex: CloudPortOptions['checks']; claude: CloudPortOptions['checks']; integration: CloudPortOptions['checks'][number]};
type Snapshot = {digest:string;files:{path:string;sha256:string}[]};
type Native = {
  createClient(origin:string,token:string): {
    upload(snapshot:Snapshot):Promise<string>;
    draftWorkflow(spec:Record<string,unknown>):Promise<unknown>;
    approveWorkflow(id:string):Promise<unknown>;
    getWorkflow(id:string,result?:boolean):Promise<unknown>;
    result(id:string):Promise<{input:Snapshot}>;
    get(id:string):Promise<unknown>;
  };
  readSnapshot(path:string):Promise<Snapshot>;
  restoreSnapshot(path:string,snapshot:Snapshot):Promise<void>;
  validateSnapshot(input:unknown):Snapshot;
};
const status = z.enum(['DRAFT','RUNNING','INTEGRATING','SUCCEEDED','FAILED']);
const phase = z.enum(['QUEUED','STARTING','RUNNING','VERIFYING','SAVING','SUCCEEDED','FAILED','CANCELLING','CANCELLED','TIMED_OUT','NEEDS_REAUTH','AUTH_SYNC_FAILED']);
const remoteWorkflow = z.object({
  id:workflowId,status,outputSnapshotId:workflowDigest.optional(),
  spec:z.object({snapshotId:workflowDigest,contractHash:workflowDigest}),
  workerIds:z.tuple([workflowId,workflowId]).optional(),
  integrationId:workflowId.optional(),errorCode:z.string().regex(/^[A-Z0-9_]{1,100}$/).optional(),
});
const checkpoint = z.object({round:z.number().int().min(1).max(4),checkIds:z.array(workflowId).max(4),rejected:z.boolean().optional()});
const job = z.object({id:workflowId,status:phase,provider:z.enum(['codex','claude']).optional(),snapshotId:workflowDigest,
  containerStopped:z.boolean(),authSynced:z.boolean(),checkpoint:checkpoint.optional(),checkpointHistory:z.array(checkpoint).max(4).optional()});
const resultJob = z.object({job,result:z.object({
  ralphRounds:z.array(z.object({round:z.number().int().min(1).max(4),accepted:z.boolean()})).max(4).optional(),
  process:z.object({status:z.enum(['passed','failed','timed_out','error','not_run']),exitCode:z.number().int().nullable(),
    durationMs:z.number().int().nonnegative(),stdout:z.string().max(32000),stderr:z.string().max(32000),truncated:z.boolean()}),
  credentialsAbsent:z.boolean().optional(),sourceUnchanged:z.boolean().optional(),
}).optional()});
function binding(value:unknown,expected:WorkflowBinding) {
  const parsed=remoteWorkflow.parse(value);
  if(parsed.id!==expected.id||parsed.spec.snapshotId!==expected.inputSnapshotId||parsed.spec.contractHash!==expected.contractHash)
    throw new Error('Workflow approval binding differs');
  return parsed;
}
export function createCloudWorkflowPort(config:CloudPortOptions,checks:WorkflowChecks,fetchImpl:typeof fetch=fetch):CloudWorkflowPort {
  config=structuredClone(config);
  const origin=new URL(config.baseUrl);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!config.controlToken||/[\s\p{Cc}]/u.test(config.controlToken))throw new Error('Invalid Cloudflare workflow configuration');
  async function teamRequest(path:string,body?:unknown):Promise<unknown>{
    const response=await fetchImpl(new URL(path,origin),{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+config.controlToken,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    if(!response.ok||response.redirected||Number(response.headers.get('content-length'))>1048576){await response.body?.cancel();throw new Error('Team operation unavailable');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Team operation unavailable');
    let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1048576){await reader.cancel();throw new Error('Team operation unavailable');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function teamOperation(entry:WorkflowBinding,operation:'summary'|'tasks'|'events'|'notes'|'block'|'review',query:Record<string,number|undefined>={},body?:unknown){
    try{
      workflowId.parse(entry.id);workflowDigest.parse(entry.contractHash);workflowDigest.parse(entry.inputSnapshotId);
      const current=z.object({workflow:remoteWorkflow}).parse(await teamRequest('/v1/workflows/'+entry.id));binding(current.workflow,entry);
      const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
      const path='/v1/workflows/'+entry.id+'/team'+(operation==='summary'?'':'/'+operation)+(params.size?'?'+params:'');
      const result=projectTeamResponse(await teamRequest(path,body),operation,[config.controlToken]);
      if(['summary','block','review'].includes(operation)&&result.workflowId!==entry.id)throw new Error('Team binding differs');
      return result;
    }catch{throw new Error('Team operation unavailable');}
  }
  const moduleRoot=config.moduleRoot??fileURLToPath(new URL('../../../../',import.meta.url));
  let loaded:Promise<Native>|undefined;
  async function backend() {
    const api=await (loaded??=Promise.all(['client','files','snapshot'].map(name=>import(pathToFileURL(join(moduleRoot,'cloudflare/backend/src',name+'.ts')).href))).then(modules=>Object.assign({},...modules) as Native));
    return {api,client:api.createClient(config.baseUrl,config.controlToken)};
  }
  const scrub=(text:string)=>text.replaceAll(config.controlToken,'[REDACTED]');
  const git=(cwd:string,args:string[],home:string,maxOutputBytes=64000)=>runProcess(
    ['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
    {cwd,env:processEnvironment(home),signal:AbortSignal.timeout(10000),timeoutMs:10000,maxOutputBytes});
  return {
    async teamRead(entry,section,query={}){
      if(!['summary','tasks','events','notes'].includes(section)||!teamPageQuery.safeParse(query).success||(['summary','tasks'].includes(section)&&Object.keys(query).length))throw new Error('Invalid team request');
      return teamOperation(entry,section,query);
    },
    async teamBlock(entry,input){return teamOperation(entry,'block',{},teamBlockInput.parse(input));},
    async teamReview(entry,input){return teamOperation(entry,'review',{},teamReviewInput.parse(input));},
    async draft(input,key) {
      if(input.baseCommit!==config.policy.baseCommit)throw new Error('Configured base commit differs');
      const checkFiles=[...checks.codex,...checks.claude,checks.integration].flatMap(check=>check.argv)
        .map(arg=>arg.replace(/^\.\//,'').toLowerCase());
      if([...input.codex.writes,...input.claude.writes].some(path=>checkFiles.includes(path.toLowerCase())))
        throw new Error('Worker paths overlap an operator check');
      const {api,client}=await backend();
      const workspace=await createWorkspace({repositoryPath:config.repositoryPath,worktreeRoot:config.worktreeRoot,
        baseCommit:config.policy.baseCommit,runId:'workflow-'+randomUUID()},AbortSignal.timeout(10000));
      let snapshot:Snapshot;
      try {snapshot=await api.readSnapshot(workspace.path);}
      finally {
        const removed=await git(workspace.repositoryPath,['worktree','remove','--force',workspace.path],join(workspace.artifactPath,'home'));
        if(removed.status!=='passed')throw new Error('Could not remove workflow preparation worktree');
        await rm(workspace.artifactPath,{recursive:true,force:true});
      }
      const contractHash=snapshot.files.find(file=>file.path===input.contractPath)?.sha256;
      if(!contractHash)throw new Error('Contract file not found in the fixed source');
      await client.upload(snapshot);
      const response=remoteWorkflow.parse(await client.draftWorkflow({
        idempotencyKey:key,snapshotId:snapshot.digest,contractPath:input.contractPath,contractHash,
        workers:(['codex','claude'] as const).map(provider=>({
          provider,credentialId:config.credentialIds[provider],writes:input[provider].writes,
          instructions:scrub(input[provider].instructions),checks:checks[provider],timeoutMs:config.timeoutMs??600000,
        })),
        integration:checks.integration,
      }));
      const entry={id:response.id,inputSnapshotId:snapshot.digest,contractHash};
      if(binding(response,entry).status!=='DRAFT')throw new Error('Workflow is already approved');
      return entry;
    },
    async approve(entry) {
      const {client}=await backend();
      const current=z.object({workflow:remoteWorkflow}).parse(await client.getWorkflow(entry.id));
      const checked=binding(current.workflow,entry);
      if(checked.status!=='DRAFT')return {status:checked.status};
      return {status:binding(await client.approveWorkflow(entry.id),entry).status};
    },
    async read(entry,result,includeDiff) {
      const {api,client}=await backend();
      const current=z.object({workflow:remoteWorkflow,workers:z.array(job).max(2),integration:job.optional()}).parse(await client.getWorkflow(entry.id));
      const workflow=binding(current.workflow,entry);
      if(current.workers.length!==(workflow.workerIds?.length??0)||
         current.workers.some((j,i)=>j.id!==workflow.workerIds?.[i]||j.snapshotId!==entry.inputSnapshotId||!j.provider)||
         current.integration?.id!==workflow.integrationId||
         (current.integration&&current.integration.snapshotId!==workflow.outputSnapshotId))throw new Error('Workflow job binding differs');
      const workers=await Promise.all(current.workers.map(async j=>({
        id:j.id,provider:j.provider,status:j.status,containerStopped:j.containerStopped,authSynced:j.authSynced,
        rounds:await Promise.all([...(j.checkpointHistory??[]),...(j.checkpoint?[j.checkpoint]:[])].map(async c=>({
          round:c.round,rejected:c.rejected??false,checks:await Promise.all(c.checkIds.map(async id=>{
            const check=job.parse(await client.get(id));
            if(check.id!==id||check.provider)throw new Error('Workflow check binding differs');
            return {id,status:check.status};
          })),
        }))),
      })));
      const view={status:workflow.status,errorCode:workflow.errorCode??null,workers,
        integration:current.integration?{id:current.integration.id,status:current.integration.status}:null,
        outputSnapshotId:workflow.outputSnapshotId??null,actualCostMicros:null};
      if(!result||!['SUCCEEDED','FAILED'].includes(workflow.status))return {...view,resultReady:false};
      const details=z.object({workflow:remoteWorkflow,workers:z.array(resultJob).max(2),integration:resultJob.optional(),output:z.unknown().optional()})
        .parse(await client.getWorkflow(entry.id,true));
      const checked=binding(details.workflow,entry);
      if(checked.status!==workflow.status||details.integration?.job.id!==workflow.integrationId||
        details.workers.length!==workers.length||details.workers.some((w,i)=>w.job.id!==workers[i]?.id))throw new Error('Workflow result binding differs');
      const verification=details.integration?.result;
      if(workflow.status==='SUCCEEDED'&&(!verification||details.integration?.job.status!=='SUCCEEDED'||
        !details.integration.job.containerStopped||verification.process.status!=='passed'||verification.process.exitCode!==0||
        verification.credentialsAbsent!==true||verification.sourceUnchanged!==true||details.output===undefined))throw new Error('Workflow verification is incomplete');
      let diff:string|null=null,diffTruncated=false;
      if(includeDiff&&details.output!==undefined){
        const output=api.validateSnapshot(details.output);
        const first=workflow.workerIds?.[0];if(!first||output.digest!==workflow.outputSnapshotId)throw new Error('Workflow output binding differs');
        const {input}=await client.result(first);
        if(input.digest!==entry.inputSnapshotId)throw new Error('Workflow input binding differs');
        const folder=await mkdtemp(join(tmpdir(),'hivemind-workflow-diff-'));
        try {
          const home=join(folder,'home');await mkdir(home);
          await api.restoreSnapshot(join(folder,'before'),input);
          await api.restoreSnapshot(join(folder,'after'),output);
          const rendered=await git(folder,['diff','--no-index','--binary','--no-ext-diff','--no-textconv','--','before','after'],home,720000);
          if(rendered.exitCode!==0&&rendered.exitCode!==1)throw new Error('Workflow diff could not be generated');
          diff=scrub(rendered.stdout.slice(0,180000));
          diffTruncated=rendered.truncated||rendered.stdout.length>180000;
        }finally{await rm(folder,{recursive:true,force:true});}
      }
      return {...view,resultReady:true,diff,diffTruncated,
        workerResults:details.workers.map(w=>({id:w.job.id,rounds:w.result?.ralphRounds??[]})),
        verification:verification?{...verification,process:{...verification.process,stdout:scrub(verification.process.stdout),stderr:scrub(verification.process.stderr)}}:null};
    },
  };
}
