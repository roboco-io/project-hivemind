import {constants} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {open,rename,unlink,link} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSnapshot,sha256,validateSnapshot} from '../src/snapshot.ts';
import {validateAutonomousModelPin,type AutonomousSpec} from '../../../packages/contracts/src/autonomous.ts';

const DAY=86_400_000;
type PlanInput={origin:string;requestId:string;model:string;subagentModel:string;credentialId:string;endsAt:number;budgetMicros:number;maxIterations:number;maxRunMs:number};
type Manifest={version:1;createdAt:number;origin:string;spec:AutonomousSpec;snapshot:ReturnType<typeof createSnapshot>;planHash:string;registration:'planned'|'uncertain'|'registered';taskId?:string;revision?:number};
type Fetcher=(url:string,options:RequestInit)=>Promise<Response>;
type Row=Record<string,any>;
type Observation={planHash:string;observedAt:number;summary:Row;history:Record<string,Row[]>;cloud:Row};
const kinds=['runs','actions','resources','interventions'] as const;
function validText(value:unknown):asserts value is string {if(typeof value!=='string'||!value.trim()||value.length>256||/[\p{Cc}]/u.test(value))throw Error('Explicit scope required');}
function fingerprint(m:Pick<Manifest,'createdAt'|'origin'|'spec'|'snapshot'>){return sha256(JSON.stringify([m.createdAt,m.origin,m.spec,m.snapshot]));}
export function createAcceptancePlan(input:PlanInput,now=Date.now()):Manifest {
 for(const key of ['origin','requestId','credentialId'] as const)validText(input[key]);
 validateAutonomousModelPin(input.model);validateAutonomousModelPin(input.subagentModel);
 const url=new URL(input.origin);
 if(url.protocol!=='https:'||url.origin!==input.origin||url.username||url.password)throw Error('Explicit HTTPS origin required');
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.credentialId))throw Error('Invalid credential ID');
 for(const key of ['endsAt','budgetMicros','maxIterations','maxRunMs'] as const)if(!Number.isSafeInteger(input[key])||input[key]<=0)throw Error('Explicit positive limits required');
 if(!Number.isSafeInteger(now)||input.endsAt-now<DAY||input.endsAt-now>56*DAY||input.maxIterations<3||input.maxIterations>65536||input.maxRunMs<1000||input.maxRunMs>120000)throw Error('Invalid long-running limits');
 const snapshot=createSnapshot([{path:'counter.txt',content:Buffer.from('0\n').toString('base64'),sha256:sha256('0\n'),executable:false}]);
 const spec:AutonomousSpec={requestId:input.requestId,provider:'claude',model:input.model,subagentModel:input.subagentModel,
 goal:'Use Bash to increment counter.txt once each iteration and use Agent with the approved subagent model to check the counter. Preserve this session. First iteration return only {"outcome":"continue"}. Second iteration request a five-minute wait with {"outcome":"wait","wakeAt":ABSOLUTE_UNIX_MS}. Thereafter repeat with five-minute waits until the approved deadline. Do not finish early. Do not use external systems or change the approved scope. Tool requests are instructions, not acceptance evidence.',
 billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:input.endsAt,budgetMicros:input.budgetMicros,tools:['Bash','Agent'],systems:[],credentialIds:[input.credentialId],maxRunMs:input.maxRunMs,maxIterations:input.maxIterations,
 execution:{backend:'cloudflare',mode:'long_running',snapshotId:snapshot.digest,checks:[{id:'counter',argv:['node','-e',"if(!/^[1-9][0-9]*\\n$/.test(require('node:fs').readFileSync('counter.txt','utf8')))process.exit(1)"],timeoutMs:10000}]}};
 const m={version:1 as const,createdAt:now,origin:input.origin,spec,snapshot,registration:'planned' as const,planHash:''};m.planHash=fingerprint(m);return m;
}
async function privateRead(file:string){
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.()||s.size>2*1024*1024)throw Error('Private owner-only 0600 file required');return JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}
}
export async function loadManifest(file:string):Promise<Manifest>{
 const m=await privateRead(file) as Manifest;
 if(m.version!==1||m.planHash!==fingerprint(m)||!['planned','uncertain','registered'].includes(m.registration))throw Error('Manifest integrity mismatch');
 validateSnapshot(m.snapshot);
 if(m.snapshot.digest!==m.spec.execution?.snapshotId)throw Error('Snapshot mismatch');
 if(m.registration==='registered'&&(!m.taskId||!Number.isSafeInteger(m.revision)||m.revision!<1))throw Error('Missing canonical identity');
 // Revalidate frozen scope, without moving the persisted clock or deadline.
 const expected=createAcceptancePlan({origin:m.origin,requestId:m.spec.requestId,model:m.spec.model,subagentModel:m.spec.subagentModel!,credentialId:m.spec.credentialIds[0]!,endsAt:m.spec.endsAt,budgetMicros:m.spec.budgetMicros,maxIterations:m.spec.maxIterations,maxRunMs:m.spec.maxRunMs},m.createdAt);
 if(expected.planHash!==m.planHash)throw Error('Frozen plan mismatch');
 return m;
}
export async function saveManifest(file:string,m:Manifest,initial=false){
 const temporary=file+'.'+randomUUID()+'.tmp';const fd=await open(temporary,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(m));await fd.sync();}finally{await fd.close();}
 try{if(initial)await link(temporary,file);else {await loadManifest(file);await rename(temporary,file);}}finally{await unlink(temporary).catch(()=>{});}
}
async function request(m:Manifest,token:string,fetcher:Fetcher,path:string,method='GET',body?:unknown):Promise<Row>{
 validText(token);
 try{const r=await fetcher(m.origin+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw Error();return await r.json() as Row;}catch{throw Error('Acceptance API request failed');}
}
/** A persisted request ID is the server idempotency key. Never approve here. */
export async function registerAcceptance(file:string,token:string,fetcher:Fetcher=fetch):Promise<Manifest>{
 // Fail closed on concurrent callers. A dead process lock can be removed after inspection.
 const lock=await open(file+'.lock','wx',0o600).catch(()=>{throw Error('Registration locked; inspect prior process before removing lock');});
 try{
 await lock.writeFile(String(process.pid));await lock.sync();
 const m=await loadManifest(file);if(m.registration==='registered')return m;
 m.registration='uncertain';await saveManifest(file,m);
 try{
 await request(m,token,fetcher,'/v1/snapshots/'+m.snapshot.digest,'PUT',m.snapshot);
 const task=await request(m,token,fetcher,'/v1/autonomous-tasks','POST',m.spec);
 if(typeof task.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(task.id)||!Number.isSafeInteger(task.revision)||task.revision<1||!isDeepStrictEqual(task.spec,m.spec))throw Error('Identity mismatch');
 m.taskId=task.id;m.revision=task.revision;m.registration='registered';await saveManifest(file,m);return m;
 }catch{throw Error('Registration uncertain; retry unchanged manifest, never a new request ID');}
 }finally{await lock.close();await unlink(file+'.lock');}
}
function pick(row:Row,fields:string[]):Row{return Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));}
const fields:Record<string,string[]>={runs:['runId','startedAt','finishedAt','outcome','wakeAt','usageUnavailable'],actions:['id','tool','system','operation','status','actualCostMicros','resourceId'],resources:['id','system','cleanupOperation','status','actionId'],interventions:['kind','at','revision']};
export async function observeAcceptance(m:Manifest,token:string,fetcher:Fetcher=fetch):Promise<Observation>{
 if(m.registration!=='registered'||!m.taskId||!m.revision)throw Error('Register canonical identity first');
 const base='/v1/autonomous-tasks/'+encodeURIComponent(m.taskId);
 const summary=await request(m,token,fetcher,base+'?view=summary');
 if(summary.id!==m.taskId||summary.revision!==m.revision||!isDeepStrictEqual(summary.spec,m.spec))throw Error('Canonical scope changed');
 const history:Record<string,Row[]>={};
 for(const kind of kinds){history[kind]=[];let cursor:string|undefined;const seen=new Set<string>();
 do{const page=await request(m,token,fetcher,base+'/history?kind='+kind+'&limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
 if(page.taskId!==m.taskId||page.revision!==m.revision||page.kind!==kind||!Array.isArray(page.items)||page.items.length>100)throw Error('History identity mismatch');
 history[kind].push(...page.items.map((row:Row)=>({...pick(row,fields[kind]!),...(kind==='runs'&&row.usage?{usage:pick(row.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'])}:{})})));
 cursor=page.nextCursor;if(cursor!==undefined&&(typeof cursor!=='string'||!cursor||seen.has(cursor)||history[kind].length>65536))throw Error('Invalid history cursor');if(cursor)seen.add(cursor);
 }while(cursor);}
 const cloud=await request(m,token,fetcher,base+'/cloud-result');if(cloud.taskId!==m.taskId)throw Error('Cloud identity mismatch');
 return {planHash:m.planHash,observedAt:Date.now(),summary:{...pick(summary,['id','revision','status','createdAt','approvedAt','nextRunAt','iteration','spentMicros','reservedMicros','stopReason']),...(summary.counts?{counts:pick(summary.counts,['humanInterventions','helpRequests','toolCalls'])}:{})},history,cloud:pick(cloud,['taskId','phase','jobId','status','stopped','authSynced','checksPassed','snapshotId'])};
}
export function reportAcceptance(m:Manifest,o:Observation){
 if(o.planHash!==m.planHash)throw Error('Observation scope mismatch');
 const runs=o.history.runs??[],finished=runs.filter(r=>Number.isSafeInteger(r.startedAt)&&Number.isSafeInteger(r.finishedAt)&&r.finishedAt>=r.startedAt);
 const actualElapsedMs=finished.length?Math.max(...finished.map(r=>r.finishedAt))-Math.min(...finished.map(r=>r.startedAt)):0;
 const unmet=(reason:string)=>({met:false,source:null,reason});
 const interventions=o.history.interventions??[];
 const counts={humanInterventions:interventions.filter(i=>i.kind!=='help').length,helpRequests:interventions.filter(i=>i.kind==='help').length,toolCalls:(o.history.actions??[]).length};
 const approvals=interventions.filter(i=>i.kind==='approval');
 return {version:1,taskId:m.taskId,revision:m.revision,planHash:m.planHash,actualProof:'deferred_by_user',verified:false,actualElapsedMs,counts,reportedCounts:o.summary.counts??null,
 costScope:{budget:'external_actions_only',budgetMicros:m.spec.budgetMicros,modelMonetaryCap:false,platformMonetaryCap:false,externalSystems:[],paidResourceCleanupTested:false},
 criteria:{duration24h:{met:actualElapsedMs>=DAY&&finished.length>=3&&approvals.length===1&&interventions.every(i=>i.kind==='approval'),source:'history/runs.startedAt,finishedAt; history/interventions.kind',reason:'Run timestamps and single approval only; elapsed local observation time is excluded.'},
 sessionAfterRestart:unmet('Public history omits session/checkpoint and restart evidence. Cache usage alone cannot prove session continuity.'),
 bashAndAgent:unmet('No native Bash/Agent execution receipts in public API; goal, allowed tools and counter changes are insufficient.'),
 waitWithoutModelCalls:unmet('Wait outcomes do not prove absence of model calls or requested-time restart recovery. Requires dispatch audit.'),
 costStopAndCleanup:unmet('No external systems/resources in this scope; budget_exceeded or stopped flags alone do not prove paid resource termination.'),
 cancellationCleanup:unmet('Read-only observation performs no cancellation; requires separate authorized cancellation and provider cleanup evidence.'),
 audit:{met:!!o.summary.counts&&kinds.every(k=>Array.isArray(o.history[k])),source:'summary.counts; history/{runs,actions,resources,interventions}',reason:'Public paginated records and intervention/help counts only; native tool coverage remains unmet.'}},cloud:o.cloud};
}
export async function acceptanceMain(args=process.argv.slice(2)){
 const [command,...rest]=args;const opts:Record<string,string>={};
 if(!['plan','register','observe','report'].includes(command??'')||rest.length%2)throw Error('Invalid acceptance command');
 const allowed=command==='plan'?['manifest','origin','request-id','model','subagent-model','credential-id','ends-at','budget-micros','max-iterations','max-run-ms']:command==='report'?['manifest']:['manifest','auth-file'];
 for(let i=0;i<rest.length;i+=2){const key=rest[i]!.replace(/^--/,'');if(rest[i]!==`--${key}`||!allowed.includes(key)||opts[key]!==undefined||!rest[i+1])throw Error('Invalid explicit argument');opts[key]=rest[i+1]!;}
 if(allowed.some(k=>opts[k]===undefined))throw Error('Missing explicit argument');
 const file=opts.manifest!;
 if(command==='plan'){const m=createAcceptancePlan({origin:opts.origin!,requestId:opts['request-id']!,model:opts.model!,subagentModel:opts['subagent-model']!,credentialId:opts['credential-id']!,endsAt:Number(opts['ends-at']),budgetMicros:Number(opts['budget-micros']),maxIterations:Number(opts['max-iterations']),maxRunMs:Number(opts['max-run-ms'])});await saveManifest(file,m,true);return {planHash:m.planHash,registration:m.registration,approvalRequired:true};}
 const m=await loadManifest(file);
 if(command==='report'){const o=await privateRead(file+'.observation') as Observation;return reportAcceptance(m,o);}
 const auth=await privateRead(opts['auth-file']!);if(Object.keys(auth).join()!=='controlToken')throw Error('Invalid auth file');validText(auth.controlToken);
 if(command==='register'){const result=await registerAcceptance(file,auth.controlToken);return {taskId:result.taskId,revision:result.revision,approvalRequired:true};}
 const observation=await observeAcceptance(m,auth.controlToken);
 // Observations are replaceable snapshots; no credentials or checkpoint data are stored.
 const temporary=file+'.'+randomUUID()+'.tmp',fd=await open(temporary,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(observation));await fd.sync();}finally{await fd.close();}
 try{await rename(temporary,file+'.observation');}finally{await unlink(temporary).catch(()=>{});}
 return reportAcceptance(m,observation);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{console.log(JSON.stringify(await acceptanceMain(),null,2));}catch{console.error('Acceptance command failed; inspect explicit arguments/private files. Registration may be uncertain: reuse the unchanged manifest.');process.exitCode=1;}
