import {workloadFingerprint,inputManifestDigest} from '../../../packages/core/src/delegated.ts';
import {parseDelegatedConfiguration,assertDelegatedLaunchAdmission} from './delegated-runtime.ts';
import {createCanonicalOidcAuthority,createOidcAuditStore,parseExternalOidcSettings,type ExternalOidcSettings} from './autonomous-oidc-runtime.ts';
import {createAwsWebIdentityResolver,awsOidcTargetHash,type AwsScopedCredentialControl} from '../../../packages/adapters/src/aws-web-identity.ts';
import {oidcSubject} from '../../../packages/core/src/oidc.ts';
import type {OidcSignerPort} from '../../../packages/contracts/src/oidc.ts';
import type {AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
import {assertAwsRegion,awsPlacement} from '../../../packages/adapters/src/autonomous-aws-region.ts';
import {createAwsCostExplorerReader,createExternalCostCache,type AwsCostExplorerOptions,type ExternalCostReader} from '../../../packages/adapters/src/autonomous-external-cost.ts';
import {createAwsTtlGuardPort,type AwsGuardOptions} from '../../../packages/adapters/src/autonomous-aws-guard.ts';
import {createHash} from 'node:crypto';
import {validateExternalS3Target} from '../../../packages/core/src/autonomous-external-s3.ts';
import {createExternalLargeStore,type ExternalLargeBucket,type ExternalLargeStore} from '../../../packages/adapters/src/autonomous-external-large-store.ts';
import {createExternalLargeRecordPort} from '../../../packages/adapters/src/autonomous-external-large-sql.ts';
import type {ExternalLargeLimits,ExternalLargeManifest} from '../../../packages/contracts/src/autonomous-external-large.js';
import type {ExternalS3Target} from '../../../packages/contracts/src/autonomous-external-s3.js';
import {createExternalCostWatch} from '../../../packages/core/src/autonomous-external-cost-watch.ts';
import {ExternalBroker,type GuardedExternalProviderTransport} from '../../../packages/core/src/autonomous-external.ts';
import {createExternalSqlStore,type ExternalSqlPort} from '../../../packages/core/src/autonomous-external-sql.ts';
import {createAutonomousExternalService,type AutonomousExternalService} from '../../../apps/control-plane/src/autonomous-external-api.ts';
import type {AutonomousApiService} from '../../../apps/control-plane/src/autonomous-api.ts';
import type {ExternalProfile,ExternalCredentialScope,ExternalInvocation} from '../../../packages/contracts/src/autonomous-external.ts';
import {createExternalProviderTransport,createExternalR2ArtifactLoader,createExternalR2ArtifactPublisher,type ExternalArtifactPublisher,type ExternalArtifactLoader,type ExternalProviderCredential,type ExternalProviderOptions,type ExternalHfLfsConfig,type AwsTtlGuardPort} from '../../../packages/adapters/src/autonomous-external.ts';

export interface ExternalEnvironment {
 AUTONOMOUS_DELEGATED_CONFIG?:string;AUTONOMOUS_DELEGATED_ENABLED?:string;
 AUTONOMOUS_EXTERNAL_OIDC_CONFIG?:string;
 AUTONOMOUS_EXTERNAL_COST_CONFIG?:string;
 AUTONOMOUS_AWS_GUARD_CONFIG?:string;
 AUTONOMOUS_EXTERNAL_ENABLED?:string;
 AUTONOMOUS_EXTERNAL_CONFIG?:string;
 /** Private Worker secret. JSON {credentialRef:typedCredential}; never returned or logged. */
 AUTONOMOUS_EXTERNAL_CREDENTIALS?:string;
}
export interface ExternalArtifactBucket {
 get(key:string):Promise<{size:number;body:ReadableStream<Uint8Array>}|null>;
 put?(key:string,value:string,options:{onlyIf:{etagDoesNotMatch:string}}):Promise<unknown|null>;
 /** R2 multipart surface. Needed only for large Hugging Face uploads; without it large uploads stay disabled. */
 createMultipartUpload?(key:string):Promise<{uploadId:string}>;
 resumeMultipartUpload?(key:string,uploadId:string):{uploadPart(partNumber:number,data:Uint8Array):Promise<{etag:string}>;complete(parts:{partNumber:number;etag:string}[]):Promise<unknown>;abort():Promise<unknown>};
 delete?(key:string):Promise<unknown>;
}
/** CONFIG schema: {version:1,profiles:[ExternalProfile],providers:{aws?:{
 * enabled,accountId,region,workloadId,imageId,instanceType,subnetId,instanceProfileArn,
 * maxLifetimeMs,credentialRef,maxUpperBoundMicros,billingPolicy},hf?:{enabled,repository,revision},
 * github?:{enabled,repository,branch}},ttlGuard?:{guardArn},credentialPolicyRevision?:string}.
 * Approval binds declared scope/ref/policy, not ephemeral credential bytes. Refreshes
 * of the same binding preserve approval. Native control/encryption keys remain separately pinned.
 * All targets/ARNs are explicit trusted operator configuration. No resource is inferred.
 * Worker publication uses native authority and fixed external-artifacts/<digest> keys.
 * Records are immutable ExternalArtifact JSON, NOT SourceSnapshot or LargeArtifactRef.
 */
/** Raw JSON form of providers.hf.lfs. Functions and limits that need runtime wiring are added later. */
interface ConfiguredLfs {maxFileBytes:number;maxTotalBytes:number;uploadHosts:string[]}
interface ConfiguredProviders {
 aws?:ExternalProviderOptions['aws'];github?:ExternalProviderOptions['github'];
 hf?:{enabled:boolean;repository:string;revision:string;visibility?:'private'|'public';lfs?:ConfiguredLfs};
 s3?:{enabled:boolean;target:ExternalS3Target};
}
interface Configuration {version:1;profiles:ExternalProfile[];providers:ConfiguredProviders;ttlGuard?:{guardArn:string};credentialPolicyRevision?:string}
/** The 's3' provider signs with the same typed credential as 'aws'. */
const credentialKind=(provider:string)=>provider==='s3'?'aws':provider;
const LFS_MAX_FILE_BYTES=5*1024**3,LFS_MAX_TOTAL_BYTES=64*1024**3,LARGE_MAX_FILES=32;
export interface ExternalRuntimeOptions {
 admitDelegated?:(taskId:string,input:{lease:import('../../../packages/contracts/src/autonomous.ts').AutonomousLease;runtimeId:string;profileId:string;launchRequestId:string;inputManifest:unknown})=>Promise<unknown>;
 oidcSigner?:OidcSignerPort;
 env:ExternalEnvironment;core?:AutonomousApiService;sql?:ExternalSqlPort;artifacts?:ExternalArtifactBucket;
 /** Optional trusted fixture port. Production uses AUTONOMOUS_EXTERNAL_CREDENTIALS. */
 secrets?:{get(reference:string):Promise<string|null>};
 extraSecretValues?:readonly string[];
 artifactPublisher?:ExternalArtifactPublisher;
 costReader?:ExternalCostReader;
 awsTtlGuard?:AwsTtlGuardPort;fetch?:typeof fetch;now?:()=>number;
}
export interface AutonomousExternalRuntime {
 enabled:boolean;service:AutonomousExternalService;configurationFingerprint:string;
 /** Large upload wiring for the external-large routes. Absent unless providers.hf.lfs and a multipart bucket are configured. */
 large?:{store:ExternalLargeStore;limits:ExternalLargeLimits};
 /** PRIVATE safety scanner input only. Never include in HTTP/UI/model data. */
 configuredSecretValues():readonly string[];
 /** Private composition ports. Never exposed by HTTP or model tools. */
 withOwnedAwsCredential<T>(taskId:string,revision:number,actionId:string,purpose:'inspect'|'cleanup',consume:(credential:Extract<ExternalProviderCredential,{provider:'aws'}>,control?:AwsScopedCredentialControl)=>Promise<T>):Promise<T>;
 resolveHfToken(reference:string):Promise<string>;
 recover():Promise<{needsWork:boolean;nextWake?:number}>;
 cleanupDue(limit?:number):Promise<{visited:number;needsWork:boolean;nextWake?:number}>;
}
function unavailable():never{throw Object.assign(new Error('External configuration unavailable'),{statusCode:503});}
function object(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)unavailable();
 if(Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k))||required.some(k=>!Object.hasOwn(value,k)))unavailable();return value as Record<string,unknown>;
}
function text(value:unknown,max=256):asserts value is string{if(typeof value!=='string'||!value.length||value.length>max||/[\p{Cc}]/u.test(value))unavailable();}
function integer(value:unknown,min=0):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<min)unavailable();}
function canonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function json(raw:string):unknown{if(Buffer.byteLength(raw)>65536)unavailable();try{return JSON.parse(raw);}catch{unavailable();}}
function configuration(raw:string):Configuration {
 const c=object(json(raw),['version','profiles','providers'],['ttlGuard','credentialPolicyRevision']);if(c.credentialPolicyRevision!==undefined)text(c.credentialPolicyRevision,128);if(c.version!==1||!Array.isArray(c.profiles)||c.profiles.length<1||c.profiles.length>4)unavailable();
 const providers=object(c.providers,[],['aws','hf','github','s3']),ids=new Set<string>(),kinds=new Set<string>();
 for(const entry of c.profiles){
  const p=object(entry,['id','provider','target','operations','credentialRef','maxLifetimeMs','upperBoundMicros','maxActiveActions'],['enabled']);
  text(p.id,128);text(p.credentialRef,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p.id)||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p.credentialRef)||ids.has(p.id)||!['aws','hf','github','s3'].includes(String(p.provider))||kinds.has(String(p.provider)))unavailable();ids.add(p.id);kinds.add(String(p.provider));
  integer(p.maxLifetimeMs,1);integer(p.upperBoundMicros);integer(p.maxActiveActions,1);if(p.enabled!==undefined&&typeof p.enabled!=='boolean')unavailable();
  const allowed=({aws:['aws.spot.start','aws.spot.inspect'],hf:['hf.model.commit','hf.model.lfs_commit'],github:['github.branch.push'],s3:['aws.s3.put','aws.s3.inspect']} as Record<string,string[]>)[String(p.provider)]!;
  if(!Array.isArray(p.operations)||!p.operations.length||new Set(p.operations).size!==p.operations.length||p.operations.some(op=>!allowed.includes(op)))unavailable();
  if(p.provider==='aws'){
   const target=object(p.target,['accountId','region','workloadId']),a=object(providers.aws,['enabled','accountId','region','workloadId','imageId','instanceType','subnetId','instanceProfileArn','maxLifetimeMs','credentialRef','maxUpperBoundMicros'],['billingPolicy','allowedRegions','availabilityZoneId']);
   try{assertAwsRegion(String(a.region),a.allowedRegions as readonly string[]|undefined);awsPlacement(String(a.region),a.availabilityZoneId as string|undefined);}catch{unavailable();}
   if(a.billingPolicy!==undefined&&!['reserved_ceiling_only','verified_cost_source'].includes(String(a.billingPolicy)))unavailable();
   for(const key of ['accountId','region','workloadId','imageId','instanceType','subnetId','instanceProfileArn','credentialRef'])text(a[key]);
   if(typeof a.enabled!=='boolean'||!/^\d{12}$/.test(String(a.accountId))||!/^[a-z]{2}-[a-z]+-\d$/.test(String(a.region))||!/^ami-[a-f0-9]+$/.test(String(a.imageId))||!/^subnet-[a-f0-9]+$/.test(String(a.subnetId))||!/^[a-z0-9]+\.[a-z0-9]+$/.test(String(a.instanceType))||!String(a.instanceProfileArn).startsWith(`arn:aws:iam::${a.accountId}:instance-profile/`))unavailable();
   integer(a.maxLifetimeMs,1);integer(a.maxUpperBoundMicros);if(p.maxLifetimeMs>a.maxLifetimeMs||p.upperBoundMicros>a.maxUpperBoundMicros||p.credentialRef!==a.credentialRef||['accountId','region','workloadId'].some(k=>target[k]!==a[k]))unavailable();
   if(c.ttlGuard!==undefined){const guard=object(c.ttlGuard,['guardArn']);text(guard.guardArn);if(!guard.guardArn.startsWith(`arn:aws:events:${a.region}:${a.accountId}:rule/`))unavailable();}
  }else if(p.provider==='s3'){
   // Both targets go through the contract validator, then must match exactly. Nothing is inferred.
   let target:ExternalS3Target,provider:Record<string,unknown>;
   try{target=validateExternalS3Target(p.target);provider=object(providers.s3,['enabled','target']);if(typeof provider.enabled!=='boolean')unavailable();if(hash(validateExternalS3Target(provider.target))!==hash(target))unavailable();}catch{unavailable();}
  }else{
   const ref=p.provider==='hf'?'revision':'branch',hf=p.provider==='hf',target=object(p.target,['repository',ref],hf?['visibility','allowPublicLarge']:[]),provider=object(providers[String(p.provider)],['enabled','repository',ref],hf?['visibility','lfs']:[]);
   if(hf){
    for(const value of [target.visibility,provider.visibility])if(value!==undefined&&value!=='private'&&value!=='public')unavailable();
    // Omitted visibility means private, so the profile and provider must agree after resolving it.
    if((target.visibility??'private')!==(provider.visibility??'private'))unavailable();
    if(Object.hasOwn(target,'allowPublicLarge')&&(target.allowPublicLarge!==true||target.visibility!=='public'||!(p.operations as string[]).includes('hf.model.lfs_commit')))unavailable();
    if(provider.lfs!==undefined){
     const lfs=object(provider.lfs,['maxFileBytes','maxTotalBytes','uploadHosts']);integer(lfs.maxFileBytes,1);integer(lfs.maxTotalBytes,1);
     if(lfs.maxFileBytes>LFS_MAX_FILE_BYTES||lfs.maxTotalBytes<lfs.maxFileBytes||lfs.maxTotalBytes>LFS_MAX_TOTAL_BYTES||!Array.isArray(lfs.uploadHosts)||!lfs.uploadHosts.length||lfs.uploadHosts.length>8||new Set(lfs.uploadHosts).size!==lfs.uploadHosts.length)unavailable();
     for(const host of lfs.uploadHosts){text(host,253);if(!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)||host==='huggingface.co')unavailable();}
    }
    // A large commit needs server-owned limits and explicit acknowledgement for public targets.
    if((p.operations as string[]).includes('hf.model.lfs_commit')&&(provider.lfs===undefined||(target.visibility==='public'&&target.allowPublicLarge!==true)))unavailable();
   }
   text(provider.repository);text(provider[ref],128);if(typeof provider.enabled!=='boolean'||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(provider.repository)||!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(String(provider[ref]))||String(provider[ref]).includes('..')||String(provider[ref]).includes('//')||String(provider[ref]).endsWith('.lock')||String(provider[ref]).endsWith('/')||target.repository!==provider.repository||target[ref]!==provider[ref])unavailable();
  }
 }
 if(Object.keys(providers).some(k=>!kinds.has(k)))unavailable();return structuredClone(c) as unknown as Configuration;
}
/** Private descriptor only. No credentials, functions, endpoints or commands accepted. */
type GuardConfiguration=Omit<AwsGuardOptions,'enabled'|'credentials'|'fetchImpl'|'now'> & {credentialRef:string};
function guardConfiguration(raw:string,config:Configuration):GuardConfiguration {
 const g=object(json(raw),['accountId','region','guardArn','functionArn','scheduleGroupArn','schedulerRoleArn','expectedCodeSha256','manifest','rolePolicies','credentialRef'],['allowedRegions']),aws=config.providers.aws;
 if(!aws||g.accountId!==aws.accountId||g.region!==aws.region||g.guardArn!==config.ttlGuard?.guardArn)unavailable();
 try{assertAwsRegion(String(g.region),g.allowedRegions as readonly string[]|undefined);}catch{unavailable();}
 for(const key of ['guardArn','functionArn','scheduleGroupArn','schedulerRoleArn','expectedCodeSha256','credentialRef'])text(g[key]);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(g.credentialRef))||!new RegExp(`^arn:aws:events:${g.region}:${g.accountId}:rule/[A-Za-z0-9_-]{1,64}$`).test(String(g.guardArn))||!String(g.functionArn).startsWith(`arn:aws:lambda:${g.region}:${g.accountId}:function:`)||!String(g.scheduleGroupArn).startsWith(`arn:aws:scheduler:${g.region}:${g.accountId}:schedule-group/`)||!String(g.schedulerRoleArn).startsWith(`arn:aws:iam::${g.accountId}:role/`)||!/^[A-Za-z0-9+/]{43}=$/.test(String(g.expectedCodeSha256)))unavailable();
 const m=object(g.manifest,['schemaVersion','ownershipMode','registryTableArn','guardArn','validUntil','profiles'],['region','allowedRegions','delegatedUpload']);integer(m.validUntil,1);
 if(m.schemaVersion!==1||m.ownershipMode!=='broker_uuid_registry_v1'||m.guardArn!==g.guardArn||typeof m.registryTableArn!=='string'||!m.registryTableArn.startsWith(`arn:aws:dynamodb:${g.region}:${g.accountId}:table/`)||!Array.isArray(m.profiles)||!m.profiles.length||m.profiles.length>16||!Array.isArray(g.rolePolicies)||g.rolePolicies.length!==3)unavailable();
 for(const value of m.profiles){const p=object(value,['workloadId','configurationHash','parameterPolicy','instanceProfileArn','maxLifetimeMs','launchHeadroomMs','quote'],['availabilityZoneId']);text(p.workloadId,128);text(p.instanceProfileArn);integer(p.maxLifetimeMs,60000);integer(p.launchHeadroomMs);if(p.parameterPolicy!=='opaque_broker_sha256'||typeof p.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationHash)||p.maxLifetimeMs>86400000||p.launchHeadroomMs>60000||!p.instanceProfileArn.startsWith(`arn:aws:iam::${g.accountId}:instance-profile/`))unavailable();if(p.workloadId===aws.workloadId&&p.availabilityZoneId!==aws.availabilityZoneId)unavailable();const quote=object(p.quote,['source','maxExposureMicros','validUntil']);text(quote.source,2048);integer(quote.maxExposureMicros,1);integer(quote.validUntil,1);}
 const kinds=new Set<string>();for(const value of g.rolePolicies){const role=object(value,['kind','roleArn','boundaryArn','inlinePolicyName']);for(const key of ['roleArn','boundaryArn','inlinePolicyName'])text(role[key]);if(!['guard','scheduler','workload'].includes(String(role.kind))||kinds.has(String(role.kind))||!String(role.roleArn).startsWith(`arn:aws:iam::${g.accountId}:role/`)||!String(role.boundaryArn).startsWith(`arn:aws:iam::${g.accountId}:policy/`)||role.kind==='scheduler'&&role.roleArn!==g.schedulerRoleArn)unavailable();kinds.add(String(role.kind));}
 return structuredClone(g) as unknown as GuardConfiguration;
}
/** CE remains non-final without verified coverage for query and non-EC2/EBS fees. */
type CostConfiguration=Omit<AwsCostExplorerOptions,'enabled'|'cache'|'credentials'|'supplement'|'fetch'|'now'> & {credentialRef:string};
function costConfiguration(raw:string,config:Configuration):CostConfiguration {
 const c=object(json(raw),['accountId','resourceRegion','workloadId','queryUpperBoundMicros','maxQueryCount','resourceUpperBoundMicros','tagActivation','credentialRef'],['allowedRegions']),aws=config.providers.aws;
 if(!aws||c.accountId!==aws.accountId||c.resourceRegion!==aws.region||c.workloadId!==aws.workloadId)unavailable();text(c.credentialRef,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(c.credentialRef))unavailable();
 try{assertAwsRegion(String(c.resourceRegion),c.allowedRegions as readonly string[]|undefined);}catch{unavailable();}
 integer(c.queryUpperBoundMicros,1);integer(c.maxQueryCount,2);integer(c.resourceUpperBoundMicros);const exposure=c.queryUpperBoundMicros*c.maxQueryCount+c.resourceUpperBoundMicros;
 if(c.maxQueryCount>14||!Number.isSafeInteger(exposure)||exposure>aws.maxUpperBoundMicros!||config.profiles.some(p=>p.provider==='aws'&&exposure>p.upperBoundMicros))unavailable();
 const t=object(c.tagActivation,['evidenceId','activeSince','observedAt','validUntil']);text(t.evidenceId);integer(t.activeSince);integer(t.observedAt);integer(t.validUntil,1);if(t.activeSince>t.observedAt||t.observedAt>=t.validUntil)unavailable();
 return structuredClone(c) as unknown as CostConfiguration;
}
function credential(raw:unknown):ExternalProviderCredential {
 const c=object(raw,['provider'],['accessKeyId','secretAccessKey','sessionToken','token']);
 if(c.provider==='aws'){object(c,['provider','accessKeyId','secretAccessKey'],['sessionToken']);text(c.accessKeyId,128);text(c.secretAccessKey,4096);if(c.sessionToken!==undefined)text(c.sessionToken,8192);}
 else{object(c,['provider','token']);if(c.provider!=='hf'&&c.provider!=='github')unavailable();text(c.token,8192);}
 return structuredClone(c) as ExternalProviderCredential;
}
export function createExternalArtifactLoader(bucket:ExternalArtifactBucket):ExternalArtifactLoader {
 return createExternalR2ArtifactLoader({async get(key){
  const item=await bucket.get(key);if(!item)return null;if(!Number.isSafeInteger(item.size)||item.size<1||item.size>2*1024*1024)unavailable();
  return {size:item.size,async arrayBuffer(){const reader=item.body.getReader(),parts:Uint8Array[]=[];let size=0;
   try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>item.size||size>2*1024*1024){await reader.cancel();unavailable();}parts.push(p.value);}}finally{reader.releaseLock();}
   if(size!==item.size)unavailable();const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes.buffer;
  }};
 }});
}
function configuredCredentialMap(env:ExternalEnvironment):Record<string,ExternalProviderCredential> {
 const credentials:Record<string,ExternalProviderCredential>=Object.create(null);
 if(env.AUTONOMOUS_EXTERNAL_CREDENTIALS){const parsed=json(env.AUTONOMOUS_EXTERNAL_CREDENTIALS);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))unavailable();const map=object(parsed,[],Object.keys(parsed));if(Object.keys(map).length>32)unavailable();for(const [ref,value] of Object.entries(map)){if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref))unavailable();credentials[ref]=credential(value);}}
 return credentials;
}
/** PRIVATE scanner input even while external admission is disabled. Never put in metadata. */
export function externalConfiguredSecretValues(env:ExternalEnvironment):readonly string[]{
 return Object.freeze(Object.values(configuredCredentialMap(env)).flatMap(c=>Object.entries(c).filter(([key])=>key!=='provider').map(([,value])=>String(value))));
}
/** Durable manifest ledger in the same SQL as the broker. A digest names exactly one canonical manifest. */
function createLargeManifestStore(sql:ExternalSqlPort){
 sql.exec('CREATE TABLE IF NOT EXISTS external_large_manifests(manifest_digest TEXT PRIMARY KEY,json TEXT NOT NULL)');
 const read=(digest:string)=>[...sql.exec('SELECT json FROM external_large_manifests WHERE manifest_digest=?',digest)][0] as {json?:unknown}|undefined;
 return {
  async save(manifest:ExternalLargeManifest,digest:string):Promise<void>{
   const json=JSON.stringify(manifest);if(!/^[a-f0-9]{64}$/.test(digest)||Buffer.byteLength(json)>1048576)unavailable();
   sql.exec('INSERT OR IGNORE INTO external_large_manifests(manifest_digest,json) VALUES(?,?)',digest,json);
   const row=read(digest);if(!row||typeof row.json!=='string'||canonical(JSON.parse(row.json))!==canonical(manifest))unavailable();
  },
  async load(digest:string):Promise<ExternalLargeManifest>{
   const row=/^[a-f0-9]{64}$/.test(digest)?read(digest):undefined;if(!row||typeof row.json!=='string')unavailable();
   return JSON.parse(row!.json as string) as ExternalLargeManifest;
  },
 };
}
/** Concrete Worker composition. Does not call providers, read secrets remotely, or deploy. */
/** LFS byte source bound to the invocation owner: only a file whose upload this owner completed can be opened. */
export const openLargeFor=(store:Pick<ExternalLargeStore,'open'>):ExternalHfLfsConfig['open']=>async (file,i)=>(await store.open(file,{taskId:i.taskId,revision:i.revision,profileId:i.profile.id})).body;
export function createAutonomousExternalRuntime(options:ExternalRuntimeOptions):AutonomousExternalRuntime|undefined {
 const {env}=options,enabled=env.AUTONOMOUS_EXTERNAL_ENABLED==='true';
 if(!env.AUTONOMOUS_EXTERNAL_CONFIG){if(enabled)unavailable();return undefined;}
 const config=configuration(env.AUTONOMOUS_EXTERNAL_CONFIG);
 const delegated=env.AUTONOMOUS_DELEGATED_CONFIG?parseDelegatedConfiguration(env.AUTONOMOUS_DELEGATED_CONFIG):undefined;
 const oidcSettings=env.AUTONOMOUS_EXTERNAL_OIDC_CONFIG?parseExternalOidcSettings(env.AUTONOMOUS_EXTERNAL_OIDC_CONFIG):undefined;
 for(const id of Object.keys(oidcSettings?.oidc.roles??{})){const p=config.profiles.find(p=>p.id===id);if(!p||!['aws','s3'].includes(p.provider))unavailable();}
 if(!options.sql||!options.core||!options.artifacts)unavailable();
 const credentials=configuredCredentialMap(env);
 const guardSettings=env.AUTONOMOUS_AWS_GUARD_CONFIG?guardConfiguration(env.AUTONOMOUS_AWS_GUARD_CONFIG,config):undefined;
 const costSettings=env.AUTONOMOUS_EXTERNAL_COST_CONFIG?costConfiguration(env.AUTONOMOUS_EXTERNAL_COST_CONFIG,config):undefined;
 const descriptors=config.profiles.map(p=>({credentialRef:p.credentialRef,provider:credentials[p.credentialRef]?.provider??credentialKind(p.provider),target:p.target,operations:p.operations}));
 const configurationFingerprint=hash({...(delegated?{delegated,delegatedEnabled:env.AUTONOMOUS_DELEGATED_ENABLED==='true'}:{}),...(oidcSettings?{oidcSettings}:{}),config,credentialPolicyRevision:config.credentialPolicyRevision??hash(descriptors),descriptors,enabled,costSettings,costReaderConfigured:!!options.costReader,guardSettings,guardConfigured:!!options.awsTtlGuard||!!guardSettings}),now=options.now??Date.now;
 const credentialControls=new WeakMap<object,AwsScopedCredentialControl>();
 const resolved:Record<string,ExternalProviderCredential>={...credentials},knownSecretValues=new Set<string>();
 function refreshSecretValues(){
  knownSecretValues.clear();for(const value of [...Object.values(resolved).flatMap(c=>Object.entries(c).filter(([key])=>key!=='provider').map(([,value])=>String(value))),...(options.extraSecretValues??[])]){
   if(typeof value!=='string'||Buffer.byteLength(value)>262144)unavailable();knownSecretValues.add(value);
  }
  if(knownSecretValues.size>256)unavailable();
 }
 refreshSecretValues();
 async function resolveCredential(reference:string,provider:string){
  let value:ExternalProviderCredential|undefined;
  if(options.secrets){const raw=await options.secrets.get(reference);if(raw)value=credential(json(raw));}else value=credentials[reference];
  if(!value||value.provider!==provider)unavailable();resolved[reference]=value;refreshSecretValues();return value;
 }
 let guardPort=options.awsTtlGuard;
 if(!guardPort&&guardSettings&&(credentials[guardSettings.credentialRef]?.provider==='aws'||options.secrets)){
  const {credentialRef,...settings}=guardSettings;
  guardPort=createAwsTtlGuardPort({...settings,enabled:true,credentials:async()=>{const c=await resolveCredential(credentialRef,'aws');if(c.provider!=='aws')unavailable();return {accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})};},fetchImpl:options.fetch,now});
 }
 let costReader=config.providers.aws?.billingPolicy==='verified_cost_source'?options.costReader:undefined;
 if(!costReader&&costSettings&&config.providers.aws?.billingPolicy==='verified_cost_source'&&(credentials[costSettings.credentialRef]?.provider==='aws'||options.secrets)){
  const {credentialRef,...settings}=costSettings;
  costReader=createAwsCostExplorerReader({...settings,enabled:true,cache:createExternalCostCache(options.sql),credentials:async()=>{const c=await resolveCredential(credentialRef,'aws');if(c.provider!=='aws')unavailable();return {accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})};},fetch:options.fetch,now});
 }
 const oidcFor=(p:ExternalProfile)=>!!oidcSettings?.oidc.roles[p.id]&&['aws','s3'].includes(p.provider);
 const delegatedReady=(p:ExternalProfile)=>!delegated?.workloads.some(w=>w.profileId===p.id)||(env.AUTONOMOUS_DELEGATED_ENABLED==='true'&&!!options.admitDelegated);
 const available=(p:ExternalProfile)=>!!(delegatedReady(p)&&(oidcFor(p)?options.oidcSigner:(credentials[p.credentialRef]?.provider===credentialKind(p.provider)||options.secrets))&&enabled&&p.enabled===true&&config.providers[p.provider]?.enabled===true&&(p.provider!=='aws'||config.ttlGuard&&(guardPort||oidcFor(p)&&guardSettings&&guardSettings.credentialRef===p.credentialRef)&&(!guardSettings||guardSettings.manifest.validUntil>now())&&(config.providers.aws?.billingPolicy==='reserved_ceiling_only'||config.providers.aws?.billingPolicy==='verified_cost_source'&&(oidcFor(p)?costSettings&&costSettings.credentialRef===p.credentialRef:!!costReader))));
 const registry={get(id:string){const p=config.profiles.find(p=>p.id===id);return p?{...structuredClone(p),enabled:available(p)}:undefined;}};
 const store=createExternalSqlStore(options.sql),oidcAudit=createOidcAuditStore(options.sql,now);
 function recoveryIssue(actionId:string,issue?:'historical_policy_missing'|'historical_credential_unavailable'){
  const owner=store.transaction(s=>{const a=s.actions[actionId],p=a?s.approvals[a.approvalId]:undefined;return a&&p?{taskId:p.taskId,revision:p.revision,requestId:a.requestId}:undefined;});
  if(owner){const j=store.getJournal(owner.taskId,owner.revision,owner.requestId);if(j)store.putJournal({...j,recoveryIssue:issue});}
 }
 function historical(i:Pick<ExternalInvocation,'taskId'|'revision'|'profile'|'actionId'>){
  const raw=store.getProviderPolicy(i.taskId,i.revision,i.profile.id);
  try{
   const p=object(raw,['version','profileHash','configurationFingerprint','config'],['costSettings','injectedCostReader','oidcSettings','guardSettings']);
   if(p.version!==1||p.profileHash!==hash(i.profile)||typeof p.configurationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationFingerprint))unavailable();
   const saved=configuration(JSON.stringify(p.config)),profile=saved.profiles.find(p=>p.id===i.profile.id);
   if(!profile||hash({...profile,enabled:true})!==p.profileHash)unavailable();
   return {config:saved,...(p.oidcSettings?{oidcSettings:parseExternalOidcSettings(JSON.stringify(p.oidcSettings))}:{}),costSettings:p.costSettings?costConfiguration(JSON.stringify(p.costSettings),saved):undefined,injectedCostReader:p.injectedCostReader===true,configurationFingerprint:p.configurationFingerprint};
  }catch{recoveryIssue(i.actionId,'historical_policy_missing');unavailable();}
 }
 const settingsFor=(scope:Readonly<ExternalCredentialScope>,profile:ExternalProfile):ExternalOidcSettings=>{
  const settings=scope.purpose==='execute'?oidcSettings:historical({taskId:scope.taskId,revision:scope.revision,profile,actionId:scope.actionId}).oidcSettings;
  if(!settings?.oidc.roles[profile.id])unavailable();return settings;
 };
 const oidcAuthority=createCanonicalOidcAuthority({core:options.core,store,now,currentProfile:id=>registry.get(id),config:(scope,profile)=>settingsFor(scope,profile).oidc});
 async function scopedPolicy(scope:Readonly<ExternalCredentialScope>){
  // Full facts are revalidated independently of caller-held invocation data.
  await oidcAuthority.grant(scope);
  const saved=store.transaction(s=>{const action=s.actions[scope.actionId];const approval=action?s.approvals[action.approvalId]:undefined;if(!action||!approval)unavailable();return {action,profile:approval.profile,endsAt:approval.endsAt};});
  const template=settingsFor(scope,saved.profile).scoping[saved.profile.id]?.[scope.purpose];if(!template)unavailable();
  const task=await options.core!.execute('get',{id:scope.taskId}) as AutonomousTask;
  let expiresAt=now()+template.durationSeconds*1000;
  if(scope.purpose==='execute'){
   if(!Number.isSafeInteger(task.activeRunStartedAt)||!task.lease||task.lease.expiresAt<=now()||task.status!=='running'||task.stopReason)unavailable();
   expiresAt=Math.min(expiresAt,task.spec.endsAt,saved.endsAt,saved.action.expiresAt,task.activeRunStartedAt!+task.spec.maxRunMs);
  }
  return {...template,targetHash:awsOidcTargetHash(scope.target),expiresAt};
 }
 async function withOidc<T>(scope:Readonly<ExternalCredentialScope>,consume:(c:ExternalProviderCredential)=>Promise<T>){
  if(!options.oidcSigner||!('region'in scope.target))unavailable();
  const saved=store.transaction(s=>{const a=s.actions[scope.actionId],p=a?s.approvals[a.approvalId]:undefined;if(!p)unavailable();return p.profile;});
  const cfg=scope.purpose==='execute'?config:historical({taskId:scope.taskId,revision:scope.revision,profile:saved,actionId:scope.actionId}).config;
  let auditRecorded=false;const audit=(value:import('../../../packages/adapters/src/aws-web-identity.ts').OidcStsAudit)=>{if(!oidcAudit)unavailable();const raw=JSON.stringify(value);for(const secret of knownSecretValues)if(secret&&(raw.includes(secret)||raw.includes(JSON.stringify(secret).slice(1,-1))))unavailable();oidcAudit.record(value);auditRecorded=true;};
  const resolver=createAwsWebIdentityResolver({audit,region:scope.target.region,allowedRegions:cfg.providers.aws?.allowedRegions??[scope.target.region],signer:options.oidcSigner,authority:{grant:oidcAuthority.grant,scoping:scopedPolicy},fetch:options.fetch,now});
  try{return await resolver.withCredentials(scope,async (credentials,control)=>{const value:ExternalProviderCredential={provider:'aws',...credentials};credentialControls.set(value,control);const values=Object.values(credentials);for(const v of values)knownSecretValues.add(v);try{return await consume(value);}finally{for(const v of values)knownSecretValues.delete(v);}});}catch(error){if(!auditRecorded){const facts=store.transaction(s=>{const a=s.actions[scope.actionId],p=a?s.approvals[a.approvalId]:undefined;if(!a||!p)unavailable();return {a,p};});const settings=settingsFor(scope,facts.p.profile),roles=settings.oidc.roles[facts.p.profileId]!;audit({taskId:scope.taskId,revision:scope.revision,profileId:facts.p.profileId,profileHash:facts.p.profileHash,actionId:scope.actionId,purpose:scope.purpose,roleArn:scope.purpose==='execute'?roles.executeRoleArn:roles.cleanupRoleArn,status:'denied'});}throw error;}
 }
 const resolver={async withCredential<T>(reference:string,scope:Readonly<ExternalCredentialScope>,consume:(c:ExternalProviderCredential)=>Promise<T>):Promise<T>{
  const durable=store.transaction(s=>{const a=s.actions[scope.actionId];return a?s.approvals[a.approvalId]:undefined;});
  if(!durable||durable.taskId!==scope.taskId||durable.revision!==scope.revision||durable.profile.credentialRef!==reference||durable.profile.provider!==scope.provider||hash(durable.profile.target)!==hash(scope.target)||!(durable.profile.operations as string[]).includes(scope.operation)||!Number.isSafeInteger(scope.expiresAt))unavailable();
  if(scope.purpose==='execute'){
   const p=config.profiles.find(p=>p.id===durable.profileId&&p.credentialRef===reference&&p.provider===scope.provider&&hash(p.target)===hash(scope.target));
   if(!p||!available(p)||now()>=scope.expiresAt)unavailable();
  }else historical({taskId:scope.taskId,revision:scope.revision,profile:durable.profile,actionId:scope.actionId});
  try{
   const savedSettings=scope.purpose==='execute'?oidcSettings:historical({taskId:scope.taskId,revision:scope.revision,profile:durable.profile,actionId:scope.actionId}).oidcSettings;
   if(savedSettings?.oidc.roles[durable.profileId])return await withOidc(scope,consume);
   const value=await resolveCredential(reference,credentialKind(scope.provider));if(scope.purpose!=='execute')recoveryIssue(scope.actionId);return consume(structuredClone(value));}
  catch(error){if(scope.purpose!=='execute')recoveryIssue(scope.actionId,'historical_credential_unavailable');throw error;}
 }};
 // Large uploads: R2 multipart bucket + durable ledger + manifest ledger. All three or none.
 const multipart=options.artifacts,largeBucket:ExternalLargeBucket|undefined=multipart.createMultipartUpload&&multipart.resumeMultipartUpload&&multipart.delete?{createMultipartUpload:key=>multipart.createMultipartUpload!(key),resumeMultipartUpload:(key,id)=>multipart.resumeMultipartUpload!(key,id),get:key=>multipart.get(key),delete:key=>multipart.delete!(key)}:undefined;
 const limitsOf=(lfs:ConfiguredLfs):ExternalLargeLimits=>({maxFileBytes:lfs.maxFileBytes,maxTotalBytes:lfs.maxTotalBytes,maxFiles:LARGE_MAX_FILES});
 const largeStore=config.providers.hf?.lfs&&largeBucket?createExternalLargeStore({bucket:largeBucket,records:createExternalLargeRecordPort(options.sql),limits:limitsOf(config.providers.hf.lfs),now}):undefined;
 const manifests=largeStore?createLargeManifestStore(options.sql):undefined;
 const lfsWiring=(lfs:ConfiguredLfs|undefined):ExternalHfLfsConfig|undefined=>lfs&&largeStore&&manifests?{uploadHosts:[...lfs.uploadHosts],limits:limitsOf(lfs),loadManifest:digest=>manifests.load(digest),open:openLargeFor(largeStore)}:undefined;
 /** Provider block for the transport, built from one saved or current configuration. */
 function providerSet(c:ConfiguredProviders):Pick<ExternalProviderOptions,'aws'|'hf'|'github'|'s3'>{
  const {lfs,...hf}=c.hf??{},wired=lfsWiring(lfs);
  return {...(c.aws?{aws:{...c.aws,enabled:true}}:{}),...(c.hf?{hf:{...hf,enabled:true,repository:c.hf.repository,revision:c.hf.revision,...(wired?{lfs:wired}:{})}}:{}),...(c.github?{github:{...c.github,enabled:true}}:{}),...(c.s3?{s3:{enabled:true,target:structuredClone(c.s3.target)}}:{})};
 }
 const providerOptions:ExternalProviderOptions={enabled:true,costReader,artifacts:createExternalArtifactLoader(options.artifacts),now,fetch:options.fetch,...providerSet(config.providers),...(config.ttlGuard&&guardPort?{awsTtlGuard:{guardArn:config.ttlGuard.guardArn,port:guardPort}}:{})};
 const provider=()=>createExternalProviderTransport({...providerOptions,forbiddenValues:[...knownSecretValues]});
 function recoveryProvider(i:ExternalInvocation){
  const snapshot=historical(i),saved=snapshot.config;let reader:ExternalCostReader|undefined;
  if(saved.providers.aws?.billingPolicy==='verified_cost_source'){
   if(snapshot.costSettings){const {credentialRef,...settings}=snapshot.costSettings;reader=createAwsCostExplorerReader({...settings,enabled:true,cache:createExternalCostCache(options.sql!),credentials:async()=>{try{const c=await resolveCredential(credentialRef,'aws');if(c.provider!=='aws')unavailable();return {accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})};}catch{recoveryIssue(i.actionId,'historical_credential_unavailable');unavailable();}},fetch:options.fetch,now});}
   else if(snapshot.injectedCostReader&&snapshot.configurationFingerprint===configurationFingerprint)reader=options.costReader;
  }
  // Historical policy is read/delete only. No recovery path exposes execute or arms a timer.
  const noLaunch:AwsTtlGuardPort={async attest(){unavailable();},async arm(){unavailable();}};
  return createExternalProviderTransport({enabled:true,artifacts:createExternalArtifactLoader(options.artifacts!),now,fetch:options.fetch,forbiddenValues:[...knownSecretValues],costReader:reader,...providerSet(saved.providers),...(saved.ttlGuard?{awsTtlGuard:{guardArn:saved.ttlGuard.guardArn,port:noLaunch}}:{})});
 }
 function invocationProvider(i:ExternalInvocation,c:ExternalProviderCredential,purpose:ExternalCredentialScope['purpose']){
  const w=delegated?.workloads.find(w=>w.profileId===i.profile.id);if(purpose==='execute'&&i.operation==='aws.spot.start'&&w){if(env.AUTONOMOUS_DELEGATED_ENABLED!=='true')unavailable();const aws=config.providers.aws;if(!aws||aws.imageId!==w.descriptor.amiId||aws.instanceProfileArn!==w.descriptor.iam.instanceProfileArn||aws.availabilityZoneId!==w.descriptor.availabilityZoneId)unavailable();assertDelegatedLaunchAdmission(options.sql!,i.taskId,i.revision,i.profile.id,store.transaction(s=>s.actions[i.actionId]?.requestId??unavailable()),w.descriptor,w.inputManifest);}
  const cfg=purpose==='execute'?config:historical(i).config;
  const launchMetadata=w&&purpose==='execute'&&i.operation==='aws.spot.start'?{taskId:i.taskId,revision:i.revision,profileId:i.profile.id,descriptorHash:workloadFingerprint(w.descriptor),inputManifestDigest:inputManifestDigest(w.inputManifest)}:undefined;
  const saved=purpose==='execute'?oidcSettings:historical(i).oidcSettings;
  if(!saved?.oidc.roles[i.profile.id])return purpose==='execute'?(launchMetadata?createExternalProviderTransport({...providerOptions,delegatedLaunch:launchMetadata,forbiddenValues:[...knownSecretValues]}):provider()):recoveryProvider(i);
  if(c.provider!=='aws')unavailable();
  const scope:ExternalCredentialScope={taskId:i.taskId,revision:i.revision,actionId:i.actionId,provider:i.profile.provider,target:i.profile.target,operation:i.operation,purpose,expiresAt:i.expiresAt};
  const control=credentialControls.get(c);if(!control)unavailable();
  const scopedFetch:typeof fetch=async(input,init)=>{await oidcAuthority.grant(scope);control.assertValid();const response=await (options.fetch??globalThis.fetch)(input,init);await oidcAuthority.grant(scope);control.assertValid();return response;};
  // Only final GSC credentials reach these callbacks. They never resolve a key or ARWI parent.
  const credentials=async()=>{await oidcAuthority.grant(scope);control.assertValid();return {accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})};};
  const guarded=purpose==='execute'?(options.awsTtlGuard??(guardSettings?createAwsTtlGuardPort({...guardSettings,enabled:true,credentials,fetchImpl:scopedFetch,now}):undefined)):undefined;
  const costs=purpose==='execute'?costSettings:historical(i).costSettings;
  const reader=costs?createAwsCostExplorerReader({...costs,enabled:true,cache:createExternalCostCache(options.sql!),credentials,fetch:scopedFetch,now}):undefined;
  return createExternalProviderTransport({enabled:true,...(launchMetadata?{delegatedLaunch:launchMetadata}:{}),artifacts:createExternalArtifactLoader(options.artifacts!),...providerSet(cfg.providers),now,fetch:scopedFetch,forbiddenValues:[...knownSecretValues],costReader:reader,...(cfg.ttlGuard&&guarded?{awsTtlGuard:{guardArn:cfg.ttlGuard.guardArn,port:guarded}}:{})});
 }
 const transport:GuardedExternalProviderTransport<ExternalProviderCredential>={execute:(i,c,authority)=>invocationProvider(i,c,'execute').execute(i,c,authority),inspect:(i,c)=>invocationProvider(i,c,'inspect').inspect(i,c),cleanup:(i,r,c)=>invocationProvider(i,c,'cleanup').cleanup(i,r,c),confirmAbsent:(i,r,c)=>invocationProvider(i,c,'cleanup').confirmAbsent(i,r,c)};
 const broker=new ExternalBroker({store,registry,resolver,transport,now});
 const serverApprove=broker.serverApprove.bind(broker);
 broker.serverApprove=request=>{
  const approval=serverApprove(request);
  store.bindProviderPolicy(request.taskId,request.revision,request.profileId,{version:1,profileHash:approval.profileHash,configurationFingerprint,config,...(guardSettings?{guardSettings}:{}),...(oidcSettings?{oidcSettings}:{}),...(costSettings?{costSettings}:{}),...(options.costReader?{injectedCostReader:true}:{})});
  return approval;
 };
 // Budget watch: cancel live approvals first, then stop the canonical task through the budget stop. Never an HTTP route.
 const costWatch=createExternalCostWatch({store,now,
  stopTask:async(taskId,reason)=>{await options.core!.execute('stopExternalBudget',{id:taskId,reason});},
  cancelApprovals:(taskId,revision)=>{
   const active=store.transaction(s=>Object.values(s.approvals).some(p=>p.taskId===taskId&&p.revision===revision&&p.stoppedAt===undefined));
   if(active){store.blockTask(taskId,revision);broker.cancel(taskId,revision,'External cost stop');}
  }});
 const artifactBucket=options.artifacts;
 const artifactPublisher=options.artifactPublisher??(artifactBucket.put?createExternalR2ArtifactPublisher({
  async get(key){const object=await artifactBucket.get(key);if(!object)return null;return {size:object.size,async arrayBuffer(){if(!Number.isSafeInteger(object.size)||object.size<1||object.size>2*1024*1024)unavailable();const reader=object.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>object.size){await reader.cancel();unavailable();}chunks.push(part.value);}}finally{reader.releaseLock();}if(size!==object.size)unavailable();return new Uint8Array(Buffer.concat(chunks)).buffer;}};},
  put:(key,value,condition)=>artifactBucket.put!(key,value,condition),
 }):undefined);
 const service=createAutonomousExternalService({...(oidcAudit?{oidcAudit:async(id,query)=>oidcAudit.page(id,query)}:{}),beforeExecute:async(id,body)=>{const w=delegated?.workloads.find(w=>w.profileId===body.request.profileId);if(w&&body.request.operation==='aws.spot.start'){if(env.AUTONOMOUS_DELEGATED_ENABLED!=='true'||!options.admitDelegated)unavailable();await options.admitDelegated(id,{lease:body.lease,runtimeId:body.runtimeId,profileId:w.profileId,launchRequestId:body.request.requestId,inputManifest:w.inputManifest});}},profileMetadata:(task,p)=>{const w=delegated?.workloads.find(w=>w.profileId===p.id),display=w?{delegated:{descriptorHash:workloadFingerprint(w.descriptor),inputManifestDigest:inputManifestDigest(w.inputManifest),descriptor:w.descriptor}}:{};if(!oidcFor(p))return display;const settings=oidcSettings!,roles=settings.oidc.roles[p.id]!,templates=settings.scoping[p.id]!;return {...display,oidc:{issuer:settings.oidc.issuer,audience:settings.oidc.audience,...Object.fromEntries((['execute','inspect','cleanup'] as const).map(purpose=>[purpose,{roleArn:purpose==='execute'?roles.executeRoleArn:roles.cleanupRoleArn,subject:oidcSubject(task.id,task.revision,hash(p),purpose),policyHash:templates[purpose].policyHash,durationSeconds:templates[purpose].durationSeconds}]))} as import('../../../apps/control-plane/src/autonomous-external-api.ts').ExternalOidcDisplay};},core:options.core,broker,registry,store,configurationFingerprint,artifactPublisher,...(manifests&&largeStore?{manifestStore:{save:(m,d)=>manifests.save(m,d)},largeStore:{abortOwner:(t,r)=>largeStore.abortOwner(t,r)}}:{}),knownSecretValues:()=>[...knownSecretValues]});
 let cursor=0;
 return {enabled:config.profiles.some(available),service,configurationFingerprint,...(largeStore&&config.providers.hf?.lfs?{large:{store:largeStore,limits:limitsOf(config.providers.hf.lfs)}}:{}),configuredSecretValues:()=>Object.freeze([...knownSecretValues]),
  async resolveHfToken(reference){const c=await resolveCredential(reference,'hf');if(c.provider!=='hf')unavailable();return c.token;},
  async withOwnedAwsCredential(taskId,revision,actionId,purpose,consume){const facts=store.transaction(s=>{const a=s.actions[actionId],p=a?s.approvals[a.approvalId]:undefined;if(!a||!p||p.taskId!==taskId||p.revision!==revision||p.profile.provider!=='aws'||!a.resource||a.providerReceipt?.resource?.id!==a.resource.id)unavailable();return {a,p};});const {a,p}=facts;return resolver.withCredential(p.profile.credentialRef,{taskId,revision,actionId,provider:p.profile.provider,target:p.profile.target,operation:a.operation,purpose,expiresAt:a.expiresAt},async c=>{if(c.provider!=='aws')unavailable();return consume(c,credentialControls.get(c));});},
  async recover(){
   await service.recover();const pending=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase));
   if(!pending.length)return {needsWork:false};
   return {needsWork:true,nextWake:Math.min(...pending.map(j=>j.retryAt??now()+2000))};
  },
  async cleanupDue(limit=20){
   if(!Number.isSafeInteger(limit)||limit<1||limit>100)unavailable();
   let sweep:{failed:string[];nextExpiryAt?:number}={failed:[]};
   try{sweep=await costWatch.sweep();}catch{sweep={failed:['sweep']};/* Keep retrying on the next wake. */}
   const pending=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase)),ordered=[...pending.slice(cursor),...pending.slice(0,cursor)],due=ordered.filter(j=>(j.retryAt??0)<=now()).slice(0,limit);let visited=0;
   for(const j of due){visited++;try{
    let canonical:unknown;try{canonical=await options.core!.execute('getSummary',{id:j.taskId});}catch{canonical=await options.core!.execute('get',{id:j.taskId});}
    const task=canonical as {stopReason?:string;status?:string};if(task.stopReason||['completed','cancelled','expired','failed','budget_exceeded'].includes(task.status??'')){const active=store.transaction(s=>Object.values(s.approvals).some(p=>p.taskId===j.taskId&&p.revision===j.revision&&p.stoppedAt===undefined));if(active){store.blockTask(j.taskId,j.revision);broker.cancel(j.taskId,j.revision,'Canonical task stopped');}}
    await service.reconcile(j.taskId,j.requestId,j.revision);await service.cleanup(j.taskId,j.requestId,j.revision);}catch{/* Keep reservations and retry with bounded backoff, never manufacture zero. */}
    const latest=store.getJournal(j.taskId,j.revision,j.requestId)!;const attempts=Math.min(10,(latest.retryAttempts??0)+1);store.putJournal({...latest,retryAttempts:attempts,retryAt:now()+Math.min(3600000,60000*2**(attempts-1))});}
   cursor=pending.length?(cursor+visited)%pending.length:0;
   const remaining=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase));
   // Retry and failure wakes keep the 60 s floor so a failing cleanup cannot spin. Only an action expiry may wake sooner, never below 1 s.
   const backoff=[...remaining.map(j=>j.retryAt??now()+60000),...(sweep.failed.length?[now()+60000]:[])],wakes:number[]=[];
   if(backoff.length)wakes.push(Math.max(now()+60000,Math.min(...backoff)));
   if(sweep.nextExpiryAt!==undefined)wakes.push(Math.max(now()+1000,sweep.nextExpiryAt));
   return {visited,needsWork:wakes.length>0,...(wakes.length?{nextWake:Math.min(...wakes)}:{})};
  },
 };
}
