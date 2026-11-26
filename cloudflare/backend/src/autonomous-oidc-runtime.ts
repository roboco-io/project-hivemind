import {createHash} from 'node:crypto';
import {deriveOidcGrant,validateOidcIssuer} from '../../../packages/core/src/oidc.ts';
import type {AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
import type {ExternalCredentialScope,ExternalProfile} from '../../../packages/contracts/src/autonomous-external.ts';
import type {OidcConfig,OidcGrant} from '../../../packages/contracts/src/oidc.ts';
import type {AutonomousApiService} from '../../../apps/control-plane/src/autonomous-api.ts';
import type {ExternalDurableStore} from '../../../packages/core/src/autonomous-external-sql.ts';
export interface CanonicalOidcAuthorityOptions {
 core:AutonomousApiService;store:ExternalDurableStore;now?:()=>number;
 currentProfile(id:string):ExternalProfile|undefined;
 config(scope:Readonly<ExternalCredentialScope>,profile:ExternalProfile):OidcConfig;
}
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const digest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
function deny():never{throw Error('OIDC authority unavailable');}
export function createCanonicalOidcAuthority(options:CanonicalOidcAuthorityOptions):{grant(scope:Readonly<ExternalCredentialScope>):Promise<OidcGrant>}{
 const now=options.now??Date.now;
 return {async grant(raw){
  const scope=structuredClone(raw);
  const task=await options.core.execute('get',{id:scope.taskId}) as AutonomousTask;
  const facts=options.store.transaction(s=>{
   const action=s.actions[scope.actionId],approval=action?s.approvals[action.approvalId]:undefined;
   if(!action||!approval||approval.taskId!==scope.taskId||approval.revision!==scope.revision||approval.profile.provider!==scope.provider||action.operation!==scope.operation||action.expiresAt!==scope.expiresAt||digest(approval.profile.target)!==digest(scope.target))deny();
   return structuredClone({action,approval});
  });
  const {action,approval}=facts;
  const journal=options.store.getJournal(scope.taskId,scope.revision,action.requestId);
  const reservation=journal&&task.actions.find(a=>a.id===journal.mainReservationId&&a.requestId===journal.mainRequestId);
  if(!journal||!reservation||journal.brokerActionId!==undefined&&journal.brokerActionId!==action.id||reservation.tool!=='mcp__hivemind__action'||reservation.system!==scope.provider||reservation.operation!==scope.operation||reservation.estimatedCostMicros!==action.upperBoundMicros)deny();
  if(scope.purpose==='execute'&&(options.store.isTaskBlocked(scope.taskId,scope.revision)||journal.dispatchBlocked||!['reserved','accepted'].includes(reservation.status)))deny();
  const profile=scope.purpose==='execute'?options.currentProfile(approval.profileId):approval.profile;
  if(!profile)deny();
  const config=options.config(scope,profile);
  return deriveOidcGrant(config,{task,action,approval,profile},scope.purpose,now());
 }};
}

export interface OidcScopeTemplate {policy:string;policyHash:string;durationSeconds:number}
export interface ExternalOidcSettings {version:1;oidc:OidcConfig;scoping:Record<string,Record<'execute'|'inspect'|'cleanup',OidcScopeTemplate>>}
export function parseExternalOidcSettings(raw:string):ExternalOidcSettings {
 if(Buffer.byteLength(raw)>65536)deny();let settings:ExternalOidcSettings;
 try{settings=JSON.parse(raw);}catch{deny();}
 const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 if(!exact(settings!,['version','oidc','scoping'])||settings!.version!==1||!settings!.scoping||!settings!.oidc)deny();
 const config=settings!.oidc;
 if(!exact(config,['issuer','audience','roles',...(config.ttlSeconds!==undefined?['ttlSeconds']:[])]))deny();
 // Validate configuration without creating execution facts or signing a grant.
 validateOidcIssuer(config.issuer);
 if(typeof config.audience!=='string'||!config.audience.length||config.audience.length>255||/[\s\p{Cc}]/u.test(config.audience)||(config.ttlSeconds!==undefined&&(!Number.isInteger(config.ttlSeconds)||config.ttlSeconds<1||config.ttlSeconds>300)))deny();
 const ids=Object.keys(config.roles??{});if(!ids.length||ids.length>4||Object.keys(settings!.scoping).length!==ids.length)deny();
 for(const id of ids){
  const roles=config.roles[id]!,templates=settings!.scoping[id];
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)||!exact(roles,['executeRoleArn','cleanupRoleArn'])||roles.executeRoleArn===roles.cleanupRoleArn||![roles.executeRoleArn,roles.cleanupRoleArn].every(r=>/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.test(r))||!exact(templates,['execute','inspect','cleanup']))deny();
  for(const purpose of ['execute','inspect','cleanup'] as const){const t=templates![purpose];
   if(!exact(t,['policy','policyHash','durationSeconds'])||typeof t.policy!=='string'||Buffer.byteLength(t.policy)>2048||createHash('sha256').update(t.policy).digest('hex')!==t.policyHash||!Number.isInteger(t.durationSeconds)||t.durationSeconds<1||t.durationSeconds>120)deny();
   let policy:unknown;try{policy=JSON.parse(t.policy);}catch{deny();}if(!policy||typeof policy!=='object'||Array.isArray(policy))deny();
  }
 }
 return structuredClone(settings!);
}

export type OidcAuditRecord=import('../../../packages/contracts/src/autonomous-external.ts').ExternalOidcAuditEvent;
export interface OidcAuditQuery {after?:number;limit?:number}
export function createOidcAuditStore(sql:import('../../../packages/core/src/autonomous-external-sql.ts').ExternalSqlPort,now:()=>number=Date.now){
 sql.exec('CREATE TABLE IF NOT EXISTS external_oidc_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,json TEXT NOT NULL)');
 function validate(value:import('../../../packages/adapters/src/aws-web-identity.ts').OidcStsAudit){
  if(!value||!['execute','inspect','cleanup'].includes(value.purpose)||!['scoped','denied'].includes(value.status)||!Number.isSafeInteger(value.revision)||value.revision<1||!/^[a-f0-9]{64}$/.test(value.profileHash)||!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]{1,512}$/.test(value.roleArn)||[value.taskId,value.profileId,value.actionId].some(v=>typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v))||value.kid!==undefined&&!/^[A-Za-z0-9_.-]{1,128}$/.test(value.kid))deny();
 }
 return {
  record(value:import('../../../packages/adapters/src/aws-web-identity.ts').OidcStsAudit){validate(value);const at=now();if(!Number.isSafeInteger(at)||at<0)deny();const safe={taskId:value.taskId,revision:value.revision,profileId:value.profileId,profileHash:value.profileHash,actionId:value.actionId,purpose:value.purpose,roleArn:value.roleArn,...(value.kid?{kid:value.kid}:{}),status:value.status,at};
   sql.transactionSync(()=>{sql.exec('INSERT INTO external_oidc_audit(task_id,json) VALUES(?,?)',value.taskId,JSON.stringify(safe));sql.exec('DELETE FROM external_oidc_audit WHERE task_id=? AND sequence NOT IN (SELECT sequence FROM external_oidc_audit WHERE task_id=? ORDER BY sequence DESC LIMIT 1024)',value.taskId,value.taskId);sql.exec('DELETE FROM external_oidc_audit WHERE sequence NOT IN (SELECT sequence FROM external_oidc_audit ORDER BY sequence DESC LIMIT 8192)');});
  },
  page(taskId:string,query:OidcAuditQuery={}){const after=query.after??0,limit=query.limit??50;if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100||typeof taskId!=='string'||taskId.length>200)deny();const rows=[...sql.exec('SELECT sequence,json FROM external_oidc_audit WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?',taskId,after,limit+1)];const items=rows.slice(0,limit).map(row=>{const value=JSON.parse(String(row.json));validate(value);if(value.taskId!==taskId)deny();return {...value,sequence:Number(row.sequence)} as OidcAuditRecord;});return {source:'oidc_broker' as const,items,...(rows.length>limit?{nextAfter:items.at(-1)!.sequence}:{})};},
 };
}
