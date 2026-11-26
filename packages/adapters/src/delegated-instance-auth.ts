import {bounded,parseXml} from './aws-sts-protocol.js';
/** Private instance-auth channel. The STS signature itself is never a public receipt. */
export type DelegatedInstancePurpose = 'bootstrap' | 'report' | 'hf-token';
export interface DelegatedInstanceBinding { taskId:string; workloadId:string; revision:number; instanceId:string; descriptorHash:string; accountId:string; region:string }
export interface DelegatedOwnedInstance extends DelegatedInstanceBinding {
  accountId:string; roleName:string; roleId:string; region:string; active:boolean; expiresAt:number;
  /** Central approved scoped ref. Never the token value. */
  hfTokenRef?:string;
}
export interface DelegatedSignedRequest { method:string; url:string; headers:Record<string,string>; body:string }
export interface DelegatedInstanceChallenge { id:string; nonce:string; audience:string; purpose:DelegatedInstancePurpose; expiresAt:number; keyThumbprint?:string }
export interface DelegatedAuthenticatedInstance extends DelegatedInstanceBinding { purpose:DelegatedInstancePurpose; expiresAt:number }
export interface DelegatedTokenEnvelope { algorithm:'RSA-OAEP-256'; ciphertext:string; keyThumbprint:string; expiresAt:number; context:string }
export interface DelegatedInstanceAuthOptions {
  audience:string; region:string;
  lookupOwnedInstance:(binding:DelegatedInstanceBinding)=>Promise<DelegatedOwnedInstance|undefined>;
  bootstrapKeys:{read(binding:DelegatedInstanceBinding):Promise<string|undefined>;register(binding:DelegatedInstanceBinding,thumbprint:string):Promise<boolean>};
  fetch:typeof globalThis.fetch; now?:()=>number; challengeTtlMs?:number; maxChallenges?:number;
}
export interface DelegatedInstanceAuth {
  authorize(identity:unknown,binding:DelegatedInstanceBinding,purpose:DelegatedInstancePurpose):Promise<boolean>;
  issueChallenge(binding:DelegatedInstanceBinding,purpose:DelegatedInstancePurpose,keyThumbprint?:string):Promise<DelegatedInstanceChallenge>;
  authenticate(input:{challengeId:string; request:DelegatedSignedRequest; publicKeyJwk?:JsonWebKey}):Promise<DelegatedAuthenticatedInstance>;
  deliverHfToken(identity:DelegatedAuthenticatedInstance,ref:string,resolve:(ref:string)=>Promise<string>):Promise<DelegatedTokenEnvelope>;
}
const denied=()=>new Error('instance authentication denied');
const BODY='Action=GetCallerIdentity&Version=2011-06-15';
function random(){return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');}
function validBinding(b:DelegatedInstanceBinding){return b && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(b.taskId) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(b.workloadId) && Number.isSafeInteger(b.revision) && b.revision>0 && /^[a-f0-9]{64}$/.test(b.descriptorHash) && /^\d{12}$/.test(b.accountId) && /^[a-z]{2}-[a-z]+-[0-9]+$/.test(b.region) && /^i-[a-f0-9]{17}$/.test(b.instanceId);}
function sameBinding(a:DelegatedInstanceBinding,b:DelegatedInstanceBinding){return a.taskId===b.taskId&&a.workloadId===b.workloadId&&a.revision===b.revision&&a.instanceId===b.instanceId&&a.descriptorHash===b.descriptorHash&&a.accountId===b.accountId&&a.region===b.region;}
async function boundedText(response:Response,signal:AbortSignal):Promise<string>{
 const reader=response.body?.getReader();if(!reader)throw denied();let bytes=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await bounded(reader.read(),signal);if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384)throw denied();chunks.push(part.value);}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}
 catch{void reader.cancel().catch(()=>{});throw denied();}finally{reader.releaseLock();}
}
export function createDelegatedInstanceAuth(options:DelegatedInstanceAuthOptions):DelegatedInstanceAuth {
 const now=options.now??Date.now;
 const ttl=options.challengeTtlMs??60000, capacity=options.maxChallenges??1024;
 const endpoint=`https://sts.${options.region}.amazonaws.com/`;
 if(!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(options.audience)||options.audience.length>256||! /^[a-z]{2}-[a-z]+-[0-9]+$/.test(options.region)||!Number.isInteger(ttl)||ttl<1000||ttl>60000||!Number.isInteger(capacity)||capacity<1||capacity>1024)throw denied();
 type Pending={binding:DelegatedInstanceBinding;challenge:DelegatedInstanceChallenge;key?:CryptoKey};
 const challenges=new Map<string,Pending>();
 let pendingIssues=0;
 const identities=new WeakMap<DelegatedAuthenticatedInstance,Pending>();
 function prune(){for(const [id,p] of challenges)if(p.challenge.expiresAt<=now())challenges.delete(id);}
 async function current(binding:DelegatedInstanceBinding,purpose:DelegatedInstancePurpose){
  const owned=await options.lookupOwnedInstance(structuredClone(binding));
  if(!owned||!Number.isSafeInteger(owned.expiresAt)||typeof owned.active!=='boolean'||!sameBinding(owned,binding)||(purpose!=='report'&&(!owned.active||owned.expiresAt<=now()))||owned.region!==options.region||!/^\d{12}$/.test(owned.accountId)||!/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(owned.roleName)||!/^AROA[A-Z0-9]{12,28}$/.test(owned.roleId))throw denied();
  return structuredClone(owned);
 }
 return {
  async authorize(identity,binding,purpose){
   if(!identity||typeof identity!=='object')return false;const p=identities.get(identity as DelegatedAuthenticatedInstance);
   if(!p||p.challenge.expiresAt<=now()||p.challenge.purpose!==purpose||!sameBinding(p.binding,binding))return false;
   try{await current(p.binding,p.challenge.purpose);if(p.challenge.keyThumbprint&&await options.bootstrapKeys.read(p.binding)!==p.challenge.keyThumbprint)return false;return p.challenge.expiresAt>now();}catch{return false;}
  },
  async issueChallenge(binding,purpose,keyThumbprint){
   if(!validBinding(binding)||!['bootstrap','report','hf-token'].includes(purpose)|| (keyThumbprint!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(keyThumbprint))||((purpose==='hf-token'||purpose==='bootstrap')&&!keyThumbprint))throw denied();
   const copy=structuredClone(binding);prune();if(challenges.size+pendingIssues>=capacity)throw denied();
   pendingIssues++;
   try {
   const owned=await current(copy,purpose);const pinned=await options.bootstrapKeys.read(copy);
   if((purpose==='hf-token'&&pinned!==keyThumbprint)||(purpose==='bootstrap'&&pinned!==undefined&&pinned!==keyThumbprint))throw denied();
   prune();if(challenges.size>=capacity)throw denied();
   const challenge:DelegatedInstanceChallenge={id:random(),nonce:random(),audience:options.audience,purpose,expiresAt:purpose==='report'?now()+ttl:Math.min(now()+ttl,owned.expiresAt),...(keyThumbprint?{keyThumbprint}:{})};
   challenges.set(challenge.id,{binding:copy,challenge});return structuredClone(challenge);
   }catch{throw denied();}finally{pendingIssues--;}
  },
  async authenticate(input){
   const pending=challenges.get(input.challengeId);if(!pending)throw denied();
   challenges.delete(input.challengeId);
   try {
    const {binding,challenge:c}=pending;
    if(c.expiresAt<=now())throw denied();
    const owned=await current(binding,c.purpose);
    const r=input.request;
    if(!r||r.method!=='POST'||r.url!==endpoint||r.body!==BODY||!r.headers||Object.keys(r.headers).length>10)throw denied();
    const h=r.headers;
    const expected=['content-type','host','x-amz-date','x-amz-security-token','x-hivemind-audience','x-hivemind-nonce','x-hivemind-purpose',...(c.keyThumbprint?['x-hivemind-key-thumbprint']:[])].sort();
    if(Object.keys(h).sort().join(';')!==[...expected,'authorization'].sort().join(';'))throw denied();
    for(const v of Object.values(h))if(typeof v!=='string'||v.length>8192||/[\r\n]/.test(v))throw denied();
    if(h.host!==new URL(endpoint).host||h['content-type']!=='application/x-www-form-urlencoded'||h['x-hivemind-audience']!==c.audience||h['x-hivemind-nonce']!==c.nonce||h['x-hivemind-purpose']!==c.purpose||h['x-hivemind-key-thumbprint']!==c.keyThumbprint||!h['x-amz-security-token'])throw denied();
    const date=h['x-amz-date'];if(!date||!/^\d{8}T\d{6}Z$/.test(date))throw denied();
    const stamp=Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`);
    if(!Number.isFinite(stamp)||Math.abs(now()-stamp)>60000)throw denied();
    const authorization=h.authorization?.match(/^AWS4-HMAC-SHA256 Credential=(ASIA[A-Z0-9]{12,28})\/(\d{8})\/([a-z0-9-]+)\/sts\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/);
    if(!authorization||authorization[2]!==date.slice(0,8)||authorization[3]!==options.region||authorization[4]!==expected.join(';'))throw denied();
    if(c.keyThumbprint){
     const jwk=input.publicKeyJwk;
     if(!jwk||Object.keys(jwk).sort().join(';')!=='e;kty;n'||jwk.kty!=='RSA'||jwk.e!=='AQAB'||!jwk.n||!/^[A-Za-z0-9_-]{342,683}$/.test(jwk.n))throw denied();
     const modulus=Buffer.from(jwk.n,'base64url');if(modulus.length<256||modulus.length>512||modulus[0]!<128||modulus.toString('base64url')!==jwk.n)throw denied();
     const thumbprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({e:jwk.e,kty:'RSA',n:jwk.n})))).toString('base64url');
     if(thumbprint!==c.keyThumbprint)throw denied();
     pending.key=await crypto.subtle.importKey('jwk',jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    }else if(input.publicKeyJwk!==undefined)throw denied();
    const signal=AbortSignal.timeout(5000);
    const response=await bounded(options.fetch(endpoint,{method:'POST',headers:{...h},body:BODY,redirect:'manual',credentials:'omit',signal}),signal);
    if(response.status!==200||response.redirected){void response.body?.cancel().catch(()=>{});throw denied();}
    const fields=parseXml(await boundedText(response,signal),'GetCallerIdentityResponse');
    const field=(name:string)=>fields.get('GetCallerIdentityResponse/GetCallerIdentityResult/'+name);
    if(field('Account')!==owned.accountId||field('Arn')!==`arn:aws:sts::${owned.accountId}:assumed-role/${owned.roleName}/${binding.instanceId}`||field('UserId')!==`${owned.roleId}:${binding.instanceId}`)throw denied();
    const after=await current(binding,c.purpose);
    if(c.expiresAt<=now()||after.accountId!==owned.accountId||after.roleId!==owned.roleId||after.roleName!==owned.roleName)throw denied();
    if(c.purpose==='bootstrap'&&(!c.keyThumbprint||!await options.bootstrapKeys.register(binding,c.keyThumbprint)))throw denied();
    if(c.keyThumbprint&&await options.bootstrapKeys.read(binding)!==c.keyThumbprint)throw denied();
    if(c.expiresAt<=now())throw denied();
    const identity={...binding,purpose:c.purpose,expiresAt:c.expiresAt};identities.set(identity,pending);return Object.freeze(identity);
   }catch{throw denied();}
  },
  async deliverHfToken(identity,ref,resolve){
   const p=identities.get(identity);identities.delete(identity);
   try{
    if(!p||!p.key||p.challenge.purpose!=='hf-token'||p.challenge.expiresAt<=now())throw denied();
    if(await options.bootstrapKeys.read(p.binding)!==p.challenge.keyThumbprint)throw denied();
    const before=await current(p.binding,p.challenge.purpose);if(!before.hfTokenRef||ref!==before.hfTokenRef)throw denied();
    const token=await resolve(ref);
    if(typeof token!=='string'||!/^hf_[A-Za-z0-9_]{5,125}$/.test(token))throw denied();
    const after=await current(p.binding,p.challenge.purpose);if(after.hfTokenRef!==ref||p.challenge.expiresAt<=now())throw denied();
    const context=JSON.stringify({version:1,audience:p.challenge.audience,binding:p.binding,nonce:p.challenge.nonce,purpose:'hf-token',keyThumbprint:p.challenge.keyThumbprint,expiresAt:p.challenge.expiresAt});
    const bytes=new TextEncoder().encode(token);
    try{const ciphertext=Buffer.from(await crypto.subtle.encrypt({name:'RSA-OAEP',label:new TextEncoder().encode(context)},p.key,bytes)).toString('base64url');
     return {algorithm:'RSA-OAEP-256',ciphertext,keyThumbprint:p.challenge.keyThumbprint!,expiresAt:p.challenge.expiresAt,context};
    }finally{bytes.fill(0);}
   }catch{throw denied();}
  },
 };
}
