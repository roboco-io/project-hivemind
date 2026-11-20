import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {autonomousRecordJsonMetadata,iterateAutonomousRecordJson,createAutonomousRecordDecoder} from './autonomous-repository.ts';
import type {ExternalState,ExternalTransactionalStore,ExternalActionRequest} from '../../contracts/src/autonomous-external.js';
import type {AutonomousActionRequest} from '../../contracts/src/autonomous.js';
export interface ExternalJournal {
 taskId:string;revision:number;requestId:string;requestHash:string;mainRequestId:string;
 phase:'intent'|'reserved'|'broker'|'settled'|'cleaned';
 request?:ExternalActionRequest;reservation?:Omit<AutonomousActionRequest,'requestId'>;undispatched?:true;dispatchBlocked?:true;recoveryIssue?:'historical_policy_missing'|'historical_credential_unavailable';retryAt?:number;retryAttempts?:number;sequence?:number;mainReservationId?:string;brokerActionId?:string;resourceId?:string;
}
export interface ExternalJournalQuery {limit?:number;cursor?:string}
export interface ExternalApprovalPreflight {profileHashes:Record<string,string>;configurationFingerprint:string}
export interface ExternalArtifactGrant {taskId:string;revision:number;profileId:string;artifactDigest:string;profileHash:string;configurationFingerprint:string;bytes:number;published?:boolean}
/** Server-side admission of one large manifest for one approved profile. Mirrors ExternalArtifactGrant. */
export interface ExternalManifestGrant {taskId:string;revision:number;profileId:string;manifestDigest:string;profileHash:string;configurationFingerprint:string;files:number;bytes:number;published?:boolean}
export const EXTERNAL_MANIFEST_GRANT_LIMITS={perRevision:8,filesPerRevision:256,bytesPerRevision:512*1024*1024*1024} as const;
export interface ExternalDurableStore extends ExternalTransactionalStore {
 getArtifactGrant(taskId:string,revision:number,profileId:string,artifactDigest:string):ExternalArtifactGrant|undefined;
 reserveArtifactGrant(grant:ExternalArtifactGrant):void;
 bindArtifactGrant(grant:ExternalArtifactGrant):void;
 getManifestGrant(taskId:string,revision:number,profileId:string,manifestDigest:string):ExternalManifestGrant|undefined;
 reserveManifestGrant(grant:ExternalManifestGrant):void;
 bindManifestGrant(grant:ExternalManifestGrant):void;
 getProviderPolicy(taskId:string,revision:number,profileId:string):unknown;
 bindProviderPolicy(taskId:string,revision:number,profileId:string,value:unknown):void;
 pageJournal(taskId:string,query:ExternalJournalQuery):{items:ExternalJournal[];nextCursor?:string};
 approvalFingerprint(taskId:string,revision:number,profileId:string):string|undefined;
 bindApprovalFingerprint(taskId:string,revision:number,profileId:string,fingerprint:string):void;
 approvalPreflight(taskId:string,revision:number):ExternalApprovalPreflight|undefined;
 bindApprovalPreflight(taskId:string,revision:number,preflight:ExternalApprovalPreflight):void;
 getJournal(taskId:string,revision:number,requestId:string):ExternalJournal|undefined;
 putJournal(entry:ExternalJournal):void;
 listJournal(taskId?:string):ExternalJournal[];
 blockTask(taskId:string,revision:number):void;
 isTaskBlocked(taskId:string,revision:number):boolean;
 close():void;
}
interface Root {version:1;broker:ExternalState;journal:Record<string,ExternalJournal>;blocked:Record<string,true>;secret?:string;nextSequence?:number;bindings?:Record<string,string>;preflights?:Record<string,ExternalApprovalPreflight>;providerPolicies?:Record<string,unknown>;artifactGrants?:Record<string,ExternalArtifactGrant>;manifestGrants?:Record<string,ExternalManifestGrant>}
const key=(values:unknown[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
function badPage():never{throw Object.assign(new Error('Invalid external page'),{statusCode:400});}
function invalid():never{throw new Error('Invalid external persisted state');}
function plain(value:unknown):asserts value is Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();}
function fields(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any>{plain(value);if(Object.getOwnPropertySymbols(value).length||Object.entries(Object.getOwnPropertyDescriptors(value)).some(([k,d])=>!required.includes(k)&&!optional.includes(k)||!d.enumerable||!('value'in d))||required.some(k=>!Object.hasOwn(value,k)))invalid();}
function stable(value:unknown):string{return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);}
const fingerprint=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
function intent(j:ExternalJournal){
 if(j.request!==undefined){
  const r=j.request;fields(r,['taskId','revision','profileId','requestId','operation','parameters']);if(r.taskId!==j.taskId||r.revision!==j.revision||r.requestId!==j.requestId||typeof r.profileId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.profileId)||fingerprint(r)!==j.requestHash||j.mainRequestId!=='external:'+j.requestHash)invalid();
  switch(r.operation){
   case 'aws.spot.start':fields(r.parameters,['lifetimeMs']);if(!Number.isSafeInteger(r.parameters.lifetimeMs)||r.parameters.lifetimeMs<1)invalid();break;
   case 'aws.spot.inspect':fields(r.parameters,['startActionId']);if(typeof r.parameters.startActionId!=='string'||r.parameters.startActionId.length<1||r.parameters.startActionId.length>256)invalid();break;
   case 'hf.model.commit':fields(r.parameters,['artifactDigest','message']);if(typeof r.parameters.artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.parameters.artifactDigest)||typeof r.parameters.message!=='string'||!r.parameters.message.length||r.parameters.message.length>200||/[\p{Cc}]/u.test(r.parameters.message))invalid();break;
   case 'hf.model.lfs_commit':fields(r.parameters,['manifestDigest','message']);if(typeof r.parameters.manifestDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.parameters.manifestDigest)||typeof r.parameters.message!=='string'||!r.parameters.message.length||r.parameters.message.length>200||/[\p{Cc}]/u.test(r.parameters.message))invalid();break;
   case 'aws.s3.put':fields(r.parameters,['keySuffix','artifactDigest']);if(typeof r.parameters.keySuffix!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$/.test(r.parameters.keySuffix)||r.parameters.keySuffix.includes('..')||r.parameters.keySuffix.includes('//')||r.parameters.keySuffix.includes('/./')||r.parameters.keySuffix.endsWith('/')||typeof r.parameters.artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.parameters.artifactDigest))invalid();break;
   case 'aws.s3.inspect':fields(r.parameters,['putActionId']);if(typeof r.parameters.putActionId!=='string'||r.parameters.putActionId.length<1||r.parameters.putActionId.length>256)invalid();break;
   case 'github.branch.push':fields(r.parameters,['artifactDigest','expectedHead']);if(typeof r.parameters.artifactDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.parameters.artifactDigest)||typeof r.parameters.expectedHead!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.parameters.expectedHead))invalid();break;
   default:invalid();
  }
 }
 if(j.reservation!==undefined){const r=j.reservation;fields(r,['tool','system','operation','estimatedCostMicros']);const allowed:Record<string,string[]>={aws:['aws.spot.start','aws.spot.inspect'],hf:['hf.model.commit','hf.model.lfs_commit'],github:['github.branch.push'],s3:['aws.s3.put','aws.s3.inspect']};if(r.tool!=='mcp__hivemind__action'||!allowed[r.system]?.includes(r.operation)||!Number.isSafeInteger(r.estimatedCostMicros)||r.estimatedCostMicros<0||j.request&&r.operation!==j.request.operation)invalid();}
}
function providerPolicy(value:unknown){
 fields(value,['version','profileHash','configurationFingerprint','config'],['costSettings','injectedCostReader']);if(value.version!==1||typeof value.profileHash!=='string'||!/^[a-f0-9]{64}$/.test(value.profileHash)||typeof value.configurationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.configurationFingerprint))invalid();
 fields(value.config,['version','profiles','providers'],['ttlGuard','credentialPolicyRevision']);if(value.config.version!==1||!Array.isArray(value.config.profiles)||value.config.profiles.length<1||value.config.profiles.length>4)invalid();
 if(value.injectedCostReader!==undefined&&typeof value.injectedCostReader!=='boolean')invalid();
}
function artifactGrant(g:unknown):asserts g is ExternalArtifactGrant {
 fields(g,['taskId','revision','profileId','artifactDigest','profileHash','configurationFingerprint','bytes'],['published']);
 if(!Number.isSafeInteger(g.bytes)||g.bytes<0||g.bytes>1024*1024||g.published!==undefined&&typeof g.published!=='boolean')invalid();
 if(typeof g.taskId!=='string'||!g.taskId||typeof g.profileId!=='string'||!g.profileId||!Number.isSafeInteger(g.revision)||g.revision<1||[g.artifactDigest,g.profileHash,g.configurationFingerprint].some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))invalid();
}
function manifestGrant(g:unknown):asserts g is ExternalManifestGrant {
 fields(g,['taskId','revision','profileId','manifestDigest','profileHash','configurationFingerprint','files','bytes'],['published']);
 if(!Number.isSafeInteger(g.files)||g.files<1||g.files>EXTERNAL_MANIFEST_GRANT_LIMITS.filesPerRevision||!Number.isSafeInteger(g.bytes)||g.bytes<1||g.bytes>EXTERNAL_MANIFEST_GRANT_LIMITS.bytesPerRevision||g.published!==undefined&&typeof g.published!=='boolean')invalid();
 if(typeof g.taskId!=='string'||!g.taskId||typeof g.profileId!=='string'||!g.profileId||!Number.isSafeInteger(g.revision)||g.revision<1||[g.manifestDigest,g.profileHash,g.configurationFingerprint].some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))invalid();
}
function validate(root:Root){
 if(root.manifestGrants!==undefined){plain(root.manifestGrants);for(const [id,g] of Object.entries(root.manifestGrants)){manifestGrant(g);if(id!==key(['manifest',g.taskId,g.revision,g.profileId,g.manifestDigest]))invalid();}}
 if(root.artifactGrants!==undefined){plain(root.artifactGrants);for(const [id,g] of Object.entries(root.artifactGrants)){artifactGrant(g);if(id!==key([g.taskId,g.revision,g.profileId,g.artifactDigest]))invalid();}}

 if(root?.version!==1||root.broker?.version!==1||Object.keys(root).some(k=>!['version','broker','journal','blocked','secret','nextSequence','bindings','preflights','providerPolicies','artifactGrants','manifestGrants'].includes(k))||Object.keys(root.broker).some(k=>!['version','approvals','actions'].includes(k)))invalid();
 if(root.secret!==undefined&&(typeof root.secret!=='string'||!/^[a-f0-9]{64}$/.test(root.secret)))invalid();
 if(root.nextSequence!==undefined&&(!Number.isSafeInteger(root.nextSequence)||root.nextSequence<1))invalid();
 for(const value of Object.values(root.bindings??{}))if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))invalid();
 for(const p of Object.values(root.preflights??{})){if(!p||typeof p.configurationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationFingerprint)||!p.profileHashes||Object.keys(p.profileHashes).length<1||Object.keys(p.profileHashes).length>4||Object.values(p.profileHashes).some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))invalid();}
 if(root.providerPolicies!==undefined){plain(root.providerPolicies);for(const value of Object.values(root.providerPolicies))providerPolicy(value);}
 for(const value of [root.broker.approvals,root.broker.actions,root.journal,root.blocked])if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>131074)invalid();
 for(const [id,j] of Object.entries(root.journal)){
  plain(j);intent(j);
  if(j?.undispatched!==undefined&&(j.undispatched!==true||j.dispatchBlocked!==true||!j.request||!j.reservation||j.brokerActionId!==undefined||j.resourceId!==undefined))invalid();
  if(j?.recoveryIssue!==undefined&&!['historical_policy_missing','historical_credential_unavailable'].includes(j.recoveryIssue))invalid();
  if(j?.dispatchBlocked!==undefined&&j.dispatchBlocked!==true)invalid();
  if(j?.retryAt!==undefined&&(!Number.isSafeInteger(j.retryAt)||j.retryAt<0)||j?.retryAttempts!==undefined&&(!Number.isSafeInteger(j.retryAttempts)||j.retryAttempts<0))invalid();
  if(!j||Object.keys(j).some(k=>!['taskId','revision','requestId','requestHash','mainRequestId','phase','request','reservation','undispatched','recoveryIssue','dispatchBlocked','retryAt','retryAttempts','sequence','mainReservationId','brokerActionId','resourceId'].includes(k))||typeof j.taskId!=='string'||!Number.isSafeInteger(j.revision)||j.revision<1||typeof j.requestId!=='string'||typeof j.mainRequestId!=='string'||!/^[a-f0-9]{64}$/.test(j.requestHash)||!['intent','reserved','broker','settled','cleaned'].includes(j.phase)||id!==key([j.taskId,j.revision,j.requestId]))invalid();
 }
 if(Object.values(root.blocked).some(v=>v!==true))invalid();
}
/** Cloudflare storage.sql + storage.transactionSync, or a local SQLite adapter. */
export interface ExternalSqlPort {
 exec(query:string,...bindings:(string|number|null)[]):Iterable<Record<string,unknown>>;
 transactionSync<T>(fn:()=>T):T;
 close?():void;
}
export function createExternalSqlStore(sql:ExternalSqlPort):ExternalDurableStore {
 sql.exec('CREATE TABLE IF NOT EXISTS external_manifest(id INTEGER PRIMARY KEY CHECK(id=1),digest TEXT NOT NULL,bytes INTEGER NOT NULL,chunks INTEGER NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS external_chunks(ordinal INTEGER PRIMARY KEY,data TEXT NOT NULL)');
 let closed=false;
 function update<T>(fn:(root:Root)=>T):T {
  if(closed)throw new Error('External store is closed');
  return sql.transactionSync(()=>{
   const m=[...sql.exec('SELECT digest,bytes,chunks FROM external_manifest WHERE id=1')][0];
   let root:Root={version:1,broker:{version:1,approvals:{},actions:{}},journal:{},blocked:{}};
   if(m){
    if(!Number.isSafeInteger(m.bytes)||Number(m.bytes)<1||Number(m.bytes)>32*1024*1024||!Number.isSafeInteger(m.chunks)||Number(m.chunks)<1||Number(m.chunks)>342)invalid();
    const decoder=createAutonomousRecordDecoder({bytes:Number(m.bytes),digest:String(m.digest),chunks:Number(m.chunks)});let expected=0;
    for(const row of sql.exec('SELECT ordinal,data FROM external_chunks ORDER BY ordinal')){if(row.ordinal!==expected++)invalid();decoder.push(String(row.data));}
    root=decoder.finish() as Root;
   }
   if(!m&&[...sql.exec('SELECT ordinal FROM external_chunks LIMIT 1')].length)invalid();
   validate(root);
   root.secret??=randomBytes(32).toString('hex');root.nextSequence??=1;root.bindings??={};root.preflights??={};root.providerPolicies??={};root.artifactGrants??={};root.manifestGrants??={};
   for(const j of Object.values(root.journal))j.sequence??=root.nextSequence++;
   validate(root);const result=fn(root);
   if(result&&typeof (result as {then?:unknown}).then==='function'){
    void Promise.resolve(result).catch(()=>undefined);throw new Error('External transactions require synchronous callbacks');
   }
   validate(root);const json=JSON.stringify(root),meta=autonomousRecordJsonMetadata(json),output=structuredClone(result);
   if(m&&m.digest===meta.digest&&m.bytes===meta.bytes&&m.chunks===meta.chunks)return output;
   sql.exec('DELETE FROM external_chunks');const iterator=iterateAutonomousRecordJson(json);let part=iterator.next(),count=0;while(!part.done){sql.exec('INSERT INTO external_chunks VALUES(?,?)',count++,part.value);part=iterator.next();}
   if(count!==meta.chunks||part.value.bytes!==meta.bytes||part.value.chunks!==meta.chunks||part.value.digest!==meta.digest)invalid();
   sql.exec('INSERT INTO external_manifest VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,bytes=excluded.bytes,chunks=excluded.chunks',meta.digest,meta.bytes,meta.chunks);
   return output;
  });
 }
 return {
  transaction:fn=>update(root=>fn(root.broker)),
  getArtifactGrant:(taskId,revision,profileId,artifactDigest)=>update(root=>root.artifactGrants![key([taskId,revision,profileId,artifactDigest])]),
  reserveArtifactGrant:grant=>update(root=>{
   artifactGrant(grant);if(root.blocked[key([grant.taskId,grant.revision])])throw Error('External artifact admission stopped');
   const id=key([grant.taskId,grant.revision,grant.profileId,grant.artifactDigest]),prior=root.artifactGrants![id];
   if(prior){if(fingerprint({...prior,published:false})!==fingerprint({...grant,published:false}))throw Error('External artifact grant conflict');return;}
   const all=Object.values(root.artifactGrants!).filter(g=>g.taskId===grant.taskId&&g.revision===grant.revision);
   if(all.length>=32||all.reduce((sum,g)=>sum+g.bytes,0)+grant.bytes>32*1024*1024)throw Error('External artifact quota exceeded');
   root.artifactGrants![id]={...structuredClone(grant),published:false};
  }),
  bindArtifactGrant:grant=>update(root=>{
   artifactGrant(grant);if(root.blocked[key([grant.taskId,grant.revision])])throw Error('External artifact admission stopped');
   const id=key([grant.taskId,grant.revision,grant.profileId,grant.artifactDigest]),prior=root.artifactGrants![id];
   if(!prior||fingerprint({...prior,published:false})!==fingerprint({...grant,published:false}))throw Error('External artifact grant conflict');
   root.artifactGrants![id]={...prior,published:true};
  }),
  getManifestGrant:(taskId,revision,profileId,manifestDigest)=>update(root=>root.manifestGrants![key(['manifest',taskId,revision,profileId,manifestDigest])]),
  reserveManifestGrant:grant=>update(root=>{
   manifestGrant(grant);if(root.blocked[key([grant.taskId,grant.revision])])throw Error('External manifest admission stopped');
   const id=key(['manifest',grant.taskId,grant.revision,grant.profileId,grant.manifestDigest]),prior=root.manifestGrants![id];
   if(prior){if(fingerprint({...prior,published:false})!==fingerprint({...grant,published:false}))throw Error('External manifest grant conflict');return;}
   const all=Object.values(root.manifestGrants!).filter(g=>g.taskId===grant.taskId&&g.revision===grant.revision);
   if(all.length>=EXTERNAL_MANIFEST_GRANT_LIMITS.perRevision||all.reduce((sum,g)=>sum+g.files,0)+grant.files>EXTERNAL_MANIFEST_GRANT_LIMITS.filesPerRevision||all.reduce((sum,g)=>sum+g.bytes,0)+grant.bytes>EXTERNAL_MANIFEST_GRANT_LIMITS.bytesPerRevision)throw Error('External manifest quota exceeded');
   root.manifestGrants![id]={...structuredClone(grant),published:false};
  }),
  bindManifestGrant:grant=>update(root=>{
   manifestGrant(grant);if(root.blocked[key([grant.taskId,grant.revision])])throw Error('External manifest admission stopped');
   const id=key(['manifest',grant.taskId,grant.revision,grant.profileId,grant.manifestDigest]),prior=root.manifestGrants![id];
   if(!prior||fingerprint({...prior,published:false})!==fingerprint({...grant,published:false}))throw Error('External manifest grant conflict');
   root.manifestGrants![id]={...prior,published:true};
  }),
  getJournal:(taskId,revision,requestId)=>update(root=>root.journal[key([taskId,revision,requestId])]),
  getProviderPolicy:(taskId,revision,profileId)=>update(root=>root.providerPolicies![key([taskId,revision,profileId])]),
  bindProviderPolicy:(taskId,revision,profileId,value)=>update(root=>{providerPolicy(value);const id=key([taskId,revision,profileId]),prior=root.providerPolicies![id];if(prior!==undefined&&fingerprint(prior)!==fingerprint(value))throw Error('External historical policy is immutable');root.providerPolicies![id]=structuredClone(value);}),
  putJournal:entry=>update(root=>{
   if(entry.dispatchBlocked!==undefined&&entry.dispatchBlocked!==true||entry.undispatched!==undefined&&entry.undispatched!==true)invalid();
   const id=key([entry.taskId,entry.revision,entry.requestId]),prior=root.journal[id];
   if(prior&&(prior.requestHash!==entry.requestHash||prior.mainRequestId!==entry.mainRequestId||prior.mainReservationId&&entry.mainReservationId!==undefined&&entry.mainReservationId!==prior.mainReservationId||prior.brokerActionId&&entry.brokerActionId!==undefined&&entry.brokerActionId!==prior.brokerActionId))throw new Error('External journal identity conflict');
   if(prior?.request!==undefined&&entry.request!==undefined&&fingerprint(prior.request)!==fingerprint(entry.request)||prior?.reservation!==undefined&&entry.reservation!==undefined&&fingerprint(prior.reservation)!==fingerprint(entry.reservation))throw Error('External journal tuple conflict');
   const phases=['intent','reserved','broker','settled','cleaned'];
   const next={...prior,...structuredClone(entry),sequence:prior?.sequence??root.nextSequence!++};
   for(const field of ['request','reservation','mainReservationId','brokerActionId','resourceId'] as const)if(prior?.[field]!==undefined&&next[field]===undefined)Object.assign(next,{[field]:prior[field]});
   if(prior?.undispatched===true)next.undispatched=true;
   if(prior?.dispatchBlocked===true)next.dispatchBlocked=true;
   if(prior&&phases.indexOf(prior.phase)>phases.indexOf(entry.phase))next.phase=prior.phase;
   root.journal[id]=next;
  }),
  approvalFingerprint:(taskId,revision,profileId)=>update(root=>root.bindings![key([taskId,revision,profileId])]),
  bindApprovalFingerprint:(taskId,revision,profileId,fingerprint)=>update(root=>{
   if(!/^[a-f0-9]{64}$/.test(fingerprint))invalid();const id=key([taskId,revision,profileId]),prior=root.bindings![id];if(prior&&prior!==fingerprint)throw Error('External approval configuration changed');root.bindings![id]=fingerprint;
  }),
  approvalPreflight:(taskId,revision)=>update(root=>root.preflights![key([taskId,revision])]),
  bindApprovalPreflight:(taskId,revision,value)=>update(root=>{
   const id=key([taskId,revision]),prior=root.preflights![id];
   if(prior&&JSON.stringify(prior)!==JSON.stringify(value))throw Error('External approval preflight changed');root.preflights![id]=structuredClone(value);
  }),
  pageJournal:(taskId,query)=>update(root=>{
   if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!['limit','cursor'].includes(k)))badPage();
   const limit=query.limit===undefined?20:query.limit;if(!Number.isSafeInteger(limit)||limit<1||limit>100)badPage();
   const entries=Object.values(root.journal).filter(j=>j.taskId===taskId).sort((a,b)=>a.sequence!-b.sequence!);let high=entries.at(-1)?.sequence??0,last=0;
   const sign=(body:string)=>createHmac('sha256',root.secret!).update(body).digest('hex');
   if(query.cursor!==undefined){
    if(typeof query.cursor!=='string'||query.cursor.length>1024)badPage();const [body,mac,...rest]=query.cursor.split('.');if(!body||!mac||rest.length||!/^[a-f0-9]{64}$/.test(mac))badPage();
    const bytes=Buffer.from(body,'base64url');if(bytes.toString('base64url')!==body||!timingSafeEqual(Buffer.from(sign(body),'hex'),Buffer.from(mac,'hex')))badPage();
    const parsed=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(parsed)||parsed.length!==4||parsed[0]!==1||parsed[1]!==taskId||!Number.isSafeInteger(parsed[2])||!Number.isSafeInteger(parsed[3])||parsed[2]<0||parsed[3]<0||parsed[3]>parsed[2])badPage();high=parsed[2];last=parsed[3];
   }
   const eligible=entries.filter(j=>j.sequence!>last&&j.sequence!<=high),items=eligible.slice(0,limit);if(eligible.length<=limit)return {items};
   const body=Buffer.from(JSON.stringify([1,taskId,high,items.at(-1)!.sequence])).toString('base64url');return {items,nextCursor:body+'.'+sign(body)};
  }),
  listJournal:taskId=>update(root=>Object.values(root.journal).filter(j=>taskId===undefined||j.taskId===taskId)),
  blockTask:(taskId,revision)=>update(root=>{root.blocked[key([taskId,revision])]=true;for(const j of Object.values(root.journal))if(j.taskId===taskId){j.retryAt=0;j.retryAttempts=0;}}),
  isTaskBlocked:(taskId,revision)=>update(root=>root.blocked[key([taskId,revision])]===true),
  close(){if(!closed){sql.close?.();closed=true;}},
 };
}
