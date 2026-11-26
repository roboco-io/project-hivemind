import {createHash} from 'node:crypto';
import {createAwsScopedCredentialResolver,type AwsScopeDownRequest,type AwsScopedCredentialControl} from './aws-scoped-credentials.js';
import {assertAwsRegion} from './autonomous-aws-region.js';
import type {ExternalCredentialScope} from '../../contracts/src/autonomous-external.js';
import type {OidcGrant,OidcSignerPort} from '../../contracts/src/oidc.js';
export type {AwsScopedCredentialControl} from './aws-scoped-credentials.js';
export interface AwsSessionCredentials {accessKeyId:string;secretAccessKey:string;sessionToken:string}
export interface OidcStsAudit {taskId:string;revision:number;profileId:string;profileHash:string;actionId:string;purpose:OidcGrant['purpose'];roleArn:string;kid?:string;status:'scoped'|'denied'}
export interface AwsScopeDownPolicy extends Omit<AwsScopeDownRequest,'description'> {targetHash:string}
export interface AwsWebIdentityOptions {region:string;allowedRegions?:readonly string[];signer:OidcSignerPort;authority:{grant(scope:Readonly<ExternalCredentialScope>):Promise<OidcGrant>;scoping(scope:Readonly<ExternalCredentialScope>):Promise<AwsScopeDownPolicy>};fetch?:typeof fetch;now?:()=>number;audit?:(metadata:OidcStsAudit)=>void|Promise<void>}
import {parseXml,responseBody,bounded} from './aws-sts-protocol.js';
const unavailable=()=>new Error('AWS web identity unavailable');
function check(value:unknown):asserts value {if(!value)throw unavailable();}
const safe=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\s\p{Cc}]/u.test(s);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function awsOidcTargetHash(target:ExternalCredentialScope['target']):string {return digest(JSON.stringify(target,Object.keys(target).sort()));}
function identity(g:OidcGrant){const {issuedAt:_,expiresAt:__,...binding}=g;return JSON.stringify(binding,Object.keys(binding).sort());}
export function createAwsWebIdentityResolver(options:AwsWebIdentityOptions):{withCredentials<T>(scope:Readonly<ExternalCredentialScope>,consume:(credentials:AwsSessionCredentials,control:AwsScopedCredentialControl)=>Promise<T>):Promise<T>}{
 const {signer,authority,audit,fetch:fetcher=globalThis.fetch,now=Date.now}=options,region=options.region,allowed=options.allowedRegions&&[...options.allowedRegions];
 return {async withCredentials<T>(input:Readonly<ExternalCredentialScope>,consume:(credentials:AwsSessionCredentials,control:AwsScopedCredentialControl)=>Promise<T>):Promise<T>{
  let grant:OidcGrant|undefined,kid:string|undefined;
  const scope=structuredClone(input);
  try{
   assertAwsRegion(region,allowed);check(scope.provider==='aws'||scope.provider==='s3');check('accountId' in scope.target&&'region' in scope.target&&scope.target.region===region&&/^\d{12}$/.test(scope.target.accountId));
   const valid=(g:OidcGrant)=>{check(g.taskId===scope.taskId&&g.revision===scope.revision&&g.actionId===scope.actionId&&g.purpose===scope.purpose&&safe(g.subject,255)&&safe(g.audience,255)&&safe(g.profileId,128)&&/^[a-f0-9]{64}$/.test(g.profileHash)&&Number.isSafeInteger(g.issuedAt)&&Number.isSafeInteger(g.expiresAt)&&g.issuedAt<=Math.floor(now()/1000)&&g.expiresAt>Math.floor(now()/1000)&&g.expiresAt-g.issuedAt<=300);check(g.roleArn.startsWith(`arn:aws:iam::${'accountId' in scope.target?scope.target.accountId:''}:role/`)&&/^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9_+=,.@-]+\/)*[A-Za-z0-9_+=,.@-]{1,64}$/.test(g.roleArn));};
   const policy=structuredClone(await authority.scoping(scope));check(policy.targetHash===awsOidcTargetHash(scope.target)&&digest(policy.policy)===policy.policyHash);
   grant=structuredClone(await authority.grant(scope));valid(grant);const binding=identity(grant),session='hm-'+digest([scope.taskId,scope.revision,scope.actionId,scope.purpose].join(':')).slice(0,60);
   const recheck=async()=>{const currentPolicy=await authority.scoping(scope);check(currentPolicy.policy===policy.policy&&currentPolicy.policyHash===policy.policyHash&&currentPolicy.targetHash===policy.targetHash&&currentPolicy.durationSeconds===policy.durationSeconds&&currentPolicy.expiresAt>=policy.expiresAt);const current=await authority.grant(scope);valid(current);check(identity(current)===binding);};
   const signed=await signer.sign(Object.freeze({...grant}));check(safe(signed.token,20000)&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signed.token)&&/^[A-Za-z0-9_.-]{1,128}$/.test(signed.kid));kid=signed.kid;
   await recheck();check(grant.expiresAt>Math.floor(now()/1000));const signal=AbortSignal.timeout(5000),body=new URLSearchParams({Action:'AssumeRoleWithWebIdentity',Version:'2011-06-15',RoleArn:grant.roleArn,RoleSessionName:session,WebIdentityToken:signed.token,DurationSeconds:'900'});
   const response=await bounded(fetcher(`https://sts.${region}.amazonaws.com/`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'manual',credentials:'omit',signal}),signal);
   check(!response.redirected);const parsed=parseXml(await bounded(responseBody(response,signal),signal),'AssumeRoleWithWebIdentityResponse');await recheck();
   const prefix='AssumeRoleWithWebIdentityResponse/AssumeRoleWithWebIdentityResult/',get=(path:string)=>{const v=parsed.get(prefix+path);check(v);return v;};
   const accessKeyId=get('Credentials/AccessKeyId'),secretAccessKey=get('Credentials/SecretAccessKey'),sessionToken=get('Credentials/SessionToken'),expiration=get('Credentials/Expiration'),arn=get('AssumedRoleUser/Arn');
   check(/^ASIA[A-Z0-9]{16}$/.test(accessKeyId)&&/^[A-Za-z0-9/+=]{40}$/.test(secretAccessKey)&&safe(sessionToken,20000));
   check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiration));const expires=Date.parse(expiration);check(Number.isFinite(expires)&&expires>now()+1000&&expires<=now()+900000+30000);
   check(arn===`arn:aws:sts::${'accountId' in scope.target?scope.target.accountId:''}:assumed-role/${grant.roleArn.split('/').at(-1)}/${session}`);
   check(get('AssumedRoleUser/AssumedRoleId').endsWith(':'+session));if(parsed.has(prefix+'Audience'))check(get('Audience')===grant.audience);
   return await createAwsScopedCredentialResolver({region,allowedRegions:allowed,fetch:fetcher,now}).withCredentials({accessKeyId,secretAccessKey,sessionToken,expiresAt:expires,arn,sessionId:get('AssumedRoleUser/AssumedRoleId'),...(parsed.has(prefix+'SourceIdentity')?{sourceIdentity:get('SourceIdentity')}:{})},{...policy,description:'hm-'+digest([grant.taskId,grant.revision,grant.profileId,grant.actionId,grant.purpose].join(':'))},async (child,control)=>{
    await recheck();
    const metadata:OidcStsAudit={taskId:grant!.taskId,revision:grant!.revision,profileId:grant!.profileId,profileHash:grant!.profileHash,actionId:grant!.actionId,purpose:grant!.purpose,roleArn:grant!.roleArn,kid,status:'scoped'};
    if(audit)await audit(Object.freeze(metadata));await recheck();control.assertValid();return await consume(child,control);
   });
  }catch{
   if(grant&&audit)try{await audit(Object.freeze({taskId:grant.taskId,revision:grant.revision,profileId:grant.profileId,profileHash:grant.profileHash,actionId:grant.actionId,purpose:grant.purpose,roleArn:grant.roleArn,...(kid?{kid}:{}),status:'denied'}));}catch{}
   throw unavailable();
  }
 }};
}
