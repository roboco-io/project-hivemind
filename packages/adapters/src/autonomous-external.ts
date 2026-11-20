import {createHash,createHmac} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {ExternalInvocation,ExternalProviderReceipt,ExternalResource} from '../../contracts/src/autonomous-external.js';
import {externalParametersHash,externalRecoveryBinding,parseExternalRecoveryCursor,type ExternalDispatchAuthority,type GuardedExternalProviderTransport} from '../../core/src/autonomous-external.ts';
import type {ExternalCostReader} from './autonomous-external-cost.ts';
import type {ExternalLargeLimits,ExternalLargeManifest} from '../../contracts/src/autonomous-external-large.js';
import type {ExternalS3Target} from '../../contracts/src/autonomous-external-s3.js';
import {externalLargeManifestDigest,validateExternalLargeManifest} from '../../core/src/autonomous-external-large.ts';
import {externalS3PutOf} from '../../core/src/autonomous-external-s3.ts';
import {createExternalS3Transport,type ExternalS3Transport} from './autonomous-external-s3.ts';
import {assertHfVisibility,resolveHfVisibility,type HfVisibility} from './autonomous-external-hf-visibility.ts';
import {hfLfsCommit,hfLfsProof,type HfLfsOptions} from './autonomous-external-hf-lfs.ts';
export type ExternalProviderCredential={provider:'aws';accessKeyId:string;secretAccessKey:string;sessionToken?:string}|{provider:'hf'|'github';token:string};
export interface ExternalArtifact {files:{path:string;contentBase64:string}[]}
/** Digest producer: stable field order, immutable file order, canonical base64 required. */
export function externalArtifactDigest(artifact:ExternalArtifact):string{return createHash('sha256').update(JSON.stringify({files:artifact.files.map(f=>({path:f.path,contentBase64:f.contentBase64}))})).digest('hex');}
/** Shared ingress/egress validation. Errors never include file data or secrets. */
export function validateExternalArtifact(value:unknown,knownSecretValues:readonly string[]=[]):ExternalArtifact {
 const a=record(value);fields(a,['files']);requireThat(Array.isArray(a.files)&&a.files.length>0&&a.files.length<=32);
 requireThat(knownSecretValues.length<=256&&knownSecretValues.every(v=>typeof v==='string'&&Buffer.byteLength(v)<=262144));
 const secrets=knownSecretValues.filter(v=>v.length>0).map(v=>Buffer.from(v));
 function scan(bytes:Buffer,depth=0):void {
  requireThat(!secrets.some(v=>bytes.includes(v)));
  const s=bytes.toString('utf8');requireThat(!/(?:Bearer\s+\S+|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:hf_|ghp_|ghs_|github_pat_|sk-ant-|sk-proj-)[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(s));
  // Bounded decoding closes common nested encoding paths without interpreting code.
  const candidates:Buffer[]=[];
  for(const m of s.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)){const token=m[0];const b=Buffer.from(token,'base64url');if(b.length&&b.toString('base64url')===token.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'))candidates.push(b);}
  if(/%[a-f0-9]{2}/i.test(s)){try{const decoded=decodeURIComponent(s);if(decoded!==s)candidates.push(Buffer.from(decoded));}catch{}}
  if(/\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i.test(s))candidates.push(Buffer.from(s.replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/gi,(_,u:string,x:string)=>String.fromCharCode(parseInt(u??x,16)))));
  for(const candidate of candidates){if(depth>=4){requireThat(!secrets.some(v=>candidate.includes(v)));continue;}scan(candidate,depth+1);}
 }
 const seen=new Set<string>();let total=0;
 const files=a.files.map((raw:unknown)=>{const f=record(raw);fields(f,['path','contentBase64']);text(f.path,240);
  requireThat(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(f.path)&&!f.path.includes('..')&&!f.path.includes('//')&&!f.path.endsWith('/'));
  requireThat(!/(^|\/)(?:\.?(?:env|git|ssh|aws|codex|claude|hivemind)|runtime|private|secrets?|credentials?|auth(?:entication)?|tokens?|sessions?)(?:[./_-]|$)/i.test(f.path)&&!/(?:\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i.test(f.path));
  requireThat(!seen.has(f.path));seen.add(f.path);scan(Buffer.from(f.path));
  requireThat(typeof f.contentBase64==='string'&&f.contentBase64.length<=Math.ceil(256*1024/3)*4);
  const bytes=Buffer.from(f.contentBase64,'base64');requireThat(bytes.length<=256*1024&&bytes.toString('base64')===f.contentBase64);total+=bytes.length;requireThat(total<=MAX_BODY);scan(bytes);
  return {path:f.path,contentBase64:f.contentBase64};
 });return {files};
}
export interface ExternalArtifactPublisher {
 publish(artifact:ExternalArtifact,options:{knownSecretValues:readonly string[];beforeWrite:()=>Promise<void>}):Promise<{artifactDigest:string}>;
}
export interface ExternalR2PublicationBucket {
 get(key:string):Promise<{size:number;arrayBuffer():Promise<ArrayBuffer>}|null>;
 put(key:string,value:string,options:{onlyIf:{etagDoesNotMatch:string}}):Promise<unknown|null>;
}
/** Conditional creation only. An existing key must contain identical canonical bytes. */
export function createExternalR2ArtifactPublisher(bucket:ExternalR2PublicationBucket):ExternalArtifactPublisher {
 return {async publish(raw,options){
  const artifact=validateExternalArtifact(raw,options.knownSecretValues),artifactDigest=externalArtifactDigest(artifact),key='external-artifacts/'+artifactDigest,canonical=JSON.stringify(artifact);
  async function same(){const existing=await bucket.get(key);requireThat(existing&&existing.size===Buffer.byteLength(canonical));const bytes=await existing.arrayBuffer();requireThat(bytes.byteLength===existing.size&&Buffer.from(bytes).equals(Buffer.from(canonical)));}
  await options.beforeWrite();const result=await bucket.put(key,canonical,{onlyIf:{etagDoesNotMatch:'*'}});if(result===null)await same();
  return {artifactDigest};
 }};
}
export interface ExternalArtifactLoader {load(digest:string):Promise<ExternalArtifact>}
/** Separate from SourceSnapshot digests. No URL, CLI or namespace fallback. */
export function createExternalR2ArtifactLoader(bucket:{get(key:string):Promise<{size:number;arrayBuffer():Promise<ArrayBuffer>}|null>}):ExternalArtifactLoader {
 return {async load(digest){try{
  requireThat(/^[a-f0-9]{64}$/.test(digest));const object=await bucket.get('external-artifacts/'+digest);
  requireThat(object&&Number.isSafeInteger(object.size)&&object.size>0&&object.size<=2*MAX_BODY);
  const bytes=await object.arrayBuffer();requireThat(bytes.byteLength===object.size);
  const artifact=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))) as unknown as ExternalArtifact;
  fields(artifact,['files']);requireThat(Array.isArray(artifact.files)&&artifact.files.length>0&&artifact.files.length<=32);
  for(const file of artifact.files){fields(file,['path','contentBase64']);text(file.path,240);requireThat(typeof file.contentBase64==='string'&&file.contentBase64.length<=2*MAX_BODY);}
  requireThat(externalArtifactDigest(artifact)===digest);return artifact;
 }catch{throw unavailable();}}};
}
export interface AwsTtlGuardRequest {
 accountId:string;region:string;workloadId:string;actionId:string;ownershipToken:string;
 clientToken:string;parametersHash:string;expiresAt:number;maxExposureMicros:number;configurationHash:string;
}
export interface AwsTtlGuardEvidence {
 kind:'preexisting_termination_guard';guardArn:string;evidenceId:string;bindingHash:string;
 installedAt:number;observedAt:number;validUntil:number;maxExposureMicros:number;
}
export interface AwsOwnershipTimerEvidence {
 kind:'owned_expiry_timer';guardArn:string;timerArn:string;evidenceId:string;bindingHash:string;expiresAt:number;
}
/** Trusted infrastructure port. Implementations must verify remote enforcement, not echo input.
 * No concrete AWS guard is installed by this library. Missing port denies Spot starts. */
export interface AwsTtlGuardPort {
 attest(request:Readonly<AwsTtlGuardRequest>,signal?:AbortSignal):Promise<AwsTtlGuardEvidence>;
 arm(request:Readonly<AwsTtlGuardRequest>,guard:Readonly<AwsTtlGuardEvidence>,signal?:AbortSignal):Promise<AwsOwnershipTimerEvidence>;
}
export interface ExternalProviderOptions {
 enabled?:boolean;
 /** Trusted factory-known secret values, never task input or persisted public policy. */
 forbiddenValues?:readonly string[];
 aws?:{enabled?:boolean;accountId:string;region:string;workloadId:string;imageId:string;instanceType:string;subnetId:string;instanceProfileArn:string;maxLifetimeMs:number;credentialRef?:string;maxUpperBoundMicros?:number;billingPolicy?:'reserved_ceiling_only'|'verified_cost_source'};
 awsTtlGuard?:{guardArn:string;port:AwsTtlGuardPort};
 costReader?:ExternalCostReader;
 hf?:{enabled?:boolean;repository:string;revision:string;
  /** Omitted means private. Must equal the approved profile target. */
  visibility?:HfVisibility;
  /** Large-artifact commits. Without it hf.model.lfs_commit is denied. */
  lfs?:ExternalHfLfsConfig};
 s3?:{enabled?:boolean;target:ExternalS3Target};
 github?:{enabled?:boolean;repository:string;branch:string};
 artifacts:ExternalArtifactLoader;fetch?:typeof fetch;now?:()=>number;
}
/** Server-owned LFS wiring. The manifest and byte stream come from the large store, never from model input. */
export interface ExternalHfLfsConfig {
 uploadHosts:readonly string[];limits:ExternalLargeLimits;
 loadManifest(manifestDigest:string,i:ExternalInvocation):Promise<ExternalLargeManifest>;
 /** The invocation identifies the owner. The implementation must open only that owner's verified files. */
 open(file:Parameters<HfLfsOptions['open']>[0],i:ExternalInvocation):ReturnType<HfLfsOptions['open']>;
}
export type ExternalAwsLaunchPolicy=Pick<NonNullable<ExternalProviderOptions['aws']>,
 'accountId'|'region'|'workloadId'|'imageId'|'instanceType'|'subnetId'|'instanceProfileArn'|'maxLifetimeMs'|'maxUpperBoundMicros'>;
/** Schema v1: sorted-key JSON of only the fixed launch scope and limit fields.
 * enabled, credentialRef/values, billingPolicy and per-action data are not launch policy.
 * Equivalent to awsGuardDigest(normalizedPolicy); no configuration spread is hashed. */
export function externalAwsConfigurationHash(config:ExternalAwsLaunchPolicy):string {
 const policy={schemaVersion:1,accountId:config.accountId,region:config.region,workloadId:config.workloadId,imageId:config.imageId,instanceType:config.instanceType,subnetId:config.subnetId,instanceProfileArn:config.instanceProfileArn,maxLifetimeMs:config.maxLifetimeMs,maxUpperBoundMicros:config.maxUpperBoundMicros};
 for(const key of ['accountId','region','workloadId','imageId','instanceType','subnetId','instanceProfileArn'] as const)text(policy[key],256);
 requireThat(/^\d{12}$/.test(policy.accountId)&&Number.isSafeInteger(policy.maxLifetimeMs)&&policy.maxLifetimeMs>0&&Number.isSafeInteger(policy.maxUpperBoundMicros)&&policy.maxUpperBoundMicros!>0);
 return sha256(JSON.stringify(Object.fromEntries(Object.keys(policy).sort().map(key=>[key,policy[key as keyof typeof policy]]))));
}
const MAX_BODY=1024*1024,TIMEOUT_MS=5000,ATTEST_TIMEOUT_MS=25000,ARM_TIMEOUT_MS=15000,COST_TIMEOUT_MS=15000;
const sha256=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const gitBlob=(b:Uint8Array)=>createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.byteLength}\0`),b])).digest('hex');
const unavailable=()=>new Error('External provider unavailable');
function requireThat(ok:unknown):asserts ok{if(!ok)throw unavailable();}
function record(x:unknown):Record<string,unknown>{requireThat(x!==null&&typeof x==='object'&&!Array.isArray(x));return x as Record<string,unknown>;}
function text(x:unknown,max=256):asserts x is string{requireThat(typeof x==='string'&&x.length>0&&x.length<=max&&!/[\p{Cc}]/u.test(x));}
function hashId(x:unknown):asserts x is string{requireThat(typeof x==='string'&&/^[a-f0-9]{40}$/.test(x));}
const mark=(i:ExternalInvocation)=>'hivemind:'+sha256(JSON.stringify([i.ownershipToken,i.idempotencyKey,i.parametersHash]));
const segment=(s:string)=>encodeURIComponent(s);
function repository(s:string){requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s));return s.split('/').map(segment).join('/');}
function ref(s:string){requireThat(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(s)&&!s.includes('..')&&!s.includes('//')&&!s.endsWith('/')&&!s.endsWith('.lock'));return segment(s);}
function fields(x:object,keys:string[]){requireThat(x&&Object.getPrototypeOf(x)===Object.prototype&&Reflect.ownKeys(x).length===keys.length&&Object.entries(Object.getOwnPropertyDescriptors(x)).every(([k,d])=>keys.includes(k)&&d.enumerable&&'value' in d));}
interface Xml {name:string;text:string;children:Xml[]}
// A bounded XML subset: no DTD, entities beyond the five predefined escapes or namespaces.
function xml(input:string):Xml{
 requireThat(!/<!/.test(input));const root:Xml={name:'root',text:'',children:[]},stack=[root];let nodes=0;
 const source=input.replace(/^\s*<\?xml[^?]*\?>/,'');const tokens=source.match(/<[^>]*>|[^<]+/g)??[];requireThat(tokens.join('')===source);
 for(const token of tokens){if(token.startsWith('</')){requireThat(stack.length>1&&token===`</${stack.at(-1)!.name}>`);stack.pop();}
 else if(token.startsWith('<')){const m=/^<([A-Za-z][A-Za-z0-9]*)(?:\s+[^<>]*)?(\/?)>$/.exec(token);requireThat(m&&++nodes<=50000&&stack.length<32);const node:Xml={name:m[1]!,text:'',children:[]};stack.at(-1)!.children.push(node);if(!m[2])stack.push(node);}
 else{requireThat(!/&(?!(?:amp|lt|gt|quot|apos);)/.test(token));stack.at(-1)!.text+=token.replace(/&(amp|lt|gt|quot|apos);/g,(_,s:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[s]!);}}
 requireThat(stack.length===1&&root.children.length===1&&!root.text.trim());return root.children[0]!;
}
const child=(n:Xml,key:string)=>n.children.find(c=>c.name===key);
const value=(n:Xml,key:string)=>child(n,key)?.text??'';
const items=(n:Xml|undefined)=>n?.children.filter(c=>c.name==='item')??[];
export function createExternalProviderTransport(options:ExternalProviderOptions):GuardedExternalProviderTransport<ExternalProviderCredential>{
 // Snapshot trusted configuration: later caller mutation cannot change an in-flight target.
 const config={enabled:options.enabled,aws:options.aws?structuredClone(options.aws):undefined,hf:options.hf?{...structuredClone({...options.hf,lfs:undefined}),lfs:options.hf.lfs}:undefined,github:options.github?structuredClone(options.github):undefined};
 const now=options.now??Date.now,fetcher=options.fetch??globalThis.fetch;
 const dispatch=new AsyncLocalStorage<ExternalDispatchAuthority & {expiresAt:number}>();
 const guardArn=options.awsTtlGuard?.guardArn,guardPort=options.awsTtlGuard?.port;
 const attest=guardPort?.attest.bind(guardPort),arm=guardPort?.arm.bind(guardPort);
 const loadArtifact=options.artifacts.load.bind(options.artifacts);
 const s3:ExternalS3Transport|undefined=options.s3?createExternalS3Transport({enabled:options.enabled===true&&options.s3.enabled===true,target:options.s3.target,fetch:fetcher,now,
  loadFiles:async i=>{const artifact=await loadArtifact(externalS3PutOf(i).parameters.artifactDigest);return structuredClone(artifact.files);}}):undefined;
 const readCost=options.costReader?.read.bind(options.costReader),quoteCost=options.costReader?.quote.bind(options.costReader);
 const forbiddenValues=[...(options.forbiddenValues??[])];
 requireThat(forbiddenValues.length<=256&&forbiddenValues.every(v=>typeof v==='string'&&Buffer.byteLength(v)<=262144));
 function active(){const authority=dispatch.getStore();authority?.signal.throwIfAborted();authority?.assertActive();}
 async function phase<T>(work:(signal:AbortSignal)=>Promise<T>,timeoutMs:number,expiresAt?:number,authority?:ExternalDispatchAuthority):Promise<T>{
  authority?.signal.throwIfAborted();authority?.assertActive();if(expiresAt!==undefined)requireThat(now()<expiresAt);
  const controller=new AbortController();
  const signal=authority?AbortSignal.any([controller.signal,authority.signal]):controller.signal;
  let abort:()=>void=()=>{};const timer=setTimeout(()=>controller.abort(),Math.min(timeoutMs,expiresAt===undefined?timeoutMs:Math.max(1,expiresAt-now())));
  try{return await Promise.race([work(signal),new Promise<never>((_,reject)=>{abort=()=>reject(unavailable());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 function step<T>(work:(signal:AbortSignal)=>Promise<T>,expiresAt:number,timeoutMs=TIMEOUT_MS):Promise<T>{return phase(work,timeoutMs,expiresAt,dispatch.getStore());}
 function gate(i:ExternalInvocation,c:ExternalProviderCredential,execute=false){
  requireThat(i.profile.provider!=='s3'&&config.enabled===true&&i.profile.enabled===true&&c.provider===i.profile.provider&&config[i.profile.provider]?.enabled===true);
  requireThat(i.profile.operations.includes(i.operation as never));text(i.ownershipToken);text(i.idempotencyKey);text(i.actionId);requireThat(/^[a-f0-9]{64}$/.test(i.parametersHash));
  requireThat(externalParametersHash(i.profile,i.operation,i.parameters)===i.parametersHash);
  requireThat(Number.isSafeInteger(i.expiresAt)&&(!execute||now()<i.expiresAt));
  if(c.provider==='aws'){text(c.accessKeyId,128);text(c.secretAccessKey,4096);if(c.sessionToken!==undefined)text(c.sessionToken,8192);
   const a=config.aws!,target=record(i.profile.target);requireThat(/^\d{12}$/.test(a.accountId)&&/^[a-z]{2}-[a-z]+-\d$/.test(a.region)&&/^[A-Za-z0-9_.-]{1,128}$/.test(a.workloadId));
   requireThat(target.accountId===a.accountId&&target.region===a.region&&target.workloadId===a.workloadId);
   requireThat(/^ami-[a-f0-9]+$/.test(a.imageId)&&/^subnet-[a-f0-9]+$/.test(a.subnetId)&&/^[a-z0-9]+\.[a-z0-9]+$/.test(a.instanceType)&&a.instanceProfileArn.startsWith(`arn:aws:iam::${a.accountId}:instance-profile/`));text(a.instanceProfileArn,256);
   requireThat(Number.isSafeInteger(a.maxLifetimeMs)&&a.maxLifetimeMs>0);
  }else{ text(c.token,8192);const cfg=config[c.provider]!,target=record(i.profile.target);repository(cfg.repository);requireThat(target.repository===cfg.repository);
   if(c.provider==='hf'){const hf=config.hf!;ref(hf.revision);requireThat(target.revision===hf.revision&&resolveHfVisibility(target.visibility)===resolveHfVisibility(hf.visibility));}else{const gh=config.github!;ref(gh.branch);requireThat(target.branch===gh.branch);}}
 }
 async function http(url:string,method:string,headers:Record<string,string>,body?:string,expiresAt?:number,observeHeaders?:(headers:Headers)=>void):Promise<string>{
  expiresAt??=dispatch.getStore()?.expiresAt;
  requireThat(Buffer.byteLength(body??'')<=3*MAX_BODY);const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const signal=dispatch.getStore()?AbortSignal.any([controller.signal,dispatch.getStore()!.signal]):controller.signal;
  const operation=async()=>{
   if(expiresAt!==undefined)requireThat(now()<expiresAt);
   active();const response=await fetcher(url,{method,headers,body,redirect:'error',signal});requireThat(response.ok&&!response.redirected);observeHeaders?.(response.headers);
   const length=response.headers.get('content-length');if(length!==null)requireThat(/^\d+$/.test(length)&&Number(length)<=MAX_BODY);
   const reader=response.body?.getReader();requireThat(reader);const chunks:Uint8Array[]=[];let bytes=0;
   try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw unavailable();}chunks.push(part.value);}}finally{reader.releaseLock();}
   return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  };
  let abort:()=>void=()=>{};
  try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{abort=()=>reject(unavailable());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();timer=setTimeout(()=>controller.abort(),Math.min(TIMEOUT_MS,expiresAt===undefined?TIMEOUT_MS:Math.max(1,expiresAt-now())));})]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 async function json(url:string,method:string,c:Extract<ExternalProviderCredential,{token:string}>,body?:unknown,expiresAt?:number):Promise<unknown>{
  return JSON.parse(await http(url,method,{authorization:`Bearer ${c.token}`,accept:'application/json','content-type':'application/json','user-agent':'hivemind-external/1','x-github-api-version':'2022-11-28'},body===undefined?undefined:JSON.stringify(body),expiresAt));
 }
 async function artifact(i:ExternalInvocation,c:ExternalProviderCredential){
  const values=[...forbiddenValues,...(c.provider==='aws'?[c.accessKeyId,c.secretAccessKey,c.sessionToken??'']:[c.token])].filter(v=>Buffer.byteLength(v)>=8).map(v=>Buffer.from(v));
  const noSecrets=(bytes:Buffer)=>requireThat(!values.some(v=>bytes.includes(v)));
  noSecrets(Buffer.from(JSON.stringify(i.parameters)));
  if('message' in i.parameters)noSecrets(Buffer.from(i.parameters.message));
  const p=record(i.parameters);requireThat(typeof p.artifactDigest==='string'&&/^[a-f0-9]{64}$/.test(p.artifactDigest));
  const a=await (dispatch.getStore()?step(()=>loadArtifact(p.artifactDigest as string),i.expiresAt):loadArtifact(p.artifactDigest));active();fields(a,['files']);requireThat(Array.isArray(a.files)&&a.files.length>0&&a.files.length<=32);
  validateExternalArtifact(a,values.map(v=>v.toString()));
  requireThat(externalArtifactDigest(a)===p.artifactDigest);return structuredClone(a.files);
 }
 function receipt(i:ExternalInvocation,evidenceId:string,effect:ExternalProviderReceipt['effect'],resource?:ExternalResource):ExternalProviderReceipt{
  text(evidenceId,256);return {ownershipToken:i.ownershipToken,idempotencyKey:i.idempotencyKey,evidenceId,outcome:'succeeded',effect,...(resource?{resource}:{}),billing:{verifiedCostMicros:null,final:false}};
 }
 async function awsQuery(action:string,parameters:Record<string,string>,c:Extract<ExternalProviderCredential,{provider:'aws'}>,expiresAt?:number,service='ec2'):Promise<Xml>{
  const a=config.aws!,host=`${service}.${a.region}.amazonaws.com`,date=new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
  const body=new URLSearchParams({Action:action,Version:service==='sts'?'2011-06-15':'2016-11-15',...parameters}).toString();
  const h:Record<string,string>={'content-type':'application/x-www-form-urlencoded',host,'x-amz-date':date};if(c.sessionToken)h['x-amz-security-token']=c.sessionToken;
  const names=Object.keys(h).sort(),canonical=names.map(k=>`${k}:${h[k]!.trim()}\n`).join(''),signed=names.join(';');
  const scope=`${day}/${a.region}/${service}/aws4_request`,request=`POST\n/\n\n${canonical}\n${signed}\n${sha256(body)}`;
  const hmac=(key:string|Uint8Array,s:string)=>createHmac('sha256',key).update(s).digest();
  const key=hmac(hmac(hmac(hmac('AWS4'+c.secretAccessKey,day),a.region),service),'aws4_request');
  h.authorization=`AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac('sha256',key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(request)}`).digest('hex')}`;
  const result=xml(await http(`https://${host}/`,'POST',h,body,expiresAt));requireThat(result.name===action+'Response');if(service==='ec2'){const requestId=value(result,'requestId');requireThat(/^[A-Za-z0-9-]{1,128}$/.test(requestId));}return result;
 }
 async function account(c:Extract<ExternalProviderCredential,{provider:'aws'}>,expiresAt?:number){
  const result=await awsQuery('GetCallerIdentity',{},c,expiresAt,'sts'),identity=child(result,'GetCallerIdentityResult');requireThat(identity&&value(identity,'Account')===config.aws!.accountId);const arn=value(identity,'Arn');requireThat(arn.startsWith(`arn:aws:iam::${config.aws!.accountId}:`)||arn.startsWith(`arn:aws:sts::${config.aws!.accountId}:`));
 }
 function ownership(i:ExternalInvocation){
  if(i.operation==='aws.spot.inspect'){fields(i.parameters,['startActionId']);requireThat(i.ownedResource&&i.ownedResource.actionId===(i.parameters as {startActionId:string}).startActionId);return i.ownedResource;}
  return i;
 }
 function guardRequest(i:ExternalInvocation):AwsTtlGuardRequest {
  const a=config.aws!;
  return {accountId:a.accountId,region:a.region,workloadId:a.workloadId,actionId:i.actionId,ownershipToken:i.ownershipToken,clientToken:sha256(i.idempotencyKey),parametersHash:i.parametersHash,expiresAt:i.expiresAt,maxExposureMicros:i.profile.upperBoundMicros,configurationHash:externalAwsConfigurationHash(a)};
 }
 function ttlTags(i:ExternalInvocation,tags:Map<string,string>){
  const a=config.aws!,bindingHash=sha256(JSON.stringify(guardRequest(i))),timer=tags.get('hivemind:timer')??'';
  requireThat(guardArn&&guardArn.startsWith(`arn:aws:events:${a.region}:${a.accountId}:rule/`)&&tags.get('hivemind:guard')===guardArn&&tags.get('hivemind:owner')===i.ownershipToken&&tags.get('hivemind:request')===sha256(i.idempotencyKey)&&tags.get('hivemind:workload')===a.workloadId&&tags.get('hivemind:parameters')===i.parametersHash&&tags.get('hivemind:expires')===String(i.expiresAt));
  const prefix=`arn:aws:scheduler:${a.region}:${a.accountId}:schedule/`,suffix='/hm-'+bindingHash.slice(0,48);
  requireThat(timer.startsWith(prefix)&&timer.endsWith(suffix)&&/^[A-Za-z0-9_.-]{1,64}$/.test(timer.slice(prefix.length,-suffix.length)));
 }
 function resourceScope(i:ExternalInvocation,r:ExternalResource){
  requireThat(i.operation==='aws.spot.start'&&r.cleanupRequired===true&&/^i-[a-f0-9]{8,32}$/.test(r.id));
  if(i.ownedResource)requireThat(i.ownedResource.id===r.id&&i.ownedResource.actionId===i.actionId&&i.ownedResource.ownershipToken===i.ownershipToken&&i.ownedResource.idempotencyKey===i.idempotencyKey);
 }
 async function discover(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{provider:'aws'}>,resource?:ExternalResource){
  const owner=ownership(i);text(owner.ownershipToken);text(owner.idempotencyKey);
  if(resource)requireThat(/^i-[a-f0-9]{8,32}$/.test(resource.id));
  const params:Record<string,string>=resource?{'InstanceId.1':resource.id}:{'Filter.1.Name':'tag:hivemind:owner','Filter.1.Value.1':owner.ownershipToken,'Filter.2.Name':'client-token','Filter.2.Value.1':sha256(owner.idempotencyKey)};
  await account(c);const doc=await awsQuery('DescribeInstances',params,c);requireThat(child(doc,'reservationSet')&&!value(doc,'nextToken'));
  const found:{id:string;state:string;tags:Map<string,string>}[]=[];
  for(const reservation of items(child(doc,'reservationSet')))for(const instance of items(child(reservation,'instancesSet'))){
   const tags=new Map(items(child(instance,'tagSet')).map(t=>[value(t,'key'),value(t,'value')]));
   requireThat(value(reservation,'ownerId')===config.aws!.accountId&&value(instance,'clientToken')===sha256(owner.idempotencyKey)&&tags.get('hivemind:owner')===owner.ownershipToken&&tags.get('hivemind:request')===sha256(owner.idempotencyKey)&&tags.get('hivemind:workload')===config.aws!.workloadId);
   if(i.operation!=='aws.spot.inspect')requireThat(tags.get('hivemind:parameters')===i.parametersHash);
   const id=value(instance,'instanceId'),state=value(child(instance,'instanceState')??instance,'name');requireThat(/^i-[a-f0-9]{8,32}$/.test(id)&&['pending','running','shutting-down','terminated','stopping','stopped'].includes(state)&&(!resource||id===resource.id));found.push({id,state,tags});
  }
  requireThat(found.length<=1);return {found,evidence:value(doc,'requestId')};
 }
 async function volumeInventory(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{provider:'aws'}>){
  const owner=ownership(i),doc=await awsQuery('DescribeVolumes',{'Filter.1.Name':'tag:hivemind:owner','Filter.1.Value.1':owner.ownershipToken,'Filter.2.Name':'tag:hivemind:request','Filter.2.Value.1':sha256(owner.idempotencyKey),'Filter.3.Name':'tag:hivemind:workload','Filter.3.Value.1':config.aws!.workloadId},c);
  requireThat(child(doc,'volumeSet')&&!value(doc,'nextToken'));
  const rows=items(child(doc,'volumeSet'));requireThat(rows.length<=32);
  const seen=new Set<string>();
  return rows.map(row=>{
   for(const name of ['volumeId','status','attachmentSet','tagSet'])requireThat(row.children.filter(n=>n.name===name).length===1);
   const id=value(row,'volumeId'),state=value(row,'status'),attachments=child(row,'attachmentSet')!;
   requireThat(/^vol-[a-f0-9]{8,32}$/.test(id)&&!seen.has(id)&&['creating','available','in-use','deleting','deleted','error'].includes(state)&&attachments.children.every(n=>n.name==='item'));seen.add(id);
   const entries=items(child(row,'tagSet')).map(t=>[value(t,'key'),value(t,'value')] as const),tags=new Map(entries);requireThat(tags.size===entries.length);ttlTags(i,tags);
   requireThat(state!=='deleted'||attachments.children.length===0);
   return {id,state,attached:attachments.children.length>0};
  });
 }
 async function volumes(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{provider:'aws'}>):Promise<boolean>{return (await volumeInventory(i,c)).every(v=>v.state==='deleted');}
 async function awsInspect(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{provider:'aws'}>,reconcile=false):Promise<ExternalProviderReceipt|null>{
  const known=i.operation==='aws.spot.start'?i.ownedResource:undefined;
  if(known)requireThat(known.actionId===i.actionId&&known.ownershipToken===i.ownershipToken&&known.idempotencyKey===i.idempotencyKey);
  const d=await discover(i,c,i.operation==='aws.spot.inspect'?i.ownedResource:known),instance=d.found[0];if(!instance&&!known)return null;
  const id=instance?.id??known!.id;
  const result=receipt(i,`aws:${d.evidence}:${id}`,i.operation==='aws.spot.inspect'?'none':'resource',i.operation==='aws.spot.inspect'?undefined:{id,cleanupRequired:true});
  if(reconcile&&i.operation==='aws.spot.start'&&(!instance||instance.state==='terminated')&&await volumes(i,c)&&readCost){
   // Read-only recovery is allowed after action expiry. This independent 15s cap
   // does not renew a model lease or authorize another resource mutation.
   const cost=await phase(()=>readCost(i,{resourceConfirmedAbsent:true,observedStoppedAt:now()}),COST_TIMEOUT_MS);
   requireThat((cost.verifiedCostMicros===null||Number.isSafeInteger(cost.verifiedCostMicros)&&cost.verifiedCostMicros>=0)&&typeof cost.final==='boolean'&&(!cost.final||cost.verifiedCostMicros!==null&&typeof cost.evidenceId==='string'));
   result.billing={verifiedCostMicros:cost.verifiedCostMicros,final:cost.final};if(cost.evidenceId){text(cost.evidenceId);result.evidenceId=cost.evidenceId;}
  }
  return result;
 }
 async function hfProof(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{token:string}>,files:ExternalArtifact['files'],expected?:string){
  const cfg=config.hf!,base=`https://huggingface.co/api/models/${repository(cfg.repository)}`;
  const commits=await json(`${base}/commits/${ref(cfg.revision)}`,'GET',c);requireThat(Array.isArray(commits)&&commits.length<=100);
  const commit=commits.map(record).find(r=>r.title===mark(i)&&(expected===undefined||r.id===expected));if(!commit)return null;hashId(commit.id);
  const info=record(await json(`${base}/revision/${commit.id}?blobs=true`,'GET',c));assertHfVisibility(info,resolveHfVisibility(cfg.visibility));requireThat(info.sha===commit.id&&Array.isArray(info.siblings));
  for(const f of files){const file=info.siblings.map(record).find(s=>s.rfilename===f.path);requireThat(file&&file.blobId===gitBlob(Buffer.from(f.contentBase64,'base64')));}
  return receipt(i,'hf:'+commit.id,'retained');
 }
 function ghBase(){return `https://api.github.com/repos/${repository(config.github!.repository)}`;}
 async function ghProof(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{token:string}>,files:ExternalArtifact['files'],oid:string){
  hashId(oid);const commit=record(await json(`${ghBase()}/git/commits/${oid}`,'GET',c));requireThat(commit.sha===oid&&commit.message===mark(i)&&Array.isArray(commit.parents)&&commit.parents.length===1&&record(commit.parents[0]).sha===record(i.parameters).expectedHead);
  const treeId=record(commit.tree).sha;hashId(treeId);const tree=record(await json(`${ghBase()}/git/trees/${treeId}?recursive=1`,'GET',c));requireThat(tree.sha===treeId&&tree.truncated===false&&Array.isArray(tree.tree));
  for(const f of files){const file=tree.tree.map(record).find(t=>t.path===f.path);requireThat(file&&file.mode==='100644'&&file.type==='blob'&&file.sha===gitBlob(Buffer.from(f.contentBase64,'base64')));}
  const expectedHead=record(i.parameters).expectedHead;hashId(expectedHead);
  const parent=record(await json(`${ghBase()}/git/commits/${expectedHead}`,'GET',c));requireThat(parent.sha===expectedHead);const baseId=record(parent.tree).sha;hashId(baseId);
  const base=record(await json(`${ghBase()}/git/trees/${baseId}?recursive=1`,'GET',c));requireThat(base.sha===baseId&&base.truncated===false&&Array.isArray(base.tree));
  const leaves=(entries:unknown[])=>{const map=new Map<string,string>();for(const raw of entries){const e=record(raw);text(e.path,1024);if(e.type==='tree')continue;requireThat((e.type==='blob'||e.type==='commit')&&typeof e.mode==='string'&&/^[0-9]{6}$/.test(e.mode));hashId(e.sha);requireThat(!map.has(e.path));map.set(e.path,`${e.mode}:${e.type}:${e.sha}`);}return map;};
  const expected=leaves(base.tree),actual=leaves(tree.tree);
  for(const f of files)expected.set(f.path,`100644:blob:${gitBlob(Buffer.from(f.contentBase64,'base64'))}`);
  requireThat(expected.size===actual.size&&[...expected].every(([path,v])=>actual.get(path)===v));
  return receipt(i,'github:'+oid,'retained');
 }
 async function head(c:Extract<ExternalProviderCredential,{token:string}>){const obj=record(await json(`${ghBase()}/git/ref/heads/${ref(config.github!.branch)}`,'GET',c));const id=record(obj.object).sha;hashId(id);return id;}
 async function ttlProof(i:ExternalInvocation):Promise<AwsOwnershipTimerEvidence>{
  const a=config.aws!;
  requireThat(guardArn&&attest&&arm&&guardArn.startsWith(`arn:aws:events:${a.region}:${a.accountId}:rule/`));
  requireThat(a.credentialRef===i.profile.credentialRef&&Number.isSafeInteger(a.maxUpperBoundMicros)&&a.maxUpperBoundMicros!>0&&i.profile.upperBoundMicros>0&&i.profile.upperBoundMicros<=a.maxUpperBoundMicros!);
  const request=guardRequest(i);
  const bindingHash=sha256(JSON.stringify(request));active();
  const guard=await step(signal=>attest(structuredClone(request),signal),i.expiresAt,ATTEST_TIMEOUT_MS);active();
  fields(guard,['kind','guardArn','evidenceId','bindingHash','installedAt','observedAt','validUntil','maxExposureMicros']);
  requireThat(guard.kind==='preexisting_termination_guard'&&guard.guardArn===guardArn&&guard.bindingHash===bindingHash);text(guard.evidenceId);
  requireThat([guard.installedAt,guard.observedAt,guard.validUntil,guard.maxExposureMicros].every(Number.isSafeInteger)&&guard.installedAt>=0&&guard.installedAt<=guard.observedAt&&guard.observedAt<=now()&&guard.observedAt>=now()-60000&&guard.validUntil>=i.expiresAt&&guard.maxExposureMicros>0&&guard.maxExposureMicros<=i.profile.upperBoundMicros);
  const timer=await step(signal=>arm(structuredClone(request),structuredClone(guard),signal),i.expiresAt,ARM_TIMEOUT_MS);active();
  fields(timer,['kind','guardArn','timerArn','evidenceId','bindingHash','expiresAt']);text(timer.evidenceId);text(timer.timerArn);
  requireThat(timer.kind==='owned_expiry_timer'&&timer.guardArn===guardArn&&timer.timerArn.startsWith(`arn:aws:scheduler:${a.region}:${a.accountId}:schedule/`)&&timer.bindingHash===bindingHash&&timer.expiresAt===i.expiresAt&&now()<i.expiresAt);
  return timer;
 }
 
 /** hf.model.lfs_commit: the manifest is loaded, validated and bound to the approved digest before any request. */
 async function lfsContext(i:ExternalInvocation,c:Extract<ExternalProviderCredential,{token:string}>){
  const hf=config.hf!,lfs=hf.lfs;requireThat(lfs&&i.operation==='hf.model.lfs_commit'&&c.provider==='hf');
  const p=record(i.parameters);fields(p,['manifestDigest','message']);requireThat(typeof p.manifestDigest==='string'&&/^[a-f0-9]{64}$/.test(p.manifestDigest)&&typeof p.message==='string');
  const secrets=[...forbiddenValues,c.token].filter(v=>Buffer.byteLength(v)>=8).map(v=>Buffer.from(v)),bytes=Buffer.from(JSON.stringify(i.parameters));
  requireThat(!secrets.some(v=>bytes.includes(v)));
  const loaded=await lfs!.loadManifest(p.manifestDigest as string,structuredClone(i));active();
  const manifest=validateExternalLargeManifest(loaded,lfs!.limits);
  requireThat(externalLargeManifestDigest(manifest)===p.manifestDigest&&manifest.taskId===i.taskId&&manifest.revision===i.revision&&manifest.profileId===i.profile.id);
  const options:HfLfsOptions={repository:hf.repository,revision:hf.revision,message:p.message as string,visibility:hf.visibility,fetch:fetcher,now,signal:dispatch.getStore()?.signal,uploadHosts:lfs!.uploadHosts,open:file=>lfs!.open(file,structuredClone(i))};
  return {manifest,options};
 }
 async function execute(i:ExternalInvocation,c:ExternalProviderCredential){
  gate(i,c,true);
  if(c.provider==='aws'){
   if(i.operation==='aws.spot.inspect'){const r=await awsInspect(i,c);requireThat(r);return r;}
   requireThat(i.operation==='aws.spot.start');fields(i.parameters,['lifetimeMs']);const ttl=record(i.parameters).lifetimeMs;requireThat(Number.isSafeInteger(ttl)&&Number(ttl)>0&&Number(ttl)<=config.aws!.maxLifetimeMs&&Number(ttl)<=i.profile.maxLifetimeMs);
   requireThat(config.aws!.billingPolicy==='reserved_ceiling_only'||config.aws!.billingPolicy==='verified_cost_source');
   if(config.aws!.billingPolicy==='verified_cost_source'||readCost){const quote=quoteCost?.(i);requireThat(quote&&Number.isSafeInteger(quote.resourceUpperBoundMicros)&&quote.resourceUpperBoundMicros>=0&&Number.isSafeInteger(quote.maximumQueryFeeMicros)&&quote.maximumQueryFeeMicros>=0&&Number.isSafeInteger(quote.resourceUpperBoundMicros+quote.maximumQueryFeeMicros)&&quote.resourceUpperBoundMicros+quote.maximumQueryFeeMicros<=i.profile.upperBoundMicros);}
   requireThat(i.expiresAt-now()<=Number(ttl));const timer=await ttlProof(i);
   const a=config.aws!,params:Record<string,string>={ImageId:a.imageId,InstanceType:a.instanceType,SubnetId:a.subnetId,'IamInstanceProfile.Arn':a.instanceProfileArn,MinCount:'1',MaxCount:'1',ClientToken:sha256(i.idempotencyKey),'InstanceMarketOptions.MarketType':'spot','InstanceMarketOptions.SpotOptions.SpotInstanceType':'one-time','InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior':'terminate','MetadataOptions.HttpTokens':'required','TagSpecification.1.ResourceType':'instance'};
   for(const [index,[key,val]] of [['hivemind:owner',i.ownershipToken],['hivemind:request',sha256(i.idempotencyKey)],['hivemind:parameters',i.parametersHash],['hivemind:workload',a.workloadId],['hivemind:expires',String(i.expiresAt)],['hivemind:guard',timer.guardArn],['hivemind:timer',timer.timerArn]].entries()){params[`TagSpecification.1.Tag.${index+1}.Key`]=key!;params[`TagSpecification.1.Tag.${index+1}.Value`]=val!;}
   params['TagSpecification.2.ResourceType']='volume';for(let n=1;n<=7;n++){params[`TagSpecification.2.Tag.${n}.Key`]=params[`TagSpecification.1.Tag.${n}.Key`]!;params[`TagSpecification.2.Tag.${n}.Value`]=params[`TagSpecification.1.Tag.${n}.Value`]!;}
   await account(c,i.expiresAt);await awsQuery('RunInstances',params,c,i.expiresAt);const r=await awsInspect(i,c);requireThat(r);return r;
  }
  if(c.provider==='hf'&&i.operation==='hf.model.lfs_commit'){
   const {manifest,options:o}=await lfsContext(i,c),result=await hfLfsCommit(i,c.token,manifest,o);
   return receipt(i,'hf:'+result.commitOid,'retained');
  }
  const files=await artifact(i,c);
  if(c.provider==='hf'){
   requireThat(i.operation==='hf.model.commit');fields(i.parameters,['artifactDigest','message']);text(record(i.parameters).message,512);
   const cfg=config.hf!,base=`https://huggingface.co/api/models/${repository(cfg.repository)}`,info=record(await json(`${base}/revision/${ref(cfg.revision)}?blobs=true`,'GET',c));assertHfVisibility(info,resolveHfVisibility(cfg.visibility));hashId(info.sha);
   const prior=await hfProof(i,c,files);if(prior)return prior;
   const payload=[{key:'header',value:{summary:mark(i),description:record(i.parameters).message,parentCommit:info.sha}},...files.map(f=>({key:'file',value:{path:f.path,content:f.contentBase64,encoding:'base64'}}))].map(x=>JSON.stringify(x)).join('\n')+'\n';
   const response=record(JSON.parse(await http(`${base}/commit/${ref(cfg.revision)}`,'POST',{authorization:`Bearer ${c.token}`,'content-type':'application/x-ndjson'},payload,i.expiresAt)));hashId(response.commitOid);const proof=await hfProof(i,c,files,response.commitOid);requireThat(proof);return proof;
  }
  requireThat(i.operation==='github.branch.push');fields(i.parameters,['artifactDigest','expectedHead']);const expected=record(i.parameters).expectedHead;hashId(expected);requireThat(await head(c)===expected);
  const response=record(await json('https://api.github.com/graphql','POST',c,{
   query:'mutation HivemindCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
   variables:{input:{branch:{repositoryNameWithOwner:config.github!.repository,branchName:config.github!.branch},expectedHeadOid:expected,message:{headline:mark(i)},fileChanges:{additions:files.map(f=>({path:f.path,contents:f.contentBase64}))}}}},i.expiresAt));
  requireThat(!Object.hasOwn(response,'errors'));
  const mutation=record(record(response.data).createCommitOnBranch),oid=record(mutation.commit).oid;hashId(oid);
  return ghProof(i,c,files,oid);
 }
 return {
  async execute(i,c,authority){try{
   if(i.profile.provider==='s3'){requireThat(s3);
    // Like aws.spot.inspect, an inspect action is dispatched through execute and must resolve to a receipt.
    if(i.operation==='aws.s3.inspect'){const found=await s3!.inspect(i,c);requireThat(found);return found;}
    return await s3!.execute(i,c,authority);}
   const guard=authority??{signal:new AbortController().signal,assertActive(){requireThat(now()<i.expiresAt);}};
   return await dispatch.run({signal:guard.signal,assertActive:()=>guard.assertActive(),expiresAt:i.expiresAt},()=>execute(i,c));
  }catch{throw unavailable();}},
  async inspect(i,c){try{
   if(i.profile.provider==='s3'){requireThat(s3);return await s3!.inspect(i,c);}
   gate(i,c);if(c.provider==='aws')return await awsInspect(i,c,true);
   if(c.provider==='hf'&&i.operation==='hf.model.lfs_commit'){const {manifest,options:o}=await lfsContext(i,c),proof=await hfLfsProof(i,c.token,manifest,o);return proof?receipt(i,'hf:'+proof.commitOid,'retained'):null;}
   const files=await artifact(i,c);if(c.provider==='hf')return await hfProof(i,c,files);
   const bindingHash=externalRecoveryBinding(i);
   const cursor=i.providerRecoveryCursor===undefined?undefined:parseExternalRecoveryCursor(i.providerRecoveryCursor,bindingHash);
   const anchor=cursor?.head??await head(c),page=cursor?.page??1;
   const url=`${ghBase()}/commits?sha=${anchor}&per_page=100&page=${page}`;
   let nextPage:number|undefined;
   const commits=JSON.parse(await http(url,'GET',{authorization:`Bearer ${c.token}`,accept:'application/json','user-agent':'hivemind-external/1','x-github-api-version':'2022-11-28'},undefined,undefined,headers=>{
    const link=headers.get('link');if(link===null)return;requireThat(link.length<=8192);
    for(const entry of link.split(',')){
     const match=/^\s*<([^<>]+)>;\s*rel="([a-z ]+)"\s*$/.exec(entry);requireThat(match);
     if(!match[2]!.split(' ').includes('next'))continue;
     requireThat(nextPage===undefined&&page<1000000);
     const expected=`${ghBase()}/commits?sha=${anchor}&per_page=100&page=${page+1}`;
     const candidate=new URL(match[1]!);const fixed=new URL(expected);
     requireThat(candidate.origin===fixed.origin&&candidate.pathname===fixed.pathname&&!candidate.username&&!candidate.password&&!candidate.hash);
     requireThat([...candidate.searchParams].length===3&&['sha','per_page','page'].every(k=>candidate.searchParams.getAll(k).length===1&&candidate.searchParams.get(k)===fixed.searchParams.get(k)));
     nextPage=page+1;
    }
   }));
   requireThat(Array.isArray(commits)&&commits.length<=100);
   const commit=commits.map(record).find(v=>record(v.commit).message===mark(i));
   if(commit){hashId(commit.sha);return await ghProof(i,c,files,commit.sha);}
   return {state:'pending' as const,cursor:nextPage===undefined?null:JSON.stringify({version:1,bindingHash,head:anchor,page:nextPage})};
  }catch{return null;}},
  async cleanup(i,r,c){try{
   gate(i,c);requireThat(c.provider==='aws');resourceScope(i,r);const d=await discover(i,c,r),instance=d.found[0];
   if(instance){ttlTags(i,instance.tags);if(instance.state!=='terminated'){await awsQuery('TerminateInstances',{'InstanceId.1':r.id},c);return;}}
   else requireThat(i.ownedResource);
   const rows=await volumeInventory(i,c);if(rows.some(v=>v.state!=='deleted'&&(v.state!=='available'||v.attached)))return;
   // A bounded batch, no detach, no blind retry. EC2 also rejects deleting in-use volumes.
   for(const candidate of rows.filter(v=>v.state==='available').slice(0,2)){
    const fresh=(await volumeInventory(i,c)).find(v=>v.id===candidate.id);if(!fresh||fresh.state==='deleted')continue;
    if(fresh.state!=='available'||fresh.attached)return;
    const deleted=await awsQuery('DeleteVolume',{VolumeId:fresh.id},c);requireThat(value(deleted,'return')==='true');
   }
  }catch{throw unavailable();}},
  async confirmAbsent(i,r,c){try{
   gate(i,c);if(c.provider!=='aws')return false;resourceScope(i,r);const d=await discover(i,c,r),instance=d.found[0];
   if(instance){ttlTags(i,instance.tags);if(instance.state!=='terminated')return false;}else requireThat(i.ownedResource);
   return await volumes(i,c);
  }catch{return false;}}
 };
}
