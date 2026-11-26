import {validateExternalArtifact,externalArtifactDigest,type ExternalArtifact,type ExternalArtifactPublisher} from '../../../packages/adapters/src/autonomous-external.ts';
import {createHash} from 'node:crypto';
import type {AutonomousApiService} from './autonomous-api.js';
import type {AutonomousLease,AutonomousSpec,AutonomousTask,AutonomousAction} from '../../../packages/contracts/src/autonomous.js';
import type {ExternalAction,ExternalActionRequest,ExternalProfileRegistry,ExternalApproval,ExternalProfile,ExternalTarget} from '../../../packages/contracts/src/autonomous-external.js';
import type {ExternalBroker} from '../../../packages/core/src/autonomous-external.js';
import type {ExternalDurableStore,ExternalJournal,ExternalJournalQuery} from '../../../packages/core/src/autonomous-external-sql.js';
import {validateExternalS3InspectParameters,validateExternalS3Parameters} from '../../../packages/core/src/autonomous-external-s3.ts';
import {assertHfLfsAllowed,hfVisibilityDisplay} from '../../../packages/adapters/src/autonomous-external-hf-visibility.ts';
import type {ExternalLargeLimits,ExternalLargeManifest} from '../../../packages/contracts/src/autonomous-external-large.js';
import type {ExternalLargeStore} from '../../../packages/adapters/src/autonomous-external-large-store.ts';
import {handleExternalLargeApi,type ExternalLargeAuthority} from './autonomous-external-large-api.ts';

/** Operator-visible part of a profile target. S3 shows bucket and prefix, not size or retention limits. */
export type ApprovedExternalTarget=Exclude<ExternalTarget,{bucket:string}>|{accountId:string;region:string;bucket:string;prefix:string};
type CanonicalTask=AutonomousTask & {spec:AutonomousSpec & {externalProfiles?:string[]}};
export interface ExternalWorkerRequest {lease:AutonomousLease;runtimeId:string;request:Omit<ExternalActionRequest,'taskId'|'revision'>}
export interface ExternalArtifactRequest {lease:AutonomousLease;runtimeId:string;profileId:string;artifact:ExternalArtifact}
export interface ExternalBridgeOptions {
 oidcAudit?:(taskId:string,query?:{after?:number;limit?:number})=>Promise<{items:import('../../../packages/contracts/src/autonomous-external.ts').ExternalOidcAuditEvent[];nextAfter?:number}>;
 beforeExecute?:(taskId:string,body:ExternalWorkerRequest)=>Promise<void>;
 profileMetadata?:(task:AutonomousTask,profile:ExternalProfile)=>Pick<ExternalProfileMetadata,'oidc'|'delegated'>;
 artifactPublisher?:ExternalArtifactPublisher;
 knownSecretValues?:()=>readonly string[];
 /** Trusted migration/fixture escape hatch only. Default closed. */
 allowPreseededArtifacts?:boolean;
 /** Persists the canonical large manifest under its digest. Without it, large manifests are refused. */
 manifestStore?:{save(manifest:ExternalLargeManifest,manifestDigest:string):Promise<void>};
 /** Cancels every large upload of a task revision when the task is cancelled or revised. */
 largeStore?:Pick<ExternalLargeStore,'abortOwner'>;
 core:AutonomousApiService;broker:Pick<ExternalBroker,'serverApprove'|'execute'|'cancel'|'recover'|'getAction'|'listPending'|'reconcile'|'cleanup'>;
 registry:ExternalProfileRegistry;store:ExternalDurableStore;configurationFingerprint?:string;
}
export interface ExternalBillingAttestation {actualCostMicros:number;evidenceRef:string;reason:string;revision?:number}
export interface ExternalPublicAction {
 profileId?:string;approvedTarget?:ApprovedExternalTarget;approvedProfileHash?:string;
 parameterHash?:string;parameters?:{lifetimeMs:number}|{startActionId:string}|{artifactDigest:string}|{artifactDigest:string;expectedHead:string}|{manifestDigest:string}|{keySuffix:string;artifactDigest:string}|{putActionId:string};
 providerResult?:{kind:'aws_instance';id:string}|{kind:'hf_commit'|'github_commit';oid:string};
 revision:number;billingSource?:'provider_verified'|'operator_attested';evidenceRef?:string;attestedAt?:number;
 billingEvidence?:'undispatched_intent';recoveryIssue?:ExternalJournal['recoveryIssue'];resourceId?:string;requestId:string;phase:ExternalJournal['phase'];actionId?:string;status?:ExternalAction['status'];
 operation?:ExternalAction['operation'];effect?:ExternalAction['effect'];cleanupStatus?:ExternalAction['cleanupStatus'];
 verifiedCostMicros?:number|null;billingFinal?:boolean;upperBoundMicros?:number;reservedMicros?:number;
}
/** Visible to the operator at approval so a public Hugging Face commit is explicit. */
export interface ExternalHfVisibilityDisplay {visibility:'private'|'public';publicEffect:boolean;notice:string}
export interface ExternalOidcDisplay {issuer:string;audience:string;execute:{roleArn:string;subject:string;policyHash:string;durationSeconds:number};inspect:{roleArn:string;subject:string;policyHash:string;durationSeconds:number};cleanup:{roleArn:string;subject:string;policyHash:string;durationSeconds:number}}
export interface ExternalProfileMetadata {delegated?:{descriptorHash:string;inputManifestDigest:string;descriptor:import('../../../packages/contracts/src/delegated.ts').WorkloadDescriptor};oidc?:ExternalOidcDisplay;hfVisibilityDisplay?:ExternalHfVisibilityDisplay;accounting?:'upper_bound_not_invoice';id:string;enabled:boolean;profileHash:string;provider?:string;target?:unknown;credentialRef?:string;operations?:string[];maxLifetimeMs?:number;upperBoundMicros?:number;maxActiveActions?:number}
export interface ExternalActionPage {items:ExternalPublicAction[];nextCursor?:string}
export interface AutonomousExternalService {
 oidcAudit?:(taskId:string,query?:{after?:number;limit?:number})=>Promise<{items:import('../../../packages/contracts/src/autonomous-external.ts').ExternalOidcAuditEvent[];nextAfter?:number}>;
 publishArtifact(taskId:string,body:ExternalArtifactRequest):Promise<{artifactDigest:string}>;
 /** Authority for large uploads: lease, running task, approved hf.model.lfs_commit profile. */
 largeAuthority?(taskId:string,body:{lease:AutonomousLease;runtimeId:string;profileId:string}):Promise<ExternalLargeAuthority>;
 /** Binds a validated large manifest to a grant of the approved profile. */
 saveLargeManifest?(manifest:ExternalLargeManifest,manifestDigest:string):Promise<void>;
 profiles(taskId:string):Promise<ExternalProfileMetadata[]>;
 assertApproval(taskId:string,revision:number,hashes:Record<string,string>):Promise<void>;
 execute(taskId:string,body:ExternalWorkerRequest):Promise<ExternalPublicAction>;
 approve(taskId:string,hashes?:Record<string,string>):Promise<{taskId:string;revision:number;profileId:string;profileIds?:string[]}>;
 list(taskId:string,query?:ExternalJournalQuery):Promise<ExternalPublicAction[]|ExternalActionPage>;
 reconcile(taskId:string,requestId:string,revision?:number):Promise<ExternalPublicAction>;
 cleanup(taskId:string,requestId:string,revision?:number):Promise<ExternalPublicAction>;
 attestBilling(taskId:string,requestId:string,billing:ExternalBillingAttestation):Promise<ExternalPublicAction>;
 /** Install before BOTH existing canonical cancel/revise routes. Stops admission durably first. */
 beforeCoreMutation(taskId:string,operation:'cancel'|'revise'|'finish'):Promise<void>;
 /** Startup barrier only after the previous broker owner has stopped. Never dispatches. */
 recover():Promise<void>;
}
class BridgeError extends Error {readonly statusCode:number;constructor(statusCode:number){super('External action unavailable');this.statusCode=statusCode;}}
function deny(status=400):never{throw new BridgeError(status);}
function obj(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)deny();
 const entries=Object.getOwnPropertyDescriptors(v);
 if(Object.getOwnPropertySymbols(v).length||Object.entries(entries).some(([k,d])=>!required.includes(k)&&!optional.includes(k)||!('value'in d)||!d.enumerable)||required.some(k=>!Object.hasOwn(entries,k)))deny();
 return v as Record<string,unknown>;
}
function text(v:unknown,pattern=/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/):asserts v is string {if(typeof v!=='string'||!pattern.test(v))deny();}
function int(v:unknown,min=0):asserts v is number{if(!Number.isSafeInteger(v)||Number(v)<min)deny();}
function billingBody(value:unknown):ExternalBillingAttestation {
 const b=obj(value,['actualCostMicros','evidenceRef','reason'],['revision']);int(b.actualCostMicros,1);
 text(b.evidenceRef,/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);if(/^(?:sk-|hf_|ghp_|ghs_|github_pat_|AKIA|ASIA)/i.test(b.evidenceRef))deny();
 if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000||/[\p{Cc}]/u.test(b.reason)||/(?:Bearer\s+\S+|sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:hf_|ghp_|ghs_|github_pat_)[A-Za-z0-9_]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(b.reason))deny();
 if(b.revision!==undefined)int(b.revision,1);return structuredClone(b) as unknown as ExternalBillingAttestation;
}
function workerBody(value:unknown,id:string):ExternalWorkerRequest{
 const b=obj(value,['lease','runtimeId','request']),l=obj(b.lease,['taskId','runId','workerId','token','expiresAt']);
 for(const k of ['taskId','runId','workerId','token'])text(l[k]);int(l.expiresAt);text(b.runtimeId);if(l.taskId!==id)deny();
 const r=obj(b.request,['profileId','requestId','operation','parameters']);text(r.profileId);text(r.requestId);
 switch(r.operation){
  case 'aws.spot.start':{const p=obj(r.parameters,['lifetimeMs']);int(p.lifetimeMs,1);break;}
  case 'aws.spot.inspect':{const p=obj(r.parameters,['startActionId']);text(p.startActionId);break;}
  case 'hf.model.commit':{const p=obj(r.parameters,['artifactDigest','message']);text(p.artifactDigest,/^[a-f0-9]{64}$/);text(p.message,/^[^\p{Cc}]{1,200}$/u);break;}
  case 'hf.model.lfs_commit':{const p=obj(r.parameters,['manifestDigest','message']);text(p.manifestDigest,/^[a-f0-9]{64}$/);text(p.message,/^[^\p{Cc}]{1,200}$/u);break;}
  case 'aws.s3.put':{try{validateExternalS3Parameters(r.parameters);}catch{deny();}obj(r.parameters,['keySuffix','artifactDigest']);break;}
  case 'aws.s3.inspect':{try{validateExternalS3InspectParameters(r.parameters);}catch{deny();}obj(r.parameters,['putActionId']);break;}
  case 'github.branch.push':{const p=obj(r.parameters,['artifactDigest','expectedHead']);text(p.artifactDigest,/^[a-f0-9]{64}$/);text(p.expectedHead,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);break;}
  default:deny();
 }
 return structuredClone(b) as unknown as ExternalWorkerRequest;
}
function artifactBody(value:unknown,id:string):ExternalArtifactRequest {
 const b=obj(value,['lease','runtimeId','profileId','artifact']),l=obj(b.lease,['taskId','runId','workerId','token','expiresAt']);
 for(const k of ['taskId','runId','workerId','token'])text(l[k]);int(l.expiresAt);text(b.runtimeId);text(b.profileId);if(l.taskId!==id)deny();
 return structuredClone(b) as unknown as ExternalArtifactRequest;
}
function canonical(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';}
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function publicAction(j:ExternalJournal,a?:ExternalAction,audit:Pick<ExternalPublicAction,'profileId'|'approvedTarget'|'approvedProfileHash'>={}):ExternalPublicAction{
 if(j.undispatched){if(a)deny(503);return {revision:j.revision,requestId:j.requestId,phase:j.phase,...audit,status:'cancelled',effect:'none',cleanupStatus:'none',verifiedCostMicros:0,billingFinal:true,reservedMicros:0,billingEvidence:'undispatched_intent',...(j.reservation?{upperBoundMicros:j.reservation.estimatedCostMicros}:{})};}
 const provenance:Pick<ExternalPublicAction,'billingSource'|'evidenceRef'|'attestedAt'>={};
 if(a?.billingSource){provenance.billingSource=a.billingSource;if(a.operatorBilling){provenance.evidenceRef=a.operatorBilling.evidenceRef;provenance.attestedAt=a.operatorBilling.at;}}
 const resourceId=a?.resource?.id;if(resourceId!==undefined&&(typeof resourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(resourceId)))deny(503);
 return {revision:j.revision,requestId:j.requestId,phase:j.phase,...audit,...provenance,...(j.recoveryIssue?{recoveryIssue:j.recoveryIssue}:{}),...(a?{...(resourceId!==undefined?{resourceId}:{}),actionId:a.id,status:a.status,operation:a.operation,effect:a.effect,cleanupStatus:a.cleanupStatus,verifiedCostMicros:a.verifiedCostMicros,billingFinal:a.billingFinal,upperBoundMicros:a.upperBoundMicros,reservedMicros:a.reservedMicros}:{})};
}
type ApprovalMap=Record<string,ExternalApproval>;
interface AuditSnapshot {approvals:ApprovalMap;actions:Record<string,ExternalAction>}
function approvedTarget(profile:ExternalProfile):ApprovedExternalTarget{
 let target:ApprovedExternalTarget;
 if(profile.provider==='aws')target={accountId:profile.target.accountId,region:profile.target.region,workloadId:profile.target.workloadId};
 else if(profile.provider==='s3')target={accountId:profile.target.accountId,region:profile.target.region,bucket:profile.target.bucket,prefix:profile.target.prefix};
 else if(profile.provider==='hf')target={repository:profile.target.repository,revision:profile.target.revision,...(profile.target.visibility!==undefined?{visibility:profile.target.visibility}:{}),...(Object.hasOwn(profile.target,'allowPublicLarge')?{allowPublicLarge:profile.target.allowPublicLarge}:{})};
 else if(profile.provider==='github')target={repository:profile.target.repository,branch:profile.target.branch};
 else return deny(503);
 if(profile.provider==='hf'&&Object.hasOwn(profile.target,'allowPublicLarge')){try{assertHfLfsAllowed(profile.target.visibility,profile.target.allowPublicLarge);}catch{deny(503);}}
 if(Object.entries(target).some(([key,value])=>key!=='allowPublicLarge'&&(typeof value!=='string'||!value.length||value.length>256||/[\p{Cc}]/u.test(value))))deny(503);
 return target;
}
function actionReferences(a:ExternalAction,provider:ExternalProfile['provider']):Pick<ExternalPublicAction,'parameterHash'|'parameters'|'providerResult'>{
 const result:Pick<ExternalPublicAction,'parameterHash'|'parameters'|'providerResult'>={},p=a.parameters as unknown as Record<string,unknown>;
 const hex=(value:unknown,length:number)=>typeof value==='string'&&new RegExp('^[a-fA-F0-9]{'+length+'}$').test(value);
 if(typeof a.parametersHash==='string'&&/^[a-f0-9]{64}$/.test(a.parametersHash))result.parameterHash=a.parametersHash;
 if(a.operation==='aws.spot.start'&&typeof p.lifetimeMs==='number'&&Number.isSafeInteger(p.lifetimeMs)&&p.lifetimeMs>0)result.parameters={lifetimeMs:p.lifetimeMs};
 else if(a.operation==='aws.spot.inspect'&&typeof p.startActionId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(p.startActionId))result.parameters={startActionId:p.startActionId};
 else if(a.operation==='hf.model.commit'&&hex(p.artifactDigest,64))result.parameters={artifactDigest:p.artifactDigest as string};
 else if(a.operation==='hf.model.lfs_commit'&&hex(p.manifestDigest,64))result.parameters={manifestDigest:p.manifestDigest as string};
 else if(a.operation==='aws.s3.put'&&hex(p.artifactDigest,64)&&typeof p.keySuffix==='string'&&p.keySuffix.length<=240&&/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(p.keySuffix))result.parameters={keySuffix:p.keySuffix,artifactDigest:p.artifactDigest as string};
 else if(a.operation==='aws.s3.inspect'&&typeof p.putActionId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(p.putActionId))result.parameters={putActionId:p.putActionId};
 else if(a.operation==='github.branch.push'&&hex(p.artifactDigest,64)&&(hex(p.expectedHead,40)||hex(p.expectedHead,64)))result.parameters={artifactDigest:p.artifactDigest as string,expectedHead:p.expectedHead as string};
 const evidence=a.providerReceipt?.evidenceId;
 if(typeof evidence==='string'){
  const aws=/^aws:(i-[a-fA-F0-9]{8,32})$/.exec(evidence),hf=/^hf:([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.exec(evidence),github=/^github:([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.exec(evidence);
  if(provider==='aws'&&aws)result.providerResult={kind:'aws_instance',id:aws[1]!};
  else if(provider==='hf'&&hf)result.providerResult={kind:'hf_commit',oid:hf[1]!};
  else if(provider==='github'&&github)result.providerResult={kind:'github_commit',oid:github[1]!};
 }
 return result;
}
/** Standalone only: the caller supplies trusted core, broker, registry and durable store.
 * A live resource keeps the MAIN reservation until broker-confirmed absence and final cost.
 */
export function createAutonomousExternalService(options:ExternalBridgeOptions):AutonomousExternalService {
 const {core,broker,registry,store}=options;
 const fingerprint=options.configurationFingerprint??digest({mode:'standalone-external'});if(!/^[a-f0-9]{64}$/.test(fingerprint))deny(503);
 const hfDisplay=(target:unknown):ExternalHfVisibilityDisplay=>{try{return hfVisibilityDisplay(target);}catch{return deny(503);}};
 const approvalHash=(profile:unknown)=>digest({profile,configurationFingerprint:fingerprint});
 function stopAdmission(t:CanonicalTask){
  const revisions=new Set([t.revision,...store.listJournal(t.id).map(j=>j.revision)]);
  for(const revision of revisions){
   // Reset wake only on the transition, not every metadata read/backoff attempt.
   if(!store.isTaskBlocked(t.id,revision))store.blockTask(t.id,revision);
   broker.cancel(t.id,revision,'Canonical task stopped');
  }
 }
 const task=async(id:string)=>{text(id);const t=await core.execute('get',{id}) as CanonicalTask;if(t.stopReason||t.status==='stopping')stopAdmission(t);return t;};
 function profiles(t:CanonicalTask){
  const ids=t.spec.externalProfiles;
  if(!Array.isArray(ids)||ids.length<1||ids.length>3||new Set(ids).size!==ids.length)deny(503);
  const selected=ids.map(id=>{const p=registry.get(id);if(!p||p.enabled!==true||p.id!==id)deny(503);return p;});
  if(new Set(selected.map(p=>p.provider)).size!==selected.length)deny(503);
  return selected;
 }
 function profile(t:CanonicalTask,id:string){const p=profiles(t).find(p=>p.id===id);if(!p)deny(503);return p;}
 function journalFor(t:CanonicalTask,requestId:string,revision?:number){
  if(revision!==undefined)int(revision,1);
  const matches=store.listJournal(t.id).filter(j=>j.requestId===requestId);
  if(revision===undefined&&matches.length>1)deny(409);
  const j=revision===undefined?matches[0]:matches.find(j=>j.revision===revision);if(!j)deny(404);return j;
 }
 function owned(j:ExternalJournal,a:ExternalAction,approvals?:ApprovalMap):ExternalAction{
  const p=approvals?approvals[a.approvalId]:store.transaction(s=>s.approvals[a.approvalId]);
  if(!p||a.profileHash!==p.profileHash||digest(p.profile)!==p.profileHash||p.taskId!==j.taskId||p.revision!==j.revision||a.requestId!==j.requestId||digest({taskId:j.taskId,revision:j.revision,profileId:p.profileId,requestId:a.requestId,operation:a.operation,parameters:a.parameters})!==j.requestHash)deny(409);return a;
 }
 function findBroker(j:ExternalJournal,cache?:AuditSnapshot):ExternalAction|undefined{
  if(cache){const a=Object.values(cache.actions).find(a=>{const p=cache.approvals[a.approvalId];return p?.taskId===j.taskId&&p.revision===j.revision&&a.requestId===j.requestId;});return a?owned(j,a,cache.approvals):undefined;}
  const a=store.transaction(s=>Object.values(s.actions).find(a=>{const p=s.approvals[a.approvalId];return p?.taskId===j.taskId&&p.revision===j.revision&&a.requestId===j.requestId;}));return a?owned(j,a):undefined;
 }
 function brokerAction(j:ExternalJournal,cache?:AuditSnapshot){if(cache&&j.brokerActionId){const a=cache.actions[j.brokerActionId];if(!a)deny(409);return owned(j,a,cache.approvals);}return j.brokerActionId?owned(j,broker.getAction(j.brokerActionId)):findBroker(j,cache);}
 function present(j:ExternalJournal,a?:ExternalAction,cache?:ApprovalMap):ExternalPublicAction{
  const approvals=cache??store.transaction(s=>{const p=a?s.approvals[a.approvalId]:Object.values(s.approvals).find(p=>p.taskId===j.taskId&&p.revision===j.revision&&p.profileId===j.request?.profileId);return p?{[p.id]:p}:{};});
  const p=a?approvals[a.approvalId]:Object.values(approvals).find(p=>p.taskId===j.taskId&&p.revision===j.revision&&p.profileId===j.request?.profileId);
  if(a)owned(j,a,approvals);
  if(!p)return publicAction(j,a);
  if(p.taskId!==j.taskId||p.revision!==j.revision||p.profileHash!==digest(p.profile))deny(409);
  if(!a&&(!j.request||j.request.taskId!==j.taskId||j.request.revision!==j.revision||j.request.requestId!==j.requestId||digest(j.request)!==j.requestHash))deny(409);
  return {...publicAction(j,a,{profileId:p.profileId,approvedTarget:approvedTarget(p.profile),approvedProfileHash:p.profileHash}),...(a?actionReferences(a,p.profile.provider):{})};
 }
 function link(j:ExternalJournal,a:ExternalAction,approvals?:ApprovalMap){
  owned(j,a,approvals);
  const latest=store.getJournal(j.taskId,j.revision,j.requestId)??j;
  const next={...latest,brokerActionId:a.id,resourceId:a.resource?.id,phase:'broker' as const};store.putJournal(next);return store.getJournal(j.taskId,j.revision,j.requestId)!;
 }
 async function undispatched(j:ExternalJournal,lease?:AutonomousLease):Promise<ExternalPublicAction>{
  // This monotonic fence commits before proving absence. execute() checks it with
  // no await before real ExternalBroker.execute synchronously publishes its intent.
  store.putJournal({...j,dispatchBlocked:true});j=store.getJournal(j.taskId,j.revision,j.requestId)!;
  const a=brokerAction(j);if(a)return sync(j,a,lease);if(j.undispatched)return present(j);
  if(!j.request||!j.reservation||j.brokerActionId||j.request.taskId!==j.taskId||j.request.revision!==j.revision||j.request.requestId!==j.requestId||digest(j.request)!==j.requestHash||j.mainRequestId!=='external:'+j.requestHash)deny(409);
  const approval=store.transaction(s=>Object.values(s.approvals).find(p=>p.taskId===j.taskId&&p.revision===j.revision&&p.profileId===j.request!.profileId));
  if(!approval||j.reservation.tool!=='mcp__hivemind__action'||j.reservation.system!==approval.profile.provider||j.reservation.operation!==j.request.operation||j.reservation.estimatedCostMicros!==approval.profile.upperBoundMicros)deny(409);
  const t=await task(j.taskId),main=t.actions.find(m=>m.requestId===j.mainRequestId);
  if(!main){
   if(!t.stopReason||!['stopping','completed','cancelled','budget_exceeded','expired','failed'].includes(t.status)||j.phase!=='intent'||j.mainReservationId!==undefined||j.resourceId!==undefined)deny(409);
   const late=brokerAction(j);if(late)return sync(j,late,lease);
   // Canonical stop forbids a future reserve; no main reservation exists to settle.
   store.putJournal({...j,dispatchBlocked:true,undispatched:true,phase:'settled'});
   return present(store.getJournal(j.taskId,j.revision,j.requestId)!);
  }
  if(j.mainReservationId!==undefined&&j.mainReservationId!==main.id||main.tool!==j.reservation.tool||main.system!==j.reservation.system||main.operation!==j.reservation.operation||main.estimatedCostMicros!==j.reservation.estimatedCostMicros||main.resourceId!==undefined||t.resources.some(r=>r.actionId===main.id)||!['reserved','unknown','failed'].includes(main.status)||main.actualCostMicros!==undefined&&main.actualCostMicros!==0)deny(409);
  // No new intent can appear after the fence; recheck after the canonical read.
  const late=brokerAction(j);if(late)return sync(j,late,lease);
  j={...j,mainReservationId:main.id,dispatchBlocked:true};store.putJournal(j);
  await core.execute('settleExternal',{id:j.taskId,actionId:main.id,actualCostMicros:0,success:false});
  store.putJournal({...j,undispatched:true,phase:'settled'});return present(store.getJournal(j.taskId,j.revision,j.requestId)!);
 }
 async function sync(j:ExternalJournal,a:ExternalAction,lease?:AutonomousLease){
  const approvals=store.transaction(s=>{const p=s.approvals[a.approvalId];return p?{[p.id]:p}:{};});
  j=link(j,a,approvals);
  let t=await task(j.taskId),main=t.actions.find(m=>m.id===j.mainReservationId&&m.requestId===j.mainRequestId);if(!main)deny(409);
  const known=!['intent','dispatching','ambiguous'].includes(a.status)&&a.effect!=='unknown';
  if(known&&['reserved','unknown'].includes(main.status)&&t.lease&&lease){
   await core.execute('acceptExternal',{id:t.id,lease,actionId:main.id,...(a.resource?{resource:{id:a.resource.id,system:main.system,cleanupOperation:'external.cleanup'}}:{})});
   t=await task(j.taskId);main=t.actions.find(m=>m.id===j.mainReservationId)!;
  }
  if(a.resource&&a.cleanupStatus==='cleaned'&&main.resourceId===a.resource.id)await core.execute('cleanedExternal',{id:t.id,resourceId:a.resource.id});
  if(!known||!a.billingFinal||a.verifiedCostMicros===null||a.resource&&a.cleanupStatus!=='cleaned')return present(j,a,approvals);
  const review=a.billingSource==='operator_attested'&&a.operatorBilling?{evidenceRef:a.operatorBilling.evidenceRef,reason:a.operatorBilling.reason}:undefined;
  const common={id:t.id,actionId:main.id,actualCostMicros:a.verifiedCostMicros,success:a.status==='succeeded',...(review?{review}:{})};
  if(['accepted','reserved','unknown'].includes(main.status)||review)await core.execute('settleExternal',common);
  else if(main.actualCostMicros!==a.verifiedCostMicros)deny(409);
  j={...j,phase:a.cleanupStatus==='cleaned'?'cleaned':'settled'};store.putJournal(j);return present(j,a,approvals);
 }
 type Authority=Pick<ExternalArtifactRequest,'lease'|'runtimeId'|'profileId'>;
 const artifactOperation:Record<string,string>={hf:'hf.model.commit',github:'github.branch.push',s3:'aws.s3.put'};
 /** Shared lease, approval and fingerprint check for artifact publication and large uploads. */
 async function artifactAuthority(id:string,body:Authority,operation?:'hf.model.lfs_commit'){
  const auth=await core.execute('nativeStart',{id,lease:body.lease,runtimeId:body.runtimeId}) as {taskId:string;spec:AutonomousSpec};
  const t=await task(id),p=profile(t,body.profileId);
  if(auth.taskId!==id||digest(auth.spec)!==digest(t.spec)||t.approvedAt===undefined||t.status!=='running'||store.isTaskBlocked(id,t.revision))deny(409);
  if(operation==='hf.model.lfs_commit'){if(p.provider!=='hf'||!(p.operations as string[]).includes(operation))deny(403);try{assertHfLfsAllowed(p.target.visibility,p.target.allowPublicLarge);}catch{deny(403);}}
  else{if(p.provider!=='hf'&&p.provider!=='github'&&p.provider!=='s3')deny(403);if(!(p.operations as string[]).includes(artifactOperation[p.provider]!))deny(403);}
  const approved=store.transaction(s=>Object.values(s.approvals).some(a=>a.taskId===id&&a.revision===t.revision&&a.profileId===p.id&&a.profileHash===digest(p)&&a.stoppedAt===undefined));
  if(!approved||store.approvalFingerprint(id,t.revision,p.id)!==fingerprint)deny(403);
  return {taskId:id,revision:t.revision,profileId:p.id,profileHash:digest(p),configurationFingerprint:fingerprint};
 }
 const service:AutonomousExternalService={
  ...(options.oidcAudit?{oidcAudit:async(id:string,query?:{after?:number;limit?:number})=>{await task(id);return options.oidcAudit!(id,query);}}:{}),
  async publishArtifact(id,raw){
   const body=artifactBody(raw,id);if(!options.artifactPublisher)deny(503);
   const authority=await artifactAuthority(id,body);
   const secrets=[...(options.knownSecretValues?.()??[]),body.lease.token,body.runtimeId];
   const artifact=validateExternalArtifact(body.artifact,secrets),artifactDigest=externalArtifactDigest(artifact);
   const bytes=artifact.files.reduce((sum,f)=>sum+Buffer.from(f.contentBase64,'base64').length,0);
   const grant={...authority,artifactDigest,bytes};
   store.reserveArtifactGrant(grant);
   const revalidate=async()=>{const fresh=await artifactAuthority(id,body);if(digest(fresh)!==digest(authority))deny(409);validateExternalArtifact(artifact,[...(options.knownSecretValues?.()??[]),body.lease.token,body.runtimeId]);};
   const result=await options.artifactPublisher.publish(artifact,{knownSecretValues:secrets,beforeWrite:revalidate});
   if(result.artifactDigest!==artifactDigest)deny(409);
   await revalidate();store.bindArtifactGrant(grant);return {artifactDigest};
  },
  async largeAuthority(id,raw){
   const a=await artifactAuthority(id,raw,'hf.model.lfs_commit');
   return {taskId:a.taskId,revision:a.revision,profileId:a.profileId};
  },
  async saveLargeManifest(manifest,manifestDigest){
   if(!options.manifestStore)deny(503);
   const t=await task(manifest.taskId),p=profile(t,manifest.profileId);
   if(t.revision!==manifest.revision||p.provider!=='hf'||!(p.operations as string[]).includes('hf.model.lfs_commit')||store.isTaskBlocked(t.id,t.revision))deny(409);
   try{assertHfLfsAllowed(p.target.visibility,p.target.allowPublicLarge);}catch{deny(403);}
   const grant={taskId:t.id,revision:t.revision,profileId:p.id,manifestDigest,profileHash:digest(p),configurationFingerprint:fingerprint,files:manifest.files.length,bytes:manifest.files.reduce((sum,f)=>sum+f.size,0)};
   if(store.approvalFingerprint(t.id,t.revision,p.id)!==fingerprint)deny(403);
   store.reserveManifestGrant(grant);
   await options.manifestStore.save(manifest,manifestDigest);
   if(store.isTaskBlocked(t.id,t.revision))deny(409);
   store.bindManifestGrant(grant);
  },
  async profiles(id){const t=await task(id);return (t.spec.externalProfiles??[]).map(id=>{
   const p=registry.get(id);if(!p)return {id,enabled:false,profileHash:approvalHash({id,enabled:false})};
   return {...(options.profileMetadata?.(t,p)??{}),id,accounting:'upper_bound_not_invoice' as const,enabled:p.enabled===true,profileHash:approvalHash(p),provider:p.provider,target:structuredClone(p.target),credentialRef:p.credentialRef,operations:[...p.operations],maxLifetimeMs:p.maxLifetimeMs,upperBoundMicros:p.upperBoundMicros,maxActiveActions:p.maxActiveActions,...(p.provider==='hf'?{hfVisibilityDisplay:hfDisplay(p.target)}:{})};
  });},
  async assertApproval(id,revision,hashes){
   const t=await task(id);if(t.revision!==revision||store.isTaskBlocked(id,revision))deny(409);const selected=profiles(t),ids=selected.map(p=>p.id);obj(hashes,ids);
   const expected:Record<string,string>={};for(const p of selected){if(typeof hashes[p.id]!=='string'||!/^[a-f0-9]{64}$/.test(hashes[p.id]!)||hashes[p.id]!==approvalHash(p))deny(409);expected[p.id]=hashes[p.id]!;}
   store.bindApprovalPreflight(id,revision,{profileHashes:expected,configurationFingerprint:fingerprint});
  },
  async approve(id,hashes){
   const t=await task(id),selected=profiles(t);if(t.approvedAt===undefined||!['ready','running','waiting','awaiting_input'].includes(t.status)||store.isTaskBlocked(id,t.revision))deny(409);
   if(hashes)await service.assertApproval(id,t.revision,hashes);
   const preflight=store.approvalPreflight(id,t.revision);
   if(!preflight||preflight.configurationFingerprint!==fingerprint||selected.some(p=>preflight.profileHashes[p.id]!==approvalHash(p)))deny(409);
   for(const p of selected){const prior=store.approvalFingerprint(id,t.revision,p.id);if(prior&&prior!==fingerprint)deny(409);}
   for(const p of selected){broker.serverApprove({taskId:id,revision:t.revision,profileId:p.id,endsAt:t.spec.endsAt,budgetMicros:t.spec.budgetMicros});store.bindApprovalFingerprint(id,t.revision,p.id,fingerprint);}
   return {taskId:id,revision:t.revision,profileId:selected[0]!.id,profileIds:selected.map(p=>p.id)};
  },
  async execute(id,raw){
   const body=workerBody(raw,id);
   const auth=await core.execute('nativeStart',{id,lease:body.lease,runtimeId:body.runtimeId}) as {taskId:string;spec:AutonomousSpec};
   const t=await task(id),p=profile(t,body.request.profileId);
   if(auth.taskId!==id||digest(auth.spec)!==digest(t.spec)||t.approvedAt===undefined||t.status!=='running'||store.isTaskBlocked(id,t.revision))deny(409);
   if(!(p.operations as string[]).includes(body.request.operation))deny(403);
   if(body.request.operation==='aws.spot.start'&&Number((body.request.parameters as {lifetimeMs:number}).lifetimeMs)>p.maxLifetimeMs)deny(403);
   const approved=store.transaction(s=>Object.values(s.approvals).some(a=>a.taskId===id&&a.revision===t.revision&&a.profileId===p.id&&a.profileHash===digest(p)&&a.stoppedAt===undefined));
   if(!approved||store.approvalFingerprint(id,t.revision,p.id)!==fingerprint)deny(403);
   if(body.request.operation==='hf.model.lfs_commit'){
    try{assertHfLfsAllowed((p.target as {visibility?:unknown}).visibility,(p.target as {allowPublicLarge?:true}).allowPublicLarge);}catch{deny(403);}
    const grant=store.getManifestGrant(id,t.revision,p.id,(body.request.parameters as {manifestDigest:string}).manifestDigest);
    if(!grant||grant.published!==true||grant.profileHash!==digest(p)||grant.configurationFingerprint!==fingerprint)deny(403);
   }else if((p.provider==='hf'||p.provider==='github'||body.request.operation==='aws.s3.put')&&options.allowPreseededArtifacts!==true){
    const artifactDigest=(body.request.parameters as {artifactDigest:string}).artifactDigest;
    const grant=store.getArtifactGrant(id,t.revision,p.id,artifactDigest);
    if(!grant||grant.published!==true||grant.profileHash!==digest(p)||grant.configurationFingerprint!==fingerprint)deny(403);
   }
   await options.beforeExecute?.(id,body);
   const request={...body.request,taskId:id,revision:t.revision} as ExternalActionRequest;
   const requestHash=digest(request),mainRequestId='external:'+requestHash;
   let j=store.getJournal(id,t.revision,body.request.requestId);
   if(j&&j.requestHash!==requestHash)deny(409);
   const reservation={tool:'mcp__hivemind__action',system:p.provider,operation:body.request.operation,estimatedCostMicros:p.upperBoundMicros};
   if(!j){j={taskId:id,revision:t.revision,requestId:body.request.requestId,requestHash,mainRequestId,phase:'intent',request,reservation};store.putJournal(j);}
   if(j.dispatchBlocked)return undispatched(j,body.lease);
   let main:AutonomousAction;
   try{main=await core.execute('reserve',{id,lease:body.lease,request:{requestId:mainRequestId,...reservation}}) as AutonomousAction;}
   catch(error){
    if((error as {commitState?:unknown})?.commitState===true)await task(id);
    throw error;
   }
   j={...j,mainReservationId:main.id,phase:'reserved'};store.putJournal(j);
   if(store.isTaskBlocked(id,t.revision))deny(409);
   const fresh=store.getJournal(id,t.revision,j.requestId)!;if(fresh.dispatchBlocked)return undispatched(fresh,body.lease);
   // No await between fence read and real broker's synchronous durable intent publication.
   const a=await broker.execute(request);return sync(store.getJournal(id,t.revision,j.requestId)!,a,body.lease);
  },
  async list(id,query){
   await task(id);const page=query===undefined?{items:store.listJournal(id)}:store.pageJournal(id,query),keys=new Set(page.items.map(j=>JSON.stringify([j.revision,j.requestId]))),revisions=new Set(page.items.map(j=>j.revision));
   const cache=store.transaction(s=>{
    const approvals:ApprovalMap={};for(const p of Object.values(s.approvals))if(p.taskId===id&&revisions.has(p.revision))approvals[p.id]=p;
    const actions:Record<string,ExternalAction>={};for(const a of Object.values(s.actions)){const p=approvals[a.approvalId];if(p&&keys.has(JSON.stringify([p.revision,a.requestId])))actions[a.id]=a;}
    return {approvals,actions};
   });
   const items=page.items.map(j=>present(j,brokerAction(j,cache),cache.approvals));return query===undefined?items:{...page,items};
  },
  async reconcile(id,requestId,revision){const j=journalFor(await task(id),requestId,revision),a=brokerAction(j);if(!a)return undispatched(j);return sync(j,await broker.reconcile(a.id));},
  async cleanup(id,requestId,revision){const j=journalFor(await task(id),requestId,revision),a=brokerAction(j);if(!a)return undispatched(j);return sync(j,await broker.cleanup(a.id));},
  async attestBilling(id,requestId,raw){
   const billing=billingBody(raw),j=journalFor(await task(id),requestId,billing.revision),a=brokerAction(j);
   if(!a||!['succeeded','failed'].includes(a.status)||a.effect==='unknown'||a.resource&&a.cleanupStatus!=='cleaned')deny(409);
   const attest=Reflect.get(broker,'serverAttestBilling');if(typeof attest!=='function')deny(503);
   const reviewed=await Reflect.apply(attest,broker,[a.id,billing.actualCostMicros,billing.evidenceRef,billing.reason]) as ExternalAction;
   return sync(j,reviewed);
  },
  async beforeCoreMutation(id,operation){
   if(!['cancel','revise','finish'].includes(operation))deny();const t=await task(id);
   // The tombstone survives a crash between admission stop and canonical mutation.
   store.blockTask(id,t.revision);broker.cancel(id,t.revision,'Canonical '+operation);
   for(const revision of new Set(store.listJournal(id).map(j=>j.revision)))if(revision!==t.revision)broker.cancel(id,revision,'Canonical '+operation);
   if(options.largeStore){
    // Cancelling uploads is part of stopping admission. A failure keeps the core mutation from running.
    for(const revision of new Set([t.revision,...store.listJournal(id).map(j=>j.revision)]))await options.largeStore.abortOwner(id,revision);
   }
  },
  async recover(){
   // Only mark durable dispatches here. Provider I/O is deferred to bounded cleanupDue.
   broker.recover();
  },
 };
 return service;
}
export interface ExternalApiOptions {operatorToken:string;workerToken:string;service:AutonomousExternalService;
 /** Large upload wiring. Without it, external-large routes answer 503. */
 large?:{store:Pick<ExternalLargeStore,'begin'|'part'|'complete'|'abort'|'open'>;limits:ExternalLargeLimits;partBytes?:number;ttlMs?:number;now?:()=>number}}
async function body(request:Request,max=65536){
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))deny(413);
 const reader=request.body?.getReader();if(!reader)deny();let bytes=0;const chunks:Uint8Array[]=[];
 try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>max){await reader.cancel();deny(413);}chunks.push(item.value);}}finally{reader.releaseLock();}
 const raw=new Uint8Array(bytes);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{deny();}
}
const equal=(a:string,b:string)=>{let difference=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)difference|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return difference===0;};
export async function handleAutonomousExternalApi(request:Request,options?:ExternalApiOptions):Promise<Response>{
 const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
 try{
  const url=new URL(request.url);
  if(/^\/v1\/autonomous-tasks\/[^/]+\/external-large(?:\/|$)/.test(url.pathname)){
   const {service,large}=options??{} as Partial<ExternalApiOptions>;
   if(!options||!large||!service?.largeAuthority||!service.saveLargeManifest||!options.operatorToken||!options.workerToken||options.operatorToken===options.workerToken)return json({error:'External bridge unavailable'},503);
   const authorize=service.largeAuthority.bind(service),saveManifest=(m:ExternalLargeManifest,d:string)=>service.saveLargeManifest!(m,d);
   return await handleExternalLargeApi(request,{workerToken:options.workerToken,store:large.store,limits:large.limits,authorize,saveManifest,...(large.partBytes!==undefined?{partBytes:large.partBytes}:{}),...(large.ttlMs!==undefined?{ttlMs:large.ttlMs}:{}),...(large.now?{now:large.now}:{})})??json({error:'Not found'},404);
  }
  const match=url.pathname.match(/^\/v1\/autonomous-tasks\/([^/]+)\/(external-artifact|external-action|external-approval|external-actions|external-cancel|external-profiles|external-oidc-audit)(?:\/([^/]+)\/(reconcile|cleanup|billing))?$/);
  if(!match)return json({error:'Not found'},404);if(!options)return json({error:'External bridge unavailable'},503);
  const worker=match[2]==='external-action'||match[2]==='external-artifact',expected=worker?options.workerToken:options.operatorToken;
  if(!options.operatorToken||!options.workerToken||options.operatorToken===options.workerToken)return json({error:'External bridge unavailable'},503);
  if(!equal(request.headers.get('authorization')??'','Bearer '+expected))return json({error:'Unauthorized'},401);
  if(url.search&&!(['external-actions','external-oidc-audit'].includes(match[2]!)&&!match[3]&&request.method==='GET'))deny();const id=decodeURIComponent(match[1]!);text(id);
  const route=match[2],requestId=match[3]?decodeURIComponent(match[3]):undefined,action=match[4];
  if(route==='external-actions'&&requestId&&action&&request.method==='POST'){
   text(requestId);if(action==='billing')return json(await options.service.attestBilling(id,requestId,billingBody(await body(request))));
   const input=obj(await body(request),[],['revision']);if(input.revision!==undefined)int(input.revision,1);return json(await options.service[action as 'reconcile'|'cleanup'](id,requestId,input.revision as number|undefined));
  }
  if(requestId)return json({error:'Not found'},404);
  if(route==='external-artifact'&&request.method==='POST')return json(await options.service.publishArtifact(id,artifactBody(await body(request,2*1024*1024),id)));
  if(worker&&request.method==='POST')return json(await options.service.execute(id,workerBody(await body(request),id)));
  if(route==='external-oidc-audit'&&request.method==='GET'){
   if(!options.service.oidcAudit)deny(503);const query:{after?:number;limit?:number}={};if(url.search.length>1024)deny();for(const key of url.searchParams.keys()){if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)deny();const value=url.searchParams.get(key)!;if(!/^(0|[1-9][0-9]{0,15})$/.test(value)||!Number.isSafeInteger(Number(value))||key==='limit'&&(Number(value)<1||Number(value)>100))deny();query[key as 'after'|'limit']=Number(value);}return json(await options.service.oidcAudit(id,query));
  }
  if(route==='external-profiles'&&request.method==='GET')return json(await options.service.profiles(id));
  if(route==='external-actions'&&request.method==='GET'){
   if(!url.search)return json(await options.service.list(id));if(url.search.length>2048)deny();const query:ExternalJournalQuery={};
   for(const key of url.searchParams.keys())if(!['limit','cursor'].includes(key)||url.searchParams.getAll(key).length!==1)deny();
   if(url.searchParams.has('limit')){const v=url.searchParams.get('limit')!;if(!/^[1-9][0-9]{0,2}$/.test(v)||Number(v)>100)deny();query.limit=Number(v);}
   if(url.searchParams.has('cursor')){const v=url.searchParams.get('cursor')!;if(!v||v.length>1024)deny();query.cursor=v;}
   return json(await options.service.list(id,query));
  }
  if(route==='external-approval'&&request.method==='POST'){const value=obj(await body(request),['externalProfileHashes']);if(!value.externalProfileHashes||typeof value.externalProfileHashes!=='object'||Array.isArray(value.externalProfileHashes))deny();return json(await options.service.approve(id,value.externalProfileHashes as Record<string,string>));}
  if(route==='external-cancel'&&request.method==='POST'){obj(await body(request),[]);await options.service.beforeCoreMutation(id,'cancel');return json({taskId:id,admissionStopped:true});}
  return json({error:'Not found'},404);
 }catch(error){const code=(error as {statusCode?:number})?.statusCode,status=code&&[400,401,403,404,409,413,422,503].includes(code)?code:503;return json({error:'External action unavailable'},status);}
}
