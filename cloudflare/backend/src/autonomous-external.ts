import {createAwsCostExplorerReader,createExternalCostCache,type AwsCostExplorerOptions,type ExternalCostReader} from '../../../packages/adapters/src/autonomous-external-cost.ts';
import {createAwsTtlGuardPort,type AwsGuardOptions} from '../../../packages/adapters/src/autonomous-aws-guard.ts';
import {createHash} from 'node:crypto';
import {ExternalBroker,type GuardedExternalProviderTransport} from '../../../packages/core/src/autonomous-external.ts';
import {createExternalSqlStore,type ExternalSqlPort} from '../../../packages/core/src/autonomous-external-sql.ts';
import {createAutonomousExternalService,type AutonomousExternalService} from '../../../apps/control-plane/src/autonomous-external-api.ts';
import type {AutonomousApiService} from '../../../apps/control-plane/src/autonomous-api.ts';
import type {ExternalProfile,ExternalCredentialScope,ExternalInvocation} from '../../../packages/contracts/src/autonomous-external.ts';
import {createExternalProviderTransport,createExternalR2ArtifactLoader,createExternalR2ArtifactPublisher,type ExternalArtifactPublisher,type ExternalArtifactLoader,type ExternalProviderCredential,type ExternalProviderOptions,type AwsTtlGuardPort} from '../../../packages/adapters/src/autonomous-external.ts';

export interface ExternalEnvironment {
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
interface Configuration {version:1;profiles:ExternalProfile[];providers:Pick<ExternalProviderOptions,'aws'|'hf'|'github'>;ttlGuard?:{guardArn:string};credentialPolicyRevision?:string}
export interface ExternalRuntimeOptions {
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
 /** PRIVATE safety scanner input only. Never include in HTTP/UI/model data. */
 configuredSecretValues():readonly string[];
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
 const c=object(json(raw),['version','profiles','providers'],['ttlGuard','credentialPolicyRevision']);if(c.credentialPolicyRevision!==undefined)text(c.credentialPolicyRevision,128);if(c.version!==1||!Array.isArray(c.profiles)||c.profiles.length<1||c.profiles.length>3)unavailable();
 const providers=object(c.providers,[],['aws','hf','github']),ids=new Set<string>(),kinds=new Set<string>();
 for(const entry of c.profiles){
  const p=object(entry,['id','provider','target','operations','credentialRef','maxLifetimeMs','upperBoundMicros','maxActiveActions'],['enabled']);
  text(p.id,128);text(p.credentialRef,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p.id)||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p.credentialRef)||ids.has(p.id)||!['aws','hf','github'].includes(String(p.provider))||kinds.has(String(p.provider)))unavailable();ids.add(p.id);kinds.add(String(p.provider));
  integer(p.maxLifetimeMs,1);integer(p.upperBoundMicros);integer(p.maxActiveActions,1);if(p.enabled!==undefined&&typeof p.enabled!=='boolean')unavailable();
  const allowed=({aws:['aws.spot.start','aws.spot.inspect'],hf:['hf.model.commit'],github:['github.branch.push']} as Record<string,string[]>)[String(p.provider)]!;
  if(!Array.isArray(p.operations)||!p.operations.length||new Set(p.operations).size!==p.operations.length||p.operations.some(op=>!allowed.includes(op)))unavailable();
  if(p.provider==='aws'){
   const target=object(p.target,['accountId','region','workloadId']),a=object(providers.aws,['enabled','accountId','region','workloadId','imageId','instanceType','subnetId','instanceProfileArn','maxLifetimeMs','credentialRef','maxUpperBoundMicros'],['billingPolicy']);
   if(a.billingPolicy!==undefined&&!['reserved_ceiling_only','verified_cost_source'].includes(String(a.billingPolicy)))unavailable();
   for(const key of ['accountId','region','workloadId','imageId','instanceType','subnetId','instanceProfileArn','credentialRef'])text(a[key]);
   if(typeof a.enabled!=='boolean'||!/^\d{12}$/.test(String(a.accountId))||!/^[a-z]{2}-[a-z]+-\d$/.test(String(a.region))||!/^ami-[a-f0-9]+$/.test(String(a.imageId))||!/^subnet-[a-f0-9]+$/.test(String(a.subnetId))||!/^[a-z0-9]+\.[a-z0-9]+$/.test(String(a.instanceType))||!String(a.instanceProfileArn).startsWith(`arn:aws:iam::${a.accountId}:instance-profile/`))unavailable();
   integer(a.maxLifetimeMs,1);integer(a.maxUpperBoundMicros);if(p.maxLifetimeMs>a.maxLifetimeMs||p.upperBoundMicros>a.maxUpperBoundMicros||p.credentialRef!==a.credentialRef||['accountId','region','workloadId'].some(k=>target[k]!==a[k]))unavailable();
   if(c.ttlGuard!==undefined){const guard=object(c.ttlGuard,['guardArn']);text(guard.guardArn);if(!guard.guardArn.startsWith(`arn:aws:events:${a.region}:${a.accountId}:rule/`))unavailable();}
  }else{
   const ref=p.provider==='hf'?'revision':'branch',target=object(p.target,['repository',ref]),provider=object(providers[String(p.provider)],['enabled','repository',ref]);
   text(provider.repository);text(provider[ref],128);if(typeof provider.enabled!=='boolean'||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(provider.repository)||!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(String(provider[ref]))||String(provider[ref]).includes('..')||String(provider[ref]).includes('//')||String(provider[ref]).endsWith('.lock')||String(provider[ref]).endsWith('/')||target.repository!==provider.repository||target[ref]!==provider[ref])unavailable();
  }
 }
 if(Object.keys(providers).some(k=>!kinds.has(k)))unavailable();return structuredClone(c) as unknown as Configuration;
}
/** Private descriptor only. No credentials, functions, endpoints or commands accepted. */
type GuardConfiguration=Omit<AwsGuardOptions,'enabled'|'credentials'|'fetchImpl'|'now'> & {credentialRef:string};
function guardConfiguration(raw:string,config:Configuration):GuardConfiguration {
 const g=object(json(raw),['accountId','region','guardArn','functionArn','scheduleGroupArn','schedulerRoleArn','expectedCodeSha256','manifest','rolePolicies','credentialRef']),aws=config.providers.aws;
 if(!aws||g.accountId!==aws.accountId||g.region!==aws.region||g.region!=='ap-northeast-2'||g.guardArn!==config.ttlGuard?.guardArn)unavailable();
 for(const key of ['guardArn','functionArn','scheduleGroupArn','schedulerRoleArn','expectedCodeSha256','credentialRef'])text(g[key]);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(g.credentialRef))||!new RegExp(`^arn:aws:events:${g.region}:${g.accountId}:rule/[A-Za-z0-9_-]{1,64}$`).test(String(g.guardArn))||!String(g.functionArn).startsWith(`arn:aws:lambda:${g.region}:${g.accountId}:function:`)||!String(g.scheduleGroupArn).startsWith(`arn:aws:scheduler:${g.region}:${g.accountId}:schedule-group/`)||!String(g.schedulerRoleArn).startsWith(`arn:aws:iam::${g.accountId}:role/`)||!/^[A-Za-z0-9+/]{43}=$/.test(String(g.expectedCodeSha256)))unavailable();
 const m=object(g.manifest,['schemaVersion','ownershipMode','registryTableArn','guardArn','validUntil','profiles']);integer(m.validUntil,1);
 if(m.schemaVersion!==1||m.ownershipMode!=='broker_uuid_registry_v1'||m.guardArn!==g.guardArn||typeof m.registryTableArn!=='string'||!m.registryTableArn.startsWith(`arn:aws:dynamodb:${g.region}:${g.accountId}:table/`)||!Array.isArray(m.profiles)||!m.profiles.length||m.profiles.length>16||!Array.isArray(g.rolePolicies)||g.rolePolicies.length!==3)unavailable();
 for(const value of m.profiles){const p=object(value,['workloadId','configurationHash','parameterPolicy','instanceProfileArn','maxLifetimeMs','launchHeadroomMs','quote']);text(p.workloadId,128);text(p.instanceProfileArn);integer(p.maxLifetimeMs,60000);integer(p.launchHeadroomMs);if(p.parameterPolicy!=='opaque_broker_sha256'||typeof p.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationHash)||p.maxLifetimeMs>86400000||p.launchHeadroomMs>60000||!p.instanceProfileArn.startsWith(`arn:aws:iam::${g.accountId}:instance-profile/`))unavailable();const quote=object(p.quote,['source','maxExposureMicros','validUntil']);text(quote.source,2048);integer(quote.maxExposureMicros,1);integer(quote.validUntil,1);}
 const kinds=new Set<string>();for(const value of g.rolePolicies){const role=object(value,['kind','roleArn','boundaryArn','inlinePolicyName']);for(const key of ['roleArn','boundaryArn','inlinePolicyName'])text(role[key]);if(!['guard','scheduler','workload'].includes(String(role.kind))||kinds.has(String(role.kind))||!String(role.roleArn).startsWith(`arn:aws:iam::${g.accountId}:role/`)||!String(role.boundaryArn).startsWith(`arn:aws:iam::${g.accountId}:policy/`)||role.kind==='scheduler'&&role.roleArn!==g.schedulerRoleArn)unavailable();kinds.add(String(role.kind));}
 return structuredClone(g) as unknown as GuardConfiguration;
}
/** CE remains non-final without verified coverage for query and non-EC2/EBS fees. */
type CostConfiguration=Omit<AwsCostExplorerOptions,'enabled'|'cache'|'credentials'|'supplement'|'fetch'|'now'> & {credentialRef:string};
function costConfiguration(raw:string,config:Configuration):CostConfiguration {
 const c=object(json(raw),['accountId','resourceRegion','workloadId','queryUpperBoundMicros','maxQueryCount','resourceUpperBoundMicros','tagActivation','credentialRef']),aws=config.providers.aws;
 if(!aws||c.accountId!==aws.accountId||c.resourceRegion!==aws.region||c.resourceRegion!=='ap-northeast-2'||c.workloadId!==aws.workloadId)unavailable();text(c.credentialRef,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(c.credentialRef))unavailable();
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
/** Concrete Worker composition. Does not call providers, read secrets remotely, or deploy. */
export function createAutonomousExternalRuntime(options:ExternalRuntimeOptions):AutonomousExternalRuntime|undefined {
 const {env}=options,enabled=env.AUTONOMOUS_EXTERNAL_ENABLED==='true';
 if(!env.AUTONOMOUS_EXTERNAL_CONFIG){if(enabled)unavailable();return undefined;}
 const config=configuration(env.AUTONOMOUS_EXTERNAL_CONFIG);
 if(!options.sql||!options.core||!options.artifacts)unavailable();
 const credentials=configuredCredentialMap(env);
 const guardSettings=env.AUTONOMOUS_AWS_GUARD_CONFIG?guardConfiguration(env.AUTONOMOUS_AWS_GUARD_CONFIG,config):undefined;
 const costSettings=env.AUTONOMOUS_EXTERNAL_COST_CONFIG?costConfiguration(env.AUTONOMOUS_EXTERNAL_COST_CONFIG,config):undefined;
 const descriptors=config.profiles.map(p=>({credentialRef:p.credentialRef,provider:credentials[p.credentialRef]?.provider??p.provider,target:p.target,operations:p.operations}));
 const configurationFingerprint=hash({config,credentialPolicyRevision:config.credentialPolicyRevision??hash(descriptors),descriptors,enabled,costSettings,costReaderConfigured:!!options.costReader,guardSettings,guardConfigured:!!options.awsTtlGuard||!!guardSettings}),now=options.now??Date.now;
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
 const available=(p:ExternalProfile)=>!!((credentials[p.credentialRef]?.provider===p.provider||options.secrets)&&enabled&&p.enabled===true&&config.providers[p.provider]?.enabled===true&&(p.provider!=='aws'||config.ttlGuard&&guardPort&&(!guardSettings||guardSettings.manifest.validUntil>now())&&(config.providers.aws?.billingPolicy==='reserved_ceiling_only'||config.providers.aws?.billingPolicy==='verified_cost_source'&&!!costReader)));
 const registry={get(id:string){const p=config.profiles.find(p=>p.id===id);return p?{...structuredClone(p),enabled:available(p)}:undefined;}};
 const store=createExternalSqlStore(options.sql);
 function recoveryIssue(actionId:string,issue?:'historical_policy_missing'|'historical_credential_unavailable'){
  const owner=store.transaction(s=>{const a=s.actions[actionId],p=a?s.approvals[a.approvalId]:undefined;return a&&p?{taskId:p.taskId,revision:p.revision,requestId:a.requestId}:undefined;});
  if(owner){const j=store.getJournal(owner.taskId,owner.revision,owner.requestId);if(j)store.putJournal({...j,recoveryIssue:issue});}
 }
 function historical(i:Pick<ExternalInvocation,'taskId'|'revision'|'profile'|'actionId'>){
  const raw=store.getProviderPolicy(i.taskId,i.revision,i.profile.id);
  try{
   const p=object(raw,['version','profileHash','configurationFingerprint','config'],['costSettings','injectedCostReader']);
   if(p.version!==1||p.profileHash!==hash(i.profile)||typeof p.configurationFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.configurationFingerprint))unavailable();
   const saved=configuration(JSON.stringify(p.config)),profile=saved.profiles.find(p=>p.id===i.profile.id);
   if(!profile||hash({...profile,enabled:true})!==p.profileHash)unavailable();
   return {config:saved,costSettings:p.costSettings?costConfiguration(JSON.stringify(p.costSettings),saved):undefined,injectedCostReader:p.injectedCostReader===true,configurationFingerprint:p.configurationFingerprint};
  }catch{recoveryIssue(i.actionId,'historical_policy_missing');unavailable();}
 }
 const resolver={async withCredential<T>(reference:string,scope:Readonly<ExternalCredentialScope>,consume:(c:ExternalProviderCredential)=>Promise<T>):Promise<T>{
  const durable=store.transaction(s=>{const a=s.actions[scope.actionId];return a?s.approvals[a.approvalId]:undefined;});
  if(!durable||durable.taskId!==scope.taskId||durable.revision!==scope.revision||durable.profile.credentialRef!==reference||durable.profile.provider!==scope.provider||hash(durable.profile.target)!==hash(scope.target)||!(durable.profile.operations as string[]).includes(scope.operation)||!Number.isSafeInteger(scope.expiresAt))unavailable();
  if(scope.purpose==='execute'){
   const p=config.profiles.find(p=>p.id===durable.profileId&&p.credentialRef===reference&&p.provider===scope.provider&&hash(p.target)===hash(scope.target));
   if(!p||!available(p)||now()>=scope.expiresAt)unavailable();
  }else historical({taskId:scope.taskId,revision:scope.revision,profile:durable.profile,actionId:scope.actionId});
  try{const value=await resolveCredential(reference,scope.provider);if(scope.purpose!=='execute')recoveryIssue(scope.actionId);return consume(structuredClone(value));}
  catch(error){if(scope.purpose!=='execute')recoveryIssue(scope.actionId,'historical_credential_unavailable');throw error;}
 }};
 const providerOptions:ExternalProviderOptions={enabled:true,costReader,artifacts:createExternalArtifactLoader(options.artifacts),now,fetch:options.fetch,...(config.providers.aws?{aws:{...config.providers.aws,enabled:true}}:{}),...(config.providers.hf?{hf:{...config.providers.hf,enabled:true}}:{}),...(config.providers.github?{github:{...config.providers.github,enabled:true}}:{}),...(config.ttlGuard&&guardPort?{awsTtlGuard:{guardArn:config.ttlGuard.guardArn,port:guardPort}}:{})};
 const provider=()=>createExternalProviderTransport({...providerOptions,forbiddenValues:[...knownSecretValues]});
 function recoveryProvider(i:ExternalInvocation){
  const snapshot=historical(i),saved=snapshot.config;let reader:ExternalCostReader|undefined;
  if(saved.providers.aws?.billingPolicy==='verified_cost_source'){
   if(snapshot.costSettings){const {credentialRef,...settings}=snapshot.costSettings;reader=createAwsCostExplorerReader({...settings,enabled:true,cache:createExternalCostCache(options.sql!),credentials:async()=>{try{const c=await resolveCredential(credentialRef,'aws');if(c.provider!=='aws')unavailable();return {accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})};}catch{recoveryIssue(i.actionId,'historical_credential_unavailable');unavailable();}},fetch:options.fetch,now});}
   else if(snapshot.injectedCostReader&&snapshot.configurationFingerprint===configurationFingerprint)reader=options.costReader;
  }
  // Historical policy is read/delete only. No recovery path exposes execute or arms a timer.
  const noLaunch:AwsTtlGuardPort={async attest(){unavailable();},async arm(){unavailable();}};
  return createExternalProviderTransport({enabled:true,artifacts:createExternalArtifactLoader(options.artifacts!),now,fetch:options.fetch,forbiddenValues:[...knownSecretValues],costReader:reader,...(saved.providers.aws?{aws:{...saved.providers.aws,enabled:true}}:{}),...(saved.providers.hf?{hf:{...saved.providers.hf,enabled:true}}:{}),...(saved.providers.github?{github:{...saved.providers.github,enabled:true}}:{}),...(saved.ttlGuard?{awsTtlGuard:{guardArn:saved.ttlGuard.guardArn,port:noLaunch}}:{})});
 }
 const transport:GuardedExternalProviderTransport<ExternalProviderCredential>={execute:(i,c,authority)=>provider().execute(i,c,authority),inspect:(i,c)=>recoveryProvider(i).inspect(i,c),cleanup:(i,r,c)=>recoveryProvider(i).cleanup(i,r,c),confirmAbsent:(i,r,c)=>recoveryProvider(i).confirmAbsent(i,r,c)};
 const broker=new ExternalBroker({store,registry,resolver,transport,now});
 const serverApprove=broker.serverApprove.bind(broker);
 broker.serverApprove=request=>{
  const approval=serverApprove(request);
  store.bindProviderPolicy(request.taskId,request.revision,request.profileId,{version:1,profileHash:approval.profileHash,configurationFingerprint,config,...(costSettings?{costSettings}:{}),...(options.costReader?{injectedCostReader:true}:{})});
  return approval;
 };
 const artifactBucket=options.artifacts;
 const artifactPublisher=options.artifactPublisher??(artifactBucket.put?createExternalR2ArtifactPublisher({
  async get(key){const object=await artifactBucket.get(key);if(!object)return null;return {size:object.size,async arrayBuffer(){if(!Number.isSafeInteger(object.size)||object.size<1||object.size>2*1024*1024)unavailable();const reader=object.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>object.size){await reader.cancel();unavailable();}chunks.push(part.value);}}finally{reader.releaseLock();}if(size!==object.size)unavailable();return new Uint8Array(Buffer.concat(chunks)).buffer;}};},
  put:(key,value,condition)=>artifactBucket.put!(key,value,condition),
 }):undefined);
 const service=createAutonomousExternalService({core:options.core,broker,registry,store,configurationFingerprint,artifactPublisher,knownSecretValues:()=>[...knownSecretValues]});
 let cursor=0;
 return {enabled:config.profiles.some(available),service,configurationFingerprint,configuredSecretValues:()=>Object.freeze([...knownSecretValues]),
  async recover(){
   await service.recover();const pending=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase));
   if(!pending.length)return {needsWork:false};
   return {needsWork:true,nextWake:Math.min(...pending.map(j=>j.retryAt??now()+2000))};
  },
  async cleanupDue(limit=20){
   if(!Number.isSafeInteger(limit)||limit<1||limit>100)unavailable();
   const pending=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase)),ordered=[...pending.slice(cursor),...pending.slice(0,cursor)],due=ordered.filter(j=>(j.retryAt??0)<=now()).slice(0,limit);let visited=0;
   for(const j of due){visited++;try{
    let canonical:unknown;try{canonical=await options.core!.execute('getSummary',{id:j.taskId});}catch{canonical=await options.core!.execute('get',{id:j.taskId});}
    const task=canonical as {stopReason?:string;status?:string};if(task.stopReason||['completed','cancelled','expired','failed','budget_exceeded'].includes(task.status??'')){const active=store.transaction(s=>Object.values(s.approvals).some(p=>p.taskId===j.taskId&&p.revision===j.revision&&p.stoppedAt===undefined));if(active){store.blockTask(j.taskId,j.revision);broker.cancel(j.taskId,j.revision,'Canonical task stopped');}}
    await service.reconcile(j.taskId,j.requestId,j.revision);await service.cleanup(j.taskId,j.requestId,j.revision);}catch{/* Keep reservations and retry with bounded backoff, never manufacture zero. */}
    const latest=store.getJournal(j.taskId,j.revision,j.requestId)!;const attempts=Math.min(10,(latest.retryAttempts??0)+1);store.putJournal({...latest,retryAttempts:attempts,retryAt:now()+Math.min(3600000,60000*2**(attempts-1))});}
   cursor=pending.length?(cursor+visited)%pending.length:0;
   const remaining=store.listJournal().filter(j=>!['settled','cleaned'].includes(j.phase));
   return {visited,needsWork:remaining.length>0,...(remaining.length?{nextWake:Math.max(now()+60000,Math.min(...remaining.map(j=>j.retryAt??now()+60000)))}:{})};
  },
 };
}
