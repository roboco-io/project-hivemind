import {createHash} from 'node:crypto';
import type {OidcConfig,OidcFacts,OidcGrant,OidcPurpose} from '../../contracts/src/oidc.js';
function deny():never {throw new Error('OIDC authority denied');}
function canonical(v:unknown):string {if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';}
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export function validateOidcIssuer(issuer:string):void {let u:URL;try{u=new URL(issuer);}catch{deny();}if(!/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(issuer)||u!.protocol!=='https:'||u!.username||u!.password||u!.port||u!.search||u!.hash||u!.hostname.split('.').length<2||!/[a-z]/.test(u!.hostname.split('.').at(-1)!)||u!.hostname.split('.').some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||['local','localhost','internal','invalid','test','example'].some(t=>u!.hostname===t||u!.hostname.endsWith('.'+t))||u!.origin+(u!.pathname==='/'?'':u!.pathname)!==issuer)deny();}
export function oidcSubject(taskId:string,revision:number,profileHash:string,purpose:OidcPurpose):string {if(typeof taskId!=='string'||!taskId.length||taskId.length>1024||!Number.isSafeInteger(revision)||revision<1||!/^[a-f0-9]{64}$/.test(profileHash)||!['execute','inspect','cleanup'].includes(purpose))deny();const taskHash=createHash('sha256').update(taskId).digest('hex');return `hivemind:task:${taskHash}:rev:${revision}:profile:${profileHash}:${purpose}`;}
export function deriveOidcGrant(config:OidcConfig,facts:OidcFacts,purpose:OidcPurpose,now:number):OidcGrant {
 validateOidcIssuer(config.issuer);
 const ttl=config.ttlSeconds??60;if(!Number.isSafeInteger(now)||now<0||!Number.isInteger(ttl)||ttl<1||ttl>300||typeof config.audience!=='string'||!config.audience.length||config.audience.length>255||/[\x00-\x20\x7f]/.test(config.audience))deny();
 const {task,approval:a,action,profile:p}=facts;const role=config.roles[p.id];
 if(!role||role.executeRoleArn===role.cleanupRoleArn||(p.provider!=='aws'&&p.provider!=='s3')||(a.profile.provider!=='aws'&&a.profile.provider!=='s3')||p.provider!==a.profile.provider||!/^\d{12}$/.test(a.profile.target.accountId))deny();
 const arn=new RegExp('^arn:aws:iam::'+a.profile.target.accountId+':role/[A-Za-z0-9+=,.@_/-]{1,512}$');if(!arn.test(role.executeRoleArn)||!arn.test(role.cleanupRoleArn))deny();
 if(!['intent','dispatching','ambiguous','succeeded','failed','cancelled'].includes(action.status)||task.id!==a.taskId||p.id!==a.profileId||a.profile.id!==p.id||action.approvalId!==a.id||!action.id||!action.ownershipToken||!action.idempotencyKey||!Number.isSafeInteger(a.approvedAt)||a.approvedAt>now||!Number.isSafeInteger(action.createdAt)||action.createdAt<a.approvedAt||action.createdAt>now||a.profileHash!==digest(a.profile)||action.profileHash!==a.profileHash||action.parametersHash!==digest({operation:action.operation,parameters:action.parameters})||!a.profile.operations.includes(action.operation as never))deny();
 const historical=purpose==='cleanup'||purpose==='inspect';if(!historical&&purpose!=='execute')deny();
 let expiresAt=Math.floor(now/1000)+ttl;
 if(!historical){
  if(p.enabled!==true||digest(p)!==a.profileHash||task.status!=='running'||task.stopReason||task.approvedAt===undefined||task.approvedAt>now||task.revision!==a.revision||!task.spec.externalProfiles?.includes(p.id)||a.stoppedAt!==undefined||!task.lease||task.lease.taskId!==task.id||!task.lease.runId||!task.lease.workerId||!['intent','dispatching'].includes(action.status))deny();
  const deadlines=[task.spec.endsAt,a.endsAt,action.expiresAt,task.lease.expiresAt];if(deadlines.some(d=>!Number.isSafeInteger(d)||d<=now))deny();expiresAt=Math.min(expiresAt,...deadlines.map(d=>Math.floor(d/1000)));
 }
 const issuedAt=Math.floor(now/1000);if(expiresAt<=issuedAt)deny();
 return {issuer:config.issuer,audience:config.audience,subject:oidcSubject(task.id,a.revision,a.profileHash,purpose),roleArn:historical?role.cleanupRoleArn:role.executeRoleArn,taskId:task.id,revision:a.revision,profileId:p.id,profileHash:a.profileHash,actionId:action.id,purpose,issuedAt,expiresAt};
}
