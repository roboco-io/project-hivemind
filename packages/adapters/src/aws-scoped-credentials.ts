import {createHash,createHmac} from 'node:crypto';
import {assertAwsRegion} from './autonomous-aws-region.js';
import {parseXml,responseBody,bounded} from './aws-sts-protocol.js';
import type {AwsSessionCredentials} from './aws-web-identity.js';
export interface AwsParentSession extends AwsSessionCredentials {expiresAt:number;arn:string;sessionId:string;sourceIdentity?:string;scopedPoliciesCount?:number}
export interface AwsScopeDownRequest {policy:string;policyHash:string;durationSeconds:number;expiresAt:number;description:string}
export interface AwsScopedCredentialControl {readonly expiresAt:number;assertValid():void}
export interface AwsScopedCredentialOptions {region:string;allowedRegions?:readonly string[];fetch?:typeof fetch;now?:()=>number}
const fail=()=>new Error('AWS scoped credentials unavailable');
function check(v:unknown):asserts v {if(!v)throw fail();}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const safe=(s:unknown,max:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\s\p{Cc}]/u.test(s);
export function createAwsScopedCredentialResolver(options:AwsScopedCredentialOptions):{withCredentials<T>(parent:Readonly<AwsParentSession>,request:Readonly<AwsScopeDownRequest>,consume:(credentials:AwsSessionCredentials,control:AwsScopedCredentialControl)=>Promise<T>):Promise<T>}{
 const {region,now=Date.now,fetch:fetcher=globalThis.fetch}=options,allowed=options.allowedRegions&&[...options.allowedRegions];
 return {async withCredentials<T>(input:Readonly<AwsParentSession>,requested:Readonly<AwsScopeDownRequest>,consume:(credentials:AwsSessionCredentials,control:AwsScopedCredentialControl)=>Promise<T>):Promise<T>{
 try{
  assertAwsRegion(region,allowed);const p=structuredClone(input),r=structuredClone(requested),started=now();
  check(/^ASIA[A-Z0-9]{12,124}$/.test(p.accessKeyId)&&/^[A-Za-z0-9/+=]{40}$/.test(p.secretAccessKey)&&safe(p.sessionToken,65536)&&/^arn:aws:sts::\d{12}:assumed-role\/[A-Za-z0-9_+=,.@-]{1,64}\/[A-Za-z0-9_+=,.@-]{2,64}$/.test(p.arn));
  check(safe(p.sessionId,256)&&p.sessionId.split(':').at(-1)===p.arn.split('/').at(-1));check(p.sourceIdentity===undefined||/^[\w+=,.@-]{2,256}$/.test(p.sourceIdentity));
  const layers=p.scopedPoliciesCount??0;check(Number.isInteger(layers)&&layers>=0&&layers<3);
  check(typeof r.policy==='string'&&r.policy.length>0&&r.policy.length<=2048&&/^[\x09\x0a\x0d\x20-\xff]+$/.test(r.policy)&&sha(r.policy)===r.policyHash);
  const doc=JSON.parse(r.policy);check(doc&&typeof doc==='object'&&!Array.isArray(doc)&&doc.Version==='2012-10-17'&&Array.isArray(doc.Statement)&&doc.Statement.length>0);
  check(Number.isSafeInteger(r.durationSeconds)&&r.durationSeconds>=1&&r.durationSeconds<=120&&Number.isSafeInteger(r.expiresAt)&&Number.isSafeInteger(p.expiresAt)&&/^[\x20-\x7e]{2,256}$/.test(r.description));
  const duration=Math.min(r.durationSeconds,Math.floor((p.expiresAt-started)/1000),Math.floor((r.expiresAt-started)/1000));check(duration>=1);
  const body=new URLSearchParams({Action:'GetScopedCredentials',Version:'2011-06-15',Policy:r.policy,DurationSeconds:String(duration),ScopedSessionDescription:r.description}).toString(),host=`sts.${region}.amazonaws.com`,stamp=new Date(started).toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8),scope=`${day}/${region}/sts/aws4_request`;
  const headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded',host,'x-amz-date':stamp,'x-amz-security-token':p.sessionToken};
  const keys=Object.keys(headers).sort(),signedHeaders=keys.join(';'),canonical=['POST','/','',keys.map(k=>k+':'+headers[k]+'\n').join(''),signedHeaders,sha(body)].join('\n');
  const hmac=(key:string|Uint8Array,value:string)=>createHmac('sha256',key).update(value).digest();let key=hmac('AWS4'+p.secretAccessKey,day);for(const value of [region,'sts','aws4_request'])key=hmac(key,value);
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256',key).update(['AWS4-HMAC-SHA256',stamp,scope,sha(canonical)].join('\n')).digest('hex')}`;
  const signal=AbortSignal.timeout(5000),response=await bounded(fetcher(`https://${host}/`,{method:'POST',headers,body,signal,redirect:'manual',credentials:'omit'}),signal);check(!response.redirected);const parsed=parseXml(await bounded(responseBody(response,signal),signal),'GetScopedCredentialsResponse');
  const base='GetScopedCredentialsResponse/GetScopedCredentialsResult/',get=(name:string)=>{const value=parsed.get(base+name);check(value);return value;};
  check(get('SessionInfo/Arn')===p.arn&&get('SessionInfo/ScopedSessionId')===p.sessionId&&parsed.get(base+'SourceIdentity')===p.sourceIdentity);
  check(/^\d$/.test(get('ScopedPoliciesCount'))&&Number(get('ScopedPoliciesCount'))===layers+1&&Number(get('ScopedPoliciesCount'))<=3);
  const expiry=get('Credentials/Expiration');check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiry));const expires=Date.parse(expiry);check(Number.isFinite(expires)&&expires>now()&&expires<=p.expiresAt&&expires<=r.expiresAt&&expires<=started+duration*1000);
  const c={accessKeyId:get('Credentials/AccessKeyId'),secretAccessKey:get('Credentials/SecretAccessKey'),sessionToken:get('Credentials/SessionToken')};check(/^ASIA[A-Z0-9]{12,124}$/.test(c.accessKeyId)&&/^[A-Za-z0-9/+=]{40}$/.test(c.secretAccessKey)&&safe(c.sessionToken,65536));
  if(parsed.has(base+'SessionTokenSize'))check(/^\d+$/.test(get('SessionTokenSize'))&&Number(get('SessionTokenSize'))===Buffer.byteLength(c.sessionToken));
  const control:AwsScopedCredentialControl=Object.freeze({expiresAt:expires,assertValid(){check(now()<expires);}});control.assertValid();
  return await consume(Object.freeze(c),control);
 }catch{throw fail();}
 }};
}
