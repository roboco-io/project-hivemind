import {createHash, randomUUID} from 'node:crypto';
import type {ExternalS3Parameters} from '../../contracts/src/autonomous-external-s3.js';
import type {
  ExternalAction, ExternalActionRequest, ExternalApproval, ExternalApprovalRequest,
  ExternalBrokerOptions, ExternalCredentialScope, ExternalInvocation, ExternalOperation,
  ExternalProfile, ExternalProviderReceipt, ExternalState,
  ExternalProviderTransport,
} from '../../contracts/src/autonomous-external.js';
import {validateExternalS3InspectParameters,validateExternalS3Parameters,validateExternalS3Target} from './autonomous-external-s3.ts';

const copy = structuredClone;
function reject(message:string):never {throw new Error(message);}
function object(value:unknown, required:string[], optional:string[]=[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)reject('Invalid parameters');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  const allowed=new Set([...required,...optional]);
  if(Object.getOwnPropertySymbols(value).length||Object.entries(descriptors).some(([k,d])=>!allowed.has(k)||!('value' in d)||!d.enumerable)||required.some(k=>!Object.hasOwn(descriptors,k)))reject('Invalid parameters');
  return value as Record<string,unknown>;
}
function integer(value:unknown,min=0):asserts value is number {if(!Number.isSafeInteger(value)||Number(value)<min)reject('Invalid integer parameter');}
function text(value:unknown,pattern=/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/):asserts value is string {if(typeof value!=='string'||!pattern.test(value))reject('Invalid text parameter');}
function add(a:number,b:number):number {const value=a+b;integer(value);return value;}
/** Only validated, plain data reaches this canonicalizer. */
function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
function hash(value:unknown):string {return createHash('sha256').update(canonical(value)).digest('hex');}
/** Preserve ledger digest compatibility; profileHash separately binds the fixed profile. */
export function externalParametersHash(profile:ExternalProfile,operation:ExternalOperation,parameters:ExternalInvocation['parameters']):string {
  const p=validateProfile(profile);
  validateParameters({taskId:'hash',revision:1,profileId:p.id,requestId:'hash',operation,parameters} as ExternalActionRequest,p);
  return hash({operation,parameters});
}
/** Bind private read-only progress to the complete approved action scope. */
export function externalRecoveryBinding(i:Pick<ExternalInvocation,'actionId'|'taskId'|'revision'|'profile'|'parametersHash'|'ownershipToken'|'idempotencyKey'>):string {
  return hash([i.actionId,i.taskId,i.revision,i.profile,i.parametersHash,i.ownershipToken,i.idempotencyKey]);
}
export function parseExternalRecoveryCursor(cursor:string,bindingHash:string):{version:1;bindingHash:string;head:string;page:number} {
  if(typeof cursor!=='string'||cursor.length>512)reject('Invalid recovery cursor');
  const c=JSON.parse(cursor);object(c,['version','bindingHash','head','page']);
  if(c.version!==1||c.bindingHash!==bindingHash)reject('Invalid recovery binding');
  text(c.head,/^[a-f0-9]{40}$/);integer(c.page,2);if(c.page>1000000)reject('Invalid recovery page');
  return c as {version:1;bindingHash:string;head:string;page:number};
}
export interface ExternalDispatchAuthority {readonly signal:AbortSignal;assertActive():void}
export interface GuardedExternalProviderTransport<C> extends ExternalProviderTransport<C> {
  execute(invocation:ExternalInvocation,credential:C,authority?:ExternalDispatchAuthority):Promise<ExternalProviderReceipt>;
}
const approvalId=(r:Pick<ExternalApprovalRequest,'taskId'|'revision'|'profileId'>)=>hash([r.taskId,r.revision,r.profileId]);
const operations:Record<string,ExternalOperation[]>={aws:['aws.spot.start','aws.spot.inspect'],hf:['hf.model.commit','hf.model.lfs_commit'],github:['github.branch.push'],s3:['aws.s3.put','aws.s3.inspect']};
/** Operations whose success leaves data at the provider and never a cleanup resource. */
const RETAINED_OPERATIONS:ExternalOperation[]=['hf.model.commit','hf.model.lfs_commit','github.branch.push','aws.s3.put'];
const isInspection=(operation:ExternalOperation)=>operation==='aws.spot.inspect'||operation==='aws.s3.inspect';
function successEffect(operation:ExternalOperation):'resource'|'none'|'retained' {return operation==='aws.spot.start'?'resource':isInspection(operation)?'none':'retained';}
/** Wraps an S3 validator so its errors read like the other profile errors. */
function s3(validate:()=>unknown):void {try{validate();}catch{reject('Invalid S3 profile or parameters');}}
function validateProfile(raw:ExternalProfile|undefined):ExternalProfile {
  if(!raw||raw.enabled!==true)reject('Profile disabled');
  object(raw,['id','provider','target','operations','credentialRef','maxLifetimeMs','upperBoundMicros','maxActiveActions'],['enabled']);
  text(raw.id);text(raw.credentialRef);integer(raw.maxLifetimeMs,1);integer(raw.upperBoundMicros);integer(raw.maxActiveActions,1);
  if(!Object.hasOwn(operations,raw.provider)||!Array.isArray(raw.operations)||!raw.operations.length||raw.operations.length>2||Object.keys(raw.operations).length!==raw.operations.length||Array.from(raw.operations).some(op=>!operations[raw.provider]!.includes(op))||new Set(raw.operations).size!==raw.operations.length)reject('Invalid profile operation');
  if(raw.provider==='aws') {object(raw.target,['accountId','region','workloadId']);text(raw.target.accountId,/^\d{12}$/);text(raw.target.region,/^[a-z]{2}-[a-z]+-\d$/);text(raw.target.workloadId,/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);}
  else if(raw.provider==='s3') {s3(()=>validateExternalS3Target(raw.target));}
  else {
    object(raw.target,['repository',raw.provider==='hf'?'revision':'branch'],raw.provider==='hf'?['visibility']:[]);
    if(raw.provider==='hf'){
      const visibility=(raw.target as {visibility?:unknown}).visibility;
      if(visibility!==undefined&&visibility!=='private'&&visibility!=='public')reject('Invalid profile target');
      // Multi-GiB files cannot pass the nested secret scan, so a public repository never gets LFS commits.
      if(visibility==='public'&&(raw.operations as string[]).includes('hf.model.lfs_commit'))reject('LFS commit requires a private repository');
    }text(raw.target.repository,/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/);
    const ref=raw.provider==='hf'?raw.target.revision:raw.target.branch;
    text(ref,/^[A-Za-z0-9][A-Za-z0-9_./-]{0,149}$/);
    if(ref.includes('..')||ref.includes('//')||ref.endsWith('/')||ref.endsWith('.lock'))reject('Invalid profile target');
  }
  return copy(raw);
}
function validateApproval(r:ExternalApprovalRequest) {
  object(r,['taskId','revision','profileId','endsAt','budgetMicros']);text(r.taskId);text(r.profileId);integer(r.revision,1);integer(r.endsAt);integer(r.budgetMicros);
}
function validateParameters(r:ExternalActionRequest,p:ExternalProfile) {
  object(r,['taskId','revision','profileId','requestId','operation','parameters']);
  text(r.taskId);text(r.profileId);text(r.requestId);integer(r.revision,1);
  if(!(p.operations as string[]).includes(r.operation))reject('Unapproved operation');
  switch(r.operation) {
    case 'aws.spot.start':object(r.parameters,['lifetimeMs']);integer(r.parameters.lifetimeMs,1);if(r.parameters.lifetimeMs>p.maxLifetimeMs)reject('Lifetime parameter exceeds profile');break;
    case 'aws.spot.inspect':object(r.parameters,['startActionId']);text(r.parameters.startActionId);break;
    case 'hf.model.commit':object(r.parameters,['artifactDigest','message']);text(r.parameters.artifactDigest,/^[a-f0-9]{64}$/);text(r.parameters.message,/^[^\p{Cc}]{1,200}$/u);break;
    case 'hf.model.lfs_commit':object(r.parameters,['manifestDigest','message']);text(r.parameters.manifestDigest,/^[a-f0-9]{64}$/);text(r.parameters.message,/^[^\p{Cc}]{1,200}$/u);if(p.provider==='hf'&&p.target.visibility==='public')reject('LFS commit requires a private repository');break;
    case 'aws.s3.put':s3(()=>validateExternalS3Parameters(r.parameters));break;
    case 'aws.s3.inspect':s3(()=>validateExternalS3InspectParameters(r.parameters));break;
    case 'github.branch.push':object(r.parameters,['artifactDigest','expectedHead']);text(r.parameters.artifactDigest,/^[a-f0-9]{64}$/);text(r.parameters.expectedHead,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);break;
  }
}
function billingReview(actualCostMicros:number,evidenceRef:string,reason:string){
  integer(actualCostMicros);text(evidenceRef,/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  text(reason,/^[^\p{Cc}]{1,2000}$/u);
  if(!reason.trim()||/^(?:sk-|hf_|ghp_|ghs_|github_pat_|AKIA|ASIA)/i.test(evidenceRef)||/(?:Bearer\s+\S+|sk-ant-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:hf_|ghp_|ghs_|github_pat_)[A-Za-z0-9_]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(reason))reject('Unsafe billing review');
}
function receiptShape(receipt:ExternalProviderReceipt){
  object(receipt,['ownershipToken','idempotencyKey','evidenceId','outcome','effect','billing'],['resource']);
  text(receipt.evidenceId);object(receipt.billing,['verifiedCostMicros','final']);
  if(receipt.billing.verifiedCostMicros!==null)integer(receipt.billing.verifiedCostMicros);
  if(typeof receipt.billing.final!=='boolean'||receipt.billing.final&&receipt.billing.verifiedCostMicros===null||!['succeeded','failed','unknown'].includes(receipt.outcome)||!['none','retained','resource','unknown'].includes(receipt.effect))reject('Invalid provider receipt');
  if(receipt.resource){object(receipt.resource,['id','cleanupRequired']);text(receipt.resource.id);if(receipt.resource.cleanupRequired!==true)reject('Invalid owned resource');}
}
function updateReservation(a:ExternalAction) {
  const noLiveResource=!a.resource||a.cleanupStatus==='cleaned';
  a.reservedMicros=a.billingFinal&&noLiveResource?0:Math.max(0,a.upperBoundMicros-(a.verifiedCostMicros??0));
}
function taskActions(s:ExternalState,taskId:string):ExternalAction[] {return Object.values(s.actions).filter(a=>s.approvals[a.approvalId]?.taskId===taskId);}
function currentTaskApproval(s:ExternalState,taskId:string):{revision:number;budgetMicros:number} {
  let current={revision:0,budgetMicros:Infinity};
  for(const p of Object.values(s.approvals))if(p.taskId===taskId&&p.revision>current.revision)current={revision:p.revision,budgetMicros:p.budgetMicros};
  return current;
}
function taskCeiling(s:ExternalState,taskId:string):number {return currentTaskApproval(s,taskId).budgetMicros;}
function exposure(actions:ExternalAction[]):number {return actions.reduce((total,a)=>add(total,add(a.verifiedCostMicros??0,a.reservedMicros)),0);}
export const EXTERNAL_STATE_MAX_ITEMS=65536,EXTERNAL_STATE_MAX_BYTES=32*1024*1024;
/** SQL codec integrity does not establish semantic authority. Historical stored pins
 * remain usable for cleanup after registry revocation; new dispatch checks live pins. */
export function validateExternalState(value:unknown):asserts value is ExternalState {
 try {
  const s=value as ExternalState;object(s,['version','approvals','actions']);if(s.version!==1)reject('version');
  for(const records of [s.approvals,s.actions]){
   if(!records||typeof records!=='object'||Array.isArray(records)||Object.keys(records).length>EXTERNAL_STATE_MAX_ITEMS)reject('records');
   object(records,Object.keys(records));
  }
  const revisions=new Map<string,Set<string>>(),revisionBudgets=new Map<string,number>(),latest=new Map<string,number>(),budgets=new Map<string,number>(),costs=new Map<string,number>(),costStops=new Map<string,boolean>();
  for(const [id,p] of Object.entries(s.approvals)){
   object(p,['taskId','revision','profileId','endsAt','budgetMicros','id','profile','profileHash','approvedAt'],['stoppedAt','stopReason']);
   validateApproval({taskId:p.taskId,revision:p.revision,profileId:p.profileId,endsAt:p.endsAt,budgetMicros:p.budgetMicros});integer(p.approvedAt);
   const profile=validateProfile(p.profile);
   if(p.id!==id||id!==approvalId(p)||p.profile.id!==p.profileId||p.profileHash!==hash(profile)||p.endsAt<=p.approvedAt)reject('approval pin');
   if(p.stoppedAt===undefined?p.stopReason!==undefined:!['cancelled','expired','cost_exceeded'].includes(p.stopReason??''))reject('stop');
   if(p.stoppedAt!==undefined){integer(p.stoppedAt);if(p.stoppedAt<p.approvedAt||p.stopReason==='expired'&&p.stoppedAt<p.endsAt)reject('stop time');}
   const key=JSON.stringify([p.taskId,p.revision]),providers=revisions.get(key)??new Set<string>();
   if(providers.has(profile.provider)||providers.size>=4)reject('duplicate provider');providers.add(profile.provider);revisions.set(key,providers);
   if(revisionBudgets.has(key)&&revisionBudgets.get(key)!==p.budgetMicros)reject('revision budget mismatch');revisionBudgets.set(key,p.budgetMicros);
   const prior=latest.get(p.taskId)??0;
   if(p.revision>prior){latest.set(p.taskId,p.revision);budgets.set(p.taskId,p.budgetMicros);costStops.set(p.taskId,p.stopReason==='cost_exceeded');}
   else if(p.revision===prior)costStops.set(p.taskId,costStops.get(p.taskId)===true&&p.stopReason==='cost_exceeded');
  }
  const requests=new Set<string>(),owners=new Set<string>(),resources=new Set<string>();
  for(const [id,a] of Object.entries(s.actions)){
   object(a,['id','approvalId','requestId','operation','parameters','parametersHash','profileHash','ownershipToken','idempotencyKey','createdAt','expiresAt','status','effect','cleanupStatus','upperBoundMicros','reservedMicros','verifiedCostMicros','billingFinal'],['resource','evidenceId','providerReceipt','billingSource','operatorBilling','providerRecoveryCursor']);
   const p=s.approvals[a.approvalId];if(!p||a.id!==id)reject('action approval');
   text(a.id);text(a.requestId);text(a.ownershipToken,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
   validateParameters({taskId:p.taskId,revision:p.revision,profileId:p.profileId,requestId:a.requestId,operation:a.operation,parameters:a.parameters} as ExternalActionRequest,p.profile);
   if(a.parametersHash!==externalParametersHash(p.profile,a.operation,a.parameters)||a.profileHash!==p.profileHash||a.idempotencyKey!==hash([p.id,a.id,a.parametersHash]))reject('action binding');
   const request=JSON.stringify([p.id,a.requestId]);if(requests.has(request)||owners.has(a.ownershipToken))reject('duplicate action ownership');requests.add(request);owners.add(a.ownershipToken);
   integer(a.createdAt);integer(a.expiresAt);integer(a.upperBoundMicros);integer(a.reservedMicros);
   const lifetime=a.operation==='aws.spot.start'?(a.parameters as {lifetimeMs:number}).lifetimeMs:p.profile.maxLifetimeMs;
   if(a.createdAt<p.approvedAt||p.stoppedAt!==undefined&&a.createdAt>p.stoppedAt||a.expiresAt!==Math.min(p.endsAt,add(a.createdAt,lifetime))||a.expiresAt<=a.createdAt||a.upperBoundMicros!==p.profile.upperBoundMicros)reject('action limits');
   if(!['intent','dispatching','ambiguous','succeeded','failed','cancelled'].includes(a.status)||!['none','retained','resource','unknown'].includes(a.effect)||!['none','pending','deleting','cleaned'].includes(a.cleanupStatus)||typeof a.billingFinal!=='boolean')reject('action state');
   if(a.verifiedCostMicros!==null)integer(a.verifiedCostMicros);
   if(a.billingFinal&&a.verifiedCostMicros===null||a.effect==='unknown'&&(a.billingFinal||!['intent','dispatching','ambiguous'].includes(a.status)))reject('billing evidence');
   if(a.resource){
    object(a.resource,['id','cleanupRequired']);text(a.resource.id);
    if(a.resource.cleanupRequired!==true||a.effect!=='resource'||a.operation!=='aws.spot.start'||p.profile.provider!=='aws')reject('resource');
    const key=JSON.stringify([p.profile.target.accountId,p.profile.target.region,a.resource.id]);
    if(resources.has(key))reject('duplicate resource ownership');resources.add(key);
   }
   if((a.effect==='resource')!==!!a.resource||!a.resource&&a.cleanupStatus!=='none')reject('cleanup state');
   if(a.effect==='retained'&&!RETAINED_OPERATIONS.includes(a.operation))reject('retained effect');
   if(['intent','dispatching'].includes(a.status)&&(a.effect!=='unknown'||a.resource||a.evidenceId!==undefined||a.verifiedCostMicros!==null||a.billingFinal))reject('undispatched evidence');
   if(a.status==='cancelled'&&(a.effect!=='none'||a.verifiedCostMicros!==0||!a.billingFinal||a.resource))reject('cancelled evidence');
   if(a.status==='succeeded'&&a.effect!==successEffect(a.operation))reject('success effect');
   if(a.evidenceId!==undefined)text(a.evidenceId);
   if(['succeeded','failed'].includes(a.status)&&a.evidenceId===undefined)reject('missing receipt');
   if(a.providerRecoveryCursor!==undefined){
    if(a.operation!=='github.branch.push'||!['ambiguous','succeeded','failed'].includes(a.status)||a.operatorBilling)reject('Invalid recovery action');
    parseExternalRecoveryCursor(a.providerRecoveryCursor,externalRecoveryBinding({actionId:a.id,taskId:p.taskId,revision:p.revision,profile:p.profile,parametersHash:a.parametersHash,ownershipToken:a.ownershipToken,idempotencyKey:a.idempotencyKey}));
   }
   if(a.operatorBilling){
    const review=a.operatorBilling;object(review,['actualCostMicros','evidenceRef','reason','at']);billingReview(review.actualCostMicros,review.evidenceRef,review.reason);integer(review.at);
    if(review.at<a.createdAt||!['succeeded','failed'].includes(a.status)||a.effect==='unknown'||a.resource&&a.cleanupStatus!=='cleaned'||a.billingSource!=='operator_attested'||!a.billingFinal||a.verifiedCostMicros!==review.actualCostMicros||!a.providerReceipt||a.providerReceipt.billing.final)reject('invalid operator billing');
   }else if(a.billingSource==='operator_attested')reject('operator provenance missing');
   if(a.billingSource!==undefined&&!['operator_attested','provider_verified'].includes(a.billingSource))reject('billing source');
   if(a.providerReceipt){
    const r=a.providerReceipt;receiptShape(r);
    if(r.ownershipToken!==a.ownershipToken||r.idempotencyKey!==a.idempotencyKey||r.evidenceId!==a.evidenceId||r.effect!==a.effect||(r.outcome==='unknown'?'ambiguous':r.outcome)!==a.status||r.resource?.id!==a.resource?.id)reject('provider receipt binding');
    if(!a.operatorBilling&&(a.verifiedCostMicros!==r.billing.verifiedCostMicros||a.billingFinal!==r.billing.final||a.billingSource!==(r.billing.verifiedCostMicros===null?undefined:'provider_verified')))reject('provider billing changed');
   }else if(a.billingSource!==undefined||a.operatorBilling)reject('receipt missing');
   const expected=a.billingFinal&&(!a.resource||a.cleanupStatus==='cleaned')?0:Math.max(0,a.upperBoundMicros-(a.verifiedCostMicros??0));
   if(a.reservedMicros!==expected)reject('reservation total');
   costs.set(p.taskId,add(costs.get(p.taskId)??0,add(a.verifiedCostMicros??0,a.reservedMicros)));
  }
  for(const a of Object.values(s.actions))if(a.operation==='aws.s3.inspect'){
   const parent=s.actions[(a.parameters as {putActionId:string}).putActionId];
   if(!parent||parent.approvalId!==a.approvalId||parent.operation!=='aws.s3.put')reject('inspection ownership');
  }
  for(const a of Object.values(s.actions))if(a.operation==='aws.spot.inspect'){
   const parent=s.actions[(a.parameters as {startActionId:string}).startActionId];
   if(!parent||parent.approvalId!==a.approvalId||parent.operation!=='aws.spot.start'||!parent.resource)reject('inspection ownership');
  }
  for(const [taskId,cost] of costs)if(cost>budgets.get(taskId)!) {
   if(!costStops.get(taskId))reject('task budget');
  }
  if(Buffer.byteLength(JSON.stringify(s),'utf8')>EXTERNAL_STATE_MAX_BYTES)reject('capacity');
 }catch{throw new Error('Invalid external persisted state');}
}
function refresh(s:ExternalState,now:number) {
  for(const p of Object.values(s.approvals)) if(p.stoppedAt===undefined&&now>=p.endsAt){p.stoppedAt=now;p.stopReason='expired';}
  for(const a of Object.values(s.actions)) {
    const p=s.approvals[a.approvalId]!;
    if(a.status==='intent'&&(p.stoppedAt!==undefined||now>=a.expiresAt)) {a.status='cancelled';a.effect='none';a.verifiedCostMicros=0;a.billingFinal=true;updateReservation(a);}
    if(a.resource&&a.cleanupStatus!=='cleaned'&&(p.stoppedAt!==undefined||now>=a.expiresAt))a.cleanupStatus='pending';
  }
}

/** Trusted server library only. Not installed in main/API/runner. */
export class ExternalBroker<Credential=unknown> {
  private readonly options:ExternalBrokerOptions<Credential> & {transport:GuardedExternalProviderTransport<Credential>};
  private readonly dispatches=new Map<string,{taskId:string;revision:number;controller:AbortController}>();
  constructor(options:ExternalBrokerOptions<Credential> & {transport:GuardedExternalProviderTransport<Credential>}){this.options=options;}
  private now():number {const n=(this.options.now??Date.now)();integer(n);return n;}
  private transaction<T>(fn:(s:ExternalState,now:number)=>T):T {
    const now=this.now();
    return this.options.store.transaction(s=>{validateExternalState(s);refresh(s,now);const result=fn(s,now);validateExternalState(s);return copy(result);});
  }
  /** Caller must be the authenticated server approval bridge, never model input. */
  serverApprove(request:ExternalApprovalRequest):ExternalApproval {
    validateApproval(request);
    const profile=validateProfile(this.options.registry.get(request.profileId));
    if(profile.id!==request.profileId)reject('Profile identity mismatch');
    const approval=this.transaction((s,now)=>{
      const id=approvalId(request),prior=s.approvals[id];
      if(prior) {
        const bound={taskId:prior.taskId,revision:prior.revision,profileId:prior.profileId,endsAt:prior.endsAt,budgetMicros:prior.budgetMicros};
        if(hash(bound)!==hash(request)||prior.profileHash!==hash(profile))reject('Approval immutable');
        return prior;
      }
      const peers=Object.values(s.approvals).filter(p=>p.taskId===request.taskId&&p.revision===request.revision);
      if(peers.length>=4||peers.some(p=>p.profile.provider===profile.provider))reject('Approval provider immutable');
      if(request.revision<currentTaskApproval(s,request.taskId).revision)reject('Stale approval revision');
      if(peers.some(p=>p.budgetMicros!==request.budgetMicros))reject('Revision budget immutable');
      if(exposure(taskActions(s,request.taskId))>request.budgetMicros)reject('Task budget already committed');
      if(request.endsAt<=now)reject('Approval expired');
      const p:ExternalApproval={...copy(request),id,profile,profileHash:hash(profile),approvedAt:now};s.approvals[id]=p;return p;
    });
    for(const d of this.dispatches.values())if(d.taskId===request.taskId&&d.revision<approval.revision)d.controller.abort();
    return approval;
  }
  cancel(taskId:string,revision:number,_reason:string):void {
    text(taskId);integer(revision,1);text(_reason,/^[^\p{Cc}]{1,200}$/u);
    this.transaction((s,now)=>{for(const p of Object.values(s.approvals))if(p.taskId===taskId&&p.revision===revision&&p.stoppedAt===undefined){p.stoppedAt=now;p.stopReason='cancelled';}refresh(s,now);});
    for(const d of this.dispatches.values())if(d.taskId===taskId&&d.revision===revision)d.controller.abort();
  }
  /** Startup barrier: call only after the previous broker process has stopped.
   * Persisted dispatches are uncertain, never replayed. Also advances expiry. */
  recover():void {this.transaction(s=>{for(const a of Object.values(s.actions)) {
    if(a.status==='dispatching')a.status='ambiguous';
    else if(a.status==='intent'){a.status='cancelled';a.effect='none';a.verifiedCostMicros=0;a.billingFinal=true;updateReservation(a);}
  }});}
  /** Trusted scheduler/bridge reads; contains no credentials. */
  getAction(id:string):ExternalAction {return this.action(id);}
  listPending():ExternalAction[] {return this.transaction(s=>Object.values(s.actions).filter(a=>
    ['intent','dispatching','ambiguous'].includes(a.status)||!a.billingFinal||['pending','deleting'].includes(a.cleanupStatus)||a.resource&&a.cleanupStatus!=='cleaned'));
  }

  async execute(request:ExternalActionRequest):Promise<ExternalAction> {
    // Validate request shape before computing identity or canonical hashes.
    object(request,['taskId','revision','profileId','requestId','operation','parameters']);
    text(request.taskId);integer(request.revision,1);text(request.profileId);text(request.requestId);
    const reservation=this.transaction((s,now)=>{
      const p=s.approvals[approvalId(request)];if(!p)reject('Server approval required');
      validateParameters(request,p.profile);
      const parametersHash=externalParametersHash(p.profile,request.operation,request.parameters);
      const prior=Object.values(s.actions).find(a=>a.approvalId===p.id&&a.requestId===request.requestId);
      if(prior){if(prior.parametersHash!==parametersHash)reject('Request conflict');return {action:prior,fresh:false};}
      if(p.stoppedAt!==undefined)reject('Approval stopped or expired');
      if(p.revision!==currentTaskApproval(s,p.taskId).revision)reject('Stale execution revision');
      const current=validateProfile(this.options.registry.get(p.profileId));
      if(hash(current)!==p.profileHash)reject('Profile changed since approval');
      const actions=taskActions(s,p.taskId);
      // A new revision cannot escape unresolved prior execution/cleanup/billing.
      if(actions.some(a=>s.approvals[a.approvalId]!.revision!==p.revision&&(!a.billingFinal||a.reservedMicros>0||a.resource&&a.cleanupStatus!=='cleaned'||['intent','dispatching','ambiguous'].includes(a.status))))reject('Prior revision unresolved');
      const own=actions.filter(a=>a.approvalId===p.id);
      if(add(exposure(actions),p.profile.upperBoundMicros)>taskCeiling(s,p.taskId))reject('Task budget ceiling exceeded');
      // Inspections have their own bounded concurrency and still reserve budget.
      // A single allowed live Spot resource must not prevent its read-only inspection.
      const inspection=isInspection(request.operation);
      if(own.filter(a=>isInspection(a.operation)===inspection&&(['intent','dispatching','ambiguous'].includes(a.status)||a.resource&&a.cleanupStatus!=='cleaned')).length>=p.profile.maxActiveActions)reject('Active action ceiling exceeded');
      if(request.operation==='aws.spot.inspect') {
        const parent=s.actions[request.parameters.startActionId];
        if(!parent||parent.approvalId!==p.id||parent.operation!=='aws.spot.start'||!parent.resource||parent.cleanupStatus==='cleaned')reject('Inspect requires owned start action');
      }
      if(request.operation==='aws.s3.inspect') {
        // Inspection can only address an owned, already dispatched put of this approval.
        const parent=s.actions[request.parameters.putActionId];
        if(!parent||parent.approvalId!==p.id||parent.operation!=='aws.s3.put'||parent.status==='intent'||parent.status==='cancelled')reject('Inspect requires owned put action');
      }
      const id=randomUUID(),ownershipToken=randomUUID();
      const lifetime=request.operation==='aws.spot.start'?request.parameters.lifetimeMs:p.profile.maxLifetimeMs;
      const a:ExternalAction={id,approvalId:p.id,requestId:request.requestId,operation:request.operation,parameters:copy(request.parameters),parametersHash,profileHash:p.profileHash,ownershipToken,idempotencyKey:hash([p.id,id,parametersHash]),createdAt:now,expiresAt:Math.min(p.endsAt,add(now,lifetime)),status:'intent',effect:'unknown',cleanupStatus:'none',upperBoundMicros:p.profile.upperBoundMicros,reservedMicros:p.profile.upperBoundMicros,verifiedCostMicros:null,billingFinal:false};
      s.actions[id]=a;return {action:a,fresh:true};
    });
    if(!reservation.fresh)return reservation.action;
    const id=reservation.action.id;
    const canDispatch=this.transaction((s,now)=>{
      const a=s.actions[id]!,p=s.approvals[a.approvalId]!;
      if(a.status!=='intent'||p.stoppedAt!==undefined||now>=a.expiresAt||p.revision!==currentTaskApproval(s,p.taskId).revision)return false;
      if(hash(validateProfile(this.options.registry.get(p.profileId)))!==p.profileHash)reject('Profile changed before dispatch');
      a.status='dispatching';return true;
    });
    if(!canDispatch)return this.action(id);
    const controller=new AbortController();
    this.dispatches.set(id,{taskId:request.taskId,revision:request.revision,controller});
    const authority:ExternalDispatchAuthority={signal:controller.signal,assertActive:()=>{
      if(controller.signal.aborted)reject('Dispatch cancelled');
      this.transaction((s,now)=>{
        const a=s.actions[id]!,p=s.approvals[a.approvalId]!;
        if(a.status!=='dispatching'||p.stoppedAt!==undefined||now>=a.expiresAt||p.revision!==currentTaskApproval(s,p.taskId).revision)reject('Dispatch cancelled, expired or stale');
        if(hash(validateProfile(this.options.registry.get(p.profileId)))!==p.profileHash||a.profileHash!==p.profileHash||a.parametersHash!==externalParametersHash(p.profile,a.operation,a.parameters))reject('Dispatch binding changed');
      });
    }};
    try {
      const receipt=await this.withCredential(id,'execute',async(inv,credential)=>{
        // Resolver may await credential issuance. Recheck cancellation immediately
        // before transport invocation; no side effect has happened on this path yet.
        const allowed=this.transaction((s,now)=>{
          const a=s.actions[id]!,p=s.approvals[a.approvalId]!;
          if(p.stoppedAt!==undefined||now>=a.expiresAt||p.revision!==currentTaskApproval(s,p.taskId).revision){a.status='cancelled';a.effect='none';a.verifiedCostMicros=0;a.billingFinal=true;updateReservation(a);return false;}
          if(hash(validateProfile(this.options.registry.get(p.profileId)))!==p.profileHash)reject('Profile changed before provider call');
          return true;
        });
        return allowed?this.options.transport.execute(inv,credential,authority):null;
      });
      if(receipt)this.accept(id,receipt);
    }catch {this.ambiguous(id);}finally{this.dispatches.delete(id);}
    return this.action(id);
  }
  private action(id:string):ExternalAction {return this.transaction(s=>s.actions[id]??reject('Action not found'));}
  private ambiguous(id:string) {this.transaction(s=>{const a=s.actions[id]!;if(a.status==='dispatching')a.status='ambiguous';});}
  private async withCredential<T>(id:string,purpose:ExternalCredentialScope['purpose'],consume:(inv:ExternalInvocation,credential:Credential)=>Promise<T>):Promise<T> {
    const inv=this.transaction(s=>{
      const a=s.actions[id]??reject('Action not found'),p=s.approvals[a.approvalId]!;
      // A previously attested start resource remains available after EC2 drops
      // terminated instances from inventory; it is not new model-supplied authority.
      const parent=a.operation==='aws.spot.inspect'?s.actions[(a.parameters as {startActionId:string}).startActionId]:a.operation==='aws.spot.start'?a:undefined;
      return {actionId:a.id,taskId:p.taskId,revision:p.revision,profile:p.profile,operation:a.operation,parameters:a.parameters,parametersHash:a.parametersHash,ownershipToken:a.ownershipToken,idempotencyKey:a.idempotencyKey,expiresAt:a.expiresAt,...(purpose==='inspect'&&a.providerRecoveryCursor!==undefined?{providerRecoveryCursor:a.providerRecoveryCursor}:{}),...(a.operation==='aws.s3.inspect'&&s.actions[(a.parameters as {putActionId:string}).putActionId]?.operation==='aws.s3.put'?{ownedPut:(put=>({actionId:put.id,ownershipToken:put.ownershipToken,idempotencyKey:put.idempotencyKey,parametersHash:put.parametersHash,parameters:put.parameters as ExternalS3Parameters}))(s.actions[(a.parameters as {putActionId:string}).putActionId]!)}:{}),...(parent?.resource?{ownedResource:{...parent.resource,actionId:parent.id,ownershipToken:parent.ownershipToken,idempotencyKey:parent.idempotencyKey}}:{})} satisfies ExternalInvocation;
    });
    const scope:ExternalCredentialScope={taskId:inv.taskId,revision:inv.revision,actionId:id,provider:inv.profile.provider,target:copy(inv.profile.target),operation:inv.operation,purpose,expiresAt:inv.expiresAt};
    return this.options.resolver.withCredential(inv.profile.credentialRef,scope,credential=>consume(copy(inv),credential));
  }
  private accept(id:string,receipt:ExternalProviderReceipt):void {
    receiptShape(receipt);
    this.transaction((s,now)=>{
      const a=s.actions[id]!,p=s.approvals[a.approvalId]!;
      if(a.operatorBilling)throw Object.assign(new Error('Operator billing already attested'),{statusCode:409});
      if(receipt.ownershipToken!==a.ownershipToken||receipt.idempotencyKey!==a.idempotencyKey)reject('Provider ownership mismatch');
      if(receipt.effect==='unknown'&&(receipt.outcome!=='unknown'||receipt.billing.final))reject('Unknown provider effect');
      if(receipt.outcome==='succeeded'&&receipt.effect!==successEffect(a.operation))reject('Successful provider effect missing');
      if(receipt.effect==='resource'?!receipt.resource:receipt.resource!==undefined)reject('Resource receipt mismatch');
      if(receipt.effect==='resource'&&a.operation!=='aws.spot.start'||receipt.effect==='retained'&&!RETAINED_OPERATIONS.includes(a.operation))reject('Provider operation effect mismatch');
      if(a.resource&&receipt.resource?.id!==a.resource.id)reject('Resource identity changed');
      if(a.effect!=='unknown'&&a.effect!==receipt.effect)reject('Provider effect changed');
      if(a.billingFinal&&(receipt.billing.verifiedCostMicros!==a.verifiedCostMicros||!receipt.billing.final)||a.verifiedCostMicros!==null&&(receipt.billing.verifiedCostMicros===null||receipt.billing.verifiedCostMicros<a.verifiedCostMicros))reject('Billing evidence regressed');
      if(receipt.outcome==='unknown'&&receipt.billing.final)reject('Unknown execution cannot finalize billing');
      delete a.providerRecoveryCursor;
      a.status=receipt.outcome==='unknown'?'ambiguous':receipt.outcome;a.effect=receipt.effect;a.evidenceId=receipt.evidenceId;
      if(receipt.resource){a.resource=copy(receipt.resource);if(a.cleanupStatus!=='cleaned')a.cleanupStatus=p.stoppedAt!==undefined||now>=a.expiresAt?'pending':'none';}
      a.verifiedCostMicros=receipt.billing.verifiedCostMicros;a.billingFinal=receipt.billing.final;updateReservation(a);
      a.providerReceipt={ownershipToken:receipt.ownershipToken,idempotencyKey:receipt.idempotencyKey,evidenceId:receipt.evidenceId,outcome:receipt.outcome,effect:receipt.effect,billing:copy(receipt.billing),...(receipt.resource?{resource:copy(receipt.resource)}:{})};
      if(receipt.billing.verifiedCostMicros!==null)a.billingSource='provider_verified';else delete a.billingSource;
      if(a.verifiedCostMicros!==null&&a.verifiedCostMicros>a.upperBoundMicros)for(const approval of Object.values(s.approvals))if(approval.taskId===p.taskId){approval.stoppedAt??=now;approval.stopReason='cost_exceeded';}
      refresh(s,now);
    });
  }
  /** Read-only recovery. Never resends execute, even with provider idempotency. */
  async reconcile(id:string):Promise<ExternalAction> {
    const a=this.action(id);
    if(a.status==='intent'||a.status==='dispatching'||a.status==='cancelled'||a.operatorBilling)return a;
    try {const observation=await this.withCredential(id,'inspect',(inv,c)=>this.options.transport.inspect(inv,c));
      if(observation&&'state' in observation){
        object(observation,['state','cursor']);if(observation.state!=='pending')reject('Invalid observation');
        this.transaction(s=>{const current=s.actions[id]!,p=s.approvals[current.approvalId]!;
          // Concurrent ticks must not rewind progress or replace newly accepted evidence.
          if(current.providerRecoveryCursor!==a.providerRecoveryCursor||current.status!==a.status||current.evidenceId!==a.evidenceId||current.operatorBilling)return;
          if(current.operation!=='github.branch.push')reject('Invalid recovery operation');
          if(observation.cursor===null)delete current.providerRecoveryCursor;
          else{parseExternalRecoveryCursor(observation.cursor,externalRecoveryBinding({actionId:current.id,taskId:p.taskId,revision:p.revision,profile:p.profile,parametersHash:current.parametersHash,ownershipToken:current.ownershipToken,idempotencyKey:current.idempotencyKey}));current.providerRecoveryCursor=observation.cursor;}
        });
      }else if(observation)this.accept(id,observation);
    }catch {/* Unresolved billing/execution remains reserved. */}
    return this.action(id);
  }
  /** Authenticated server/operator bridge only. Never a worker/model operation.
   * Attests the complete invoice amount; does not prove execution or resource absence. */
  serverAttestBilling(actionId:string,actualCostMicros:number,evidenceRef:string,reason:string):ExternalAction {
    text(actionId);billingReview(actualCostMicros,evidenceRef,reason);
    const conflict=():never=>{throw Object.assign(new Error('Billing review conflict'),{statusCode:409});};
    return this.transaction((s,now)=>{
      const a=s.actions[actionId]??reject('Action not found');
      if(a.operatorBilling){const prior=a.operatorBilling;if(prior.actualCostMicros!==actualCostMicros||prior.evidenceRef!==evidenceRef||prior.reason!==reason)conflict();return a;}
      if(a.billingFinal||!['succeeded','failed'].includes(a.status)||a.effect==='unknown'||a.resource&&a.cleanupStatus!=='cleaned')conflict();
      // Legacy known-outcome rows already contain this accepted receipt projection.
      a.providerReceipt??={ownershipToken:a.ownershipToken,idempotencyKey:a.idempotencyKey,evidenceId:a.evidenceId!,outcome:a.status as 'succeeded'|'failed',effect:a.effect,...(a.resource?{resource:copy(a.resource)}:{}),billing:{verifiedCostMicros:a.verifiedCostMicros,final:a.billingFinal}};
      delete a.providerRecoveryCursor;
      a.operatorBilling={actualCostMicros,evidenceRef,reason,at:now};a.billingSource='operator_attested';a.verifiedCostMicros=actualCostMicros;a.billingFinal=true;updateReservation(a);
      const p=s.approvals[a.approvalId]!;
      if(actualCostMicros>a.upperBoundMicros||exposure(taskActions(s,p.taskId))>taskCeiling(s,p.taskId))for(const approval of Object.values(s.approvals))if(approval.taskId===p.taskId){approval.stoppedAt??=now;approval.stopReason='cost_exceeded';}
      refresh(s,now);return a;
    });
  }
  async cleanup(id:string):Promise<ExternalAction> {
    const start=this.transaction(s=>{
      const a=s.actions[id]??reject('Action not found');
      if(!a.resource||!['pending','deleting'].includes(a.cleanupStatus))return false;
      a.cleanupStatus='deleting';return true;
    });
    if(!start)return this.action(id);
    const resource=this.action(id).resource!;
    try {
      const absent=await this.withCredential(id,'cleanup',async(inv,c)=>{
        if(await this.options.transport.confirmAbsent(inv,copy(resource),c))return true;
        await this.options.transport.cleanup(inv,copy(resource),c);
        return this.options.transport.confirmAbsent(inv,copy(resource),c);
      });
      this.transaction(s=>{const a=s.actions[id]!;if(a.resource?.id!==resource.id)reject('Cleanup identity conflict');if(a.cleanupStatus!=='cleaned')a.cleanupStatus=absent?'cleaned':'pending';updateReservation(a);});
    }catch {this.transaction(s=>{const a=s.actions[id]!;if(a.cleanupStatus!=='cleaned')a.cleanupStatus='pending';});}
    return this.action(id);
  }
}
