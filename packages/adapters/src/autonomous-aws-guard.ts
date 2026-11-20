import {createHash,createHmac} from 'node:crypto';
import type {AwsTtlGuardPort,AwsTtlGuardRequest,AwsTtlGuardEvidence,AwsOwnershipTimerEvidence} from './autonomous-external.js';
export interface AwsGuardProfile {workloadId:string;configurationHash:string;parameterPolicy:'opaque_broker_sha256';instanceProfileArn:string;maxLifetimeMs:number;launchHeadroomMs:number;quote:{source:string;maxExposureMicros:number;validUntil:number}}
export interface AwsGuardManifest {schemaVersion:1;ownershipMode:'broker_uuid_registry_v1';registryTableArn:string;guardArn:string;validUntil:number;profiles:AwsGuardProfile[]}
export interface AwsGuardRole {kind:'guard'|'scheduler'|'workload';roleArn:string;boundaryArn:string;inlinePolicyName:string}
export interface AwsGuardOptions {
 enabled?:boolean;accountId:string;region:'ap-northeast-2';guardArn:string;functionArn:string;scheduleGroupArn:string;schedulerRoleArn:string;
 expectedCodeSha256:string;manifest:AwsGuardManifest;rolePolicies:AwsGuardRole[];
 credentials:(signal?:AbortSignal)=>Promise<{accessKeyId:string;secretAccessKey:string;sessionToken?:string}>;fetchImpl?:typeof fetch;now?:()=>number;
}
export const awsGuardCanonical=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
export const awsGuardDigest=(v:unknown)=>createHash('sha256').update(awsGuardCanonical(v)).digest('hex');
const fail=()=>new Error('AWS TTL guard unavailable');
function check(v:unknown):asserts v {if(!v)throw fail();}
/** Fixed least-privilege documents shared with the CDK package, never supplied by model input. */
export function awsGuardPolicies(c:Pick<AwsGuardOptions,'accountId'|'region'|'guardArn'|'functionArn'|'scheduleGroupArn'|'manifest'>){
 const allow=(Action:string[],Resource:string[],Condition?:unknown)=>({Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
 const document=(Statement:unknown[])=>({Version:'2012-10-17',Statement});
 const trust=(service:string,condition?:unknown)=>document([{Effect:'Allow',Principal:{Service:service},Action:'sts:AssumeRole',...(condition?{Condition:condition}:{})}]);
 const ownedTags={StringEquals:{'ec2:ResourceTag/hivemind:guard':c.guardArn,'ec2:ResourceTag/hivemind:workload':[...new Set(c.manifest.profiles.map(p=>p.workloadId))]},Null:{'ec2:ResourceTag/hivemind:owner':'false'},StringLike:{'ec2:ResourceTag/hivemind:owner':'????????-????-4???-????-????????????'}};
 return {
 guard:{trust:trust('lambda.amazonaws.com'),policy:document([
  allow(['ec2:DescribeInstances','ec2:DescribeVolumes'],['*']),
  allow(['ec2:TerminateInstances'],[`arn:aws:ec2:${c.region}:${c.accountId}:instance/*`],ownedTags),
  allow(['ec2:DeleteVolume'],[`arn:aws:ec2:${c.region}:${c.accountId}:volume/*`],ownedTags),
  allow(['dynamodb:GetItem'],[c.manifest.registryTableArn]),
  allow(['logs:CreateLogStream','logs:PutLogEvents'],[`arn:aws:logs:${c.region}:${c.accountId}:log-group:/aws/lambda/${c.functionArn.split(':').at(-1)}:*`])])},
 scheduler:{trust:trust('scheduler.amazonaws.com',{StringEquals:{'aws:SourceAccount':c.accountId},ArnEquals:{'aws:SourceArn':c.scheduleGroupArn}}),policy:document([allow(['lambda:InvokeFunction'],[c.functionArn])])},
 workload:{trust:trust('ec2.amazonaws.com'),policy:document([allow(['sts:GetCallerIdentity'],['*']),{Effect:'Deny',Action:['events:*','scheduler:*','lambda:*','iam:*','sts:AssumeRole','ec2:CreateTags','ec2:DeleteTags','ec2:RunInstances','dynamodb:*'],Resource:['*']}])}
 };
}
interface Xml {name:string;text:string;children:Xml[]}
function parseXml(source:string):Xml {
 check(source.length<=262144&&!/<!/.test(source));source=source.replace(/^<\?xml[^?]*\?>\s*/,'');
 const root:Xml={name:'root',text:'',children:[]},stack=[root];let nodes=0;
 const tokens=source.match(/<[^>]*>|[^<]+/g)??[];check(tokens.join('')===source);
 for(const token of tokens){
  if(token.startsWith('</')){check(stack.length>1&&token===`</${stack.at(-1)!.name}>`);stack.pop();}
  else if(token.startsWith('<')){const m=/^<([A-Za-z][A-Za-z0-9]*)(?:\s+xmlns="[^"]*")?\s*(\/?)>$/.exec(token);check(m&&++nodes<10000&&stack.length<24);const n={name:m[1]!,text:'',children:[]};stack.at(-1)!.children.push(n);if(!m[2])stack.push(n);}
  else{check(!/&(?!(?:amp|lt|gt|quot|apos);)/.test(token));stack.at(-1)!.text+=token.replace(/&(amp|lt|gt|quot|apos);/g,(_,v:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[v]!);}
 }
 check(stack.length===1&&root.children.length===1&&!root.text.trim());return root.children[0]!;
}
function one(n:Xml,key:string):Xml {const found=n.children.filter(c=>c.name===key);check(found.length===1);return found[0]!;}
const textOf=(n:Xml,key:string)=>one(n,key).text;
function policy(n:Xml,key:string):unknown {return JSON.parse(decodeURIComponent(textOf(n,key)));}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const hmac=(key:string|Uint8Array,v:string)=>createHmac('sha256',key).update(v).digest();
const encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
function data(v:unknown):Record<string,any> {check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,any>;}
function fields(v:object,names:string[]){check(Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k)));}
function same(a:unknown,b:unknown){check(awsGuardCanonical(a)===awsGuardCanonical(b));}
function safeString(v:unknown,max=256):asserts v is string {check(typeof v==='string'&&v.length>0&&v.length<=max&&!/[\s\p{Cc}]/u.test(v));}
function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{const abort=()=>reject(fail());signal.addEventListener('abort',abort,{once:true});work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
}
/** Execution envelope of the locally synthesized guard, independent of the workload quote. */
function verifyExecutionConfiguration(f:Record<string,any>):void {
 check(f.Timeout===55&&f.MemorySize===256);
 same(f.Architectures,['x86_64']);
 // Lambda may omit VpcConfig entirely for a non-VPC function.
 if(f.VpcConfig!==undefined){
  const v=data(f.VpcConfig);check(Object.keys(v).every(key=>['SubnetIds','SecurityGroupIds','VpcId','Ipv6AllowedForDualStack'].includes(key)));
  for(const key of ['SubnetIds','SecurityGroupIds'])check(v[key]===undefined||Array.isArray(v[key])&&v[key].length===0);
  check((v.VpcId===undefined||v.VpcId==='')&&(v.Ipv6AllowedForDualStack===undefined||v.Ipv6AllowedForDualStack===false));
 }
}
/** Missing or disabled configuration denies without credential discovery or AWS calls. */
export function createAwsTtlGuardPort(options?:AwsGuardOptions):AwsTtlGuardPort {
 if(options?.enabled!==true)return {async attest(){throw fail();},async arm(){throw fail();}};
 const {credentials,fetchImpl=fetch,now=Date.now,...settings}=options;const c=structuredClone(settings),issued=new Map<string,{guard:AwsTtlGuardEvidence;at:number}>();
 const guardName=c.guardArn.split('/').at(-1)!,group=c.scheduleGroupArn.split('/').at(-1)!,digest=awsGuardDigest(c.manifest),policies=awsGuardPolicies(c);
 function configuration(){
  check(/^\d{12}$/.test(c.accountId)&&c.region==='ap-northeast-2'&&typeof credentials==='function');
  check(new RegExp(`^arn:aws:events:${c.region}:${c.accountId}:rule/[A-Za-z0-9_-]{1,64}$`).test(c.guardArn));
  check(new RegExp(`^arn:aws:lambda:${c.region}:${c.accountId}:function:[A-Za-z0-9_-]{1,64}$`).test(c.functionArn));
  check(new RegExp(`^arn:aws:scheduler:${c.region}:${c.accountId}:schedule-group/[A-Za-z0-9_-]{1,64}$`).test(c.scheduleGroupArn));
  check(/^[A-Za-z0-9+/]{43}=$/.test(c.expectedCodeSha256)&&c.manifest.schemaVersion===1&&c.manifest.ownershipMode==='broker_uuid_registry_v1'&&new RegExp(`^arn:aws:dynamodb:${c.region}:${c.accountId}:table/[A-Za-z0-9_-]{3,255}$`).test(c.manifest.registryTableArn)&&c.manifest.guardArn===c.guardArn&&Number.isSafeInteger(c.manifest.validUntil)&&c.manifest.validUntil>now()&&Buffer.byteLength(awsGuardCanonical(c.manifest))<=3000);
  fields(c.manifest,['schemaVersion','ownershipMode','registryTableArn','guardArn','validUntil','profiles']);check(Array.isArray(c.manifest.profiles)&&c.manifest.profiles.length>0&&c.manifest.profiles.length<=16&&c.rolePolicies.length===3);
  check(new Set(c.rolePolicies.map(r=>r.kind)).size===3);
  for(const r of c.rolePolicies){check(['guard','scheduler','workload'].includes(r.kind));safeString(r.inlinePolicyName,128);check(r.roleArn.startsWith(`arn:aws:iam::${c.accountId}:role/`)&&r.boundaryArn.startsWith(`arn:aws:iam::${c.accountId}:policy/`));}
  check(c.rolePolicies.find(r=>r.kind==='scheduler')!.roleArn===c.schedulerRoleArn);
  for(const p of c.manifest.profiles){fields(p,['workloadId','configurationHash','parameterPolicy','instanceProfileArn','maxLifetimeMs','launchHeadroomMs','quote']);safeString(p.workloadId,128);check(/^[a-f0-9]{64}$/.test(p.configurationHash)&&p.parameterPolicy==='opaque_broker_sha256'&&Number.isSafeInteger(p.launchHeadroomMs)&&p.launchHeadroomMs>=0&&p.launchHeadroomMs<=60000);check(p.instanceProfileArn.startsWith(`arn:aws:iam::${c.accountId}:instance-profile/`)&&Number.isSafeInteger(p.maxLifetimeMs)&&p.maxLifetimeMs>=60000&&p.maxLifetimeMs<=86400000);fields(p.quote,['source','maxExposureMicros','validUntil']);check(typeof p.quote.source==='string'&&p.quote.source.length>0&&p.quote.source.length<2048&&Number.isSafeInteger(p.quote.maxExposureMicros)&&p.quote.maxExposureMicros>0&&Number.isSafeInteger(p.quote.validUntil));}
 }
 function request(r:Readonly<AwsTtlGuardRequest>){
  configuration();check(Object.keys(r).join(',')==='accountId,region,workloadId,actionId,ownershipToken,clientToken,parametersHash,expiresAt,maxExposureMicros,configurationHash');fields(r,['accountId','region','workloadId','actionId','ownershipToken','clientToken','parametersHash','expiresAt','maxExposureMicros','configurationHash']);safeString(r.actionId);check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.ownershipToken)&&/^[a-f0-9]{64}$/.test(r.parametersHash));check(r.accountId===c.accountId&&r.region===c.region&&/^[a-f0-9]{64}$/.test(r.clientToken));
  const matches=c.manifest.profiles.filter(p=>p.workloadId===r.workloadId&&p.configurationHash===r.configurationHash);check(matches.length===1);const p=matches[0]!;
  check(Number.isSafeInteger(r.expiresAt)&&r.expiresAt>now()+1000&&r.expiresAt<=now()+p.maxLifetimeMs&&r.expiresAt<=c.manifest.validUntil&&r.expiresAt<=p.quote.validUntil&&r.maxExposureMicros===p.quote.maxExposureMicros);return p;
 }
 async function api(service:'events'|'lambda'|'scheduler'|'iam'|'dynamodb',operation:string,params:Record<string,unknown>,signal:AbortSignal,path='/',method='POST'):Promise<{value:any;id:string}>{
  signal.throwIfAborted();const credential=await bounded(credentials(signal),signal);signal.throwIfAborted();safeString(credential.accessKeyId,128);safeString(credential.secretAccessKey,4096);if(credential.sessionToken)safeString(credential.sessionToken,8192);
  const signingRegion=service==='iam'?'us-east-1':c.region,host=service==='iam'?'iam.amazonaws.com':`${service}.${c.region}.amazonaws.com`,url=new URL('https://'+host+path);
  const stamp=new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8);
  const body=method==='GET'?'':service==='iam'?new URLSearchParams({Action:operation,Version:'2010-05-08',...params as Record<string,string>}).toString():awsGuardCanonical(params);
  const headers:Record<string,string>={host,'x-amz-date':stamp};if(method!=='GET')headers['content-type']=service==='iam'?'application/x-www-form-urlencoded':service==='events'?'application/x-amz-json-1.1':service==='dynamodb'?'application/x-amz-json-1.0':'application/json';if(service==='events')headers['x-amz-target']='AWSEvents.'+operation;if(service==='dynamodb')headers['x-amz-target']='DynamoDB_20120810.'+operation;if(credential.sessionToken)headers['x-amz-security-token']=credential.sessionToken;
  const names=Object.keys(headers).sort(),signedHeaders=names.join(';'),query=[...url.searchParams].sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([k,v])=>encode(k)+'='+encode(v)).join('&');
  const scope=`${day}/${signingRegion}/${service}/aws4_request`,canonical=[method,encode(url.pathname).replace(/%2F/g,'/'),query,names.map(k=>k+':'+headers[k]!.trim()+'\n').join(''),signedHeaders,hash(body)].join('\n');
  const key=hmac(hmac(hmac(hmac('AWS4'+credential.secretAccessKey,day),signingRegion),service),'aws4_request');headers.authorization=`AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256',key).update('AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hash(canonical)).digest('hex')}`;
  const pending=fetchImpl(url,{method,headers,body:method==='GET'?undefined:body,redirect:'error',credentials:'omit',signal});void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});const response=await bounded(pending,signal);
  if(!response.ok||response.redirected){await response.body?.cancel();throw Object.assign(fail(),{status:response.status});}check(response.body);const reader=response.body.getReader();let bytes=0,reads=0;const chunks:Uint8Array[]=[];
  try{while(true){signal.throwIfAborted();check(++reads<=10000);const {value,done}=await bounded(reader.read(),signal);if(done)break;bytes+=value.length;check(bytes<=262144);chunks.push(value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const id=response.headers.get('x-amzn-requestid')??response.headers.get('x-amzn-request-id');safeString(id,128);
  const source=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  if(service!=='iam')return {value:data(JSON.parse(source)),id};
  const root=parseXml(source);check(root.name===operation+'Response');return {value:one(root,operation+'Result'),id};
 }
 async function roles(signal:AbortSignal,observations:unknown[]){
  for(const r of c.rolePolicies){const name=r.roleArn.split('/').at(-1)!,expected=policies[r.kind];
   const get=await api('iam','GetRole',{RoleName:name},signal),role=one(get.value,'Role');check(textOf(role,'Arn')===r.roleArn&&textOf(one(role,'PermissionsBoundary'),'PermissionsBoundaryArn')===r.boundaryArn);same(policy(role,'AssumeRolePolicyDocument'),expected.trust);
   const inline=await api('iam','ListRolePolicies',{RoleName:name},signal);check(textOf(inline.value,'IsTruncated')==='false');same(one(inline.value,'PolicyNames').children.map(n=>n.text),[r.inlinePolicyName]);
   const attached=await api('iam','ListAttachedRolePolicies',{RoleName:name},signal);check(textOf(attached.value,'IsTruncated')==='false'&&one(attached.value,'AttachedPolicies').children.length===0);
   const actual=await api('iam','GetRolePolicy',{RoleName:name,PolicyName:r.inlinePolicyName},signal);same(policy(actual.value,'PolicyDocument'),expected.policy);
   const boundary=await api('iam','GetPolicy',{PolicyArn:r.boundaryArn},signal),metadata=one(boundary.value,'Policy');check(textOf(metadata,'Arn')===r.boundaryArn);const version=textOf(metadata,'DefaultVersionId');check(/^v[1-9][0-9]{0,3}$/.test(version));
   const doc=await api('iam','GetPolicyVersion',{PolicyArn:r.boundaryArn,VersionId:version},signal),v=one(doc.value,'PolicyVersion');check(textOf(v,'IsDefaultVersion')==='true');same(policy(v,'Document'),expected.policy);observations.push(get.id,actual.id,boundary.id,doc.id,awsGuardDigest(expected));
  }
  for(const arn of new Set(c.manifest.profiles.map(p=>p.instanceProfileArn))){const got=await api('iam','GetInstanceProfile',{InstanceProfileName:arn.split('/').at(-1)!},signal),profile=one(got.value,'InstanceProfile');check(textOf(profile,'Arn')===arn);const entries=one(profile,'Roles').children;check(entries.length===1&&textOf(entries[0]!,'Arn')===c.rolePolicies.find(r=>r.kind==='workload')!.roleArn);observations.push(got.id,arn);}
 }
 return {
 async attest(value,outer){try{
  const r=structuredClone(value);const p=request(r),signal=AbortSignal.any([AbortSignal.timeout(20000),...(outer?[outer]:[])]),observations:unknown[]=[];
  const rule=await api('events','DescribeRule',{Name:guardName,EventBusName:'default'},signal);check(rule.value.Arn===c.guardArn&&rule.value.Name===guardName&&rule.value.State==='ENABLED'&&rule.value.ScheduleExpression==='rate(1 minute)'&&rule.value.EventBusName==='default');
  const target=await api('events','ListTargetsByRule',{Rule:guardName,EventBusName:'default'},signal);check(!target.value.NextToken&&Array.isArray(target.value.Targets)&&target.value.Targets.length===1);same(target.value.Targets[0],{Id:'ttl-guard',Arn:c.functionArn,Input:awsGuardCanonical({schemaVersion:1,kind:'periodic',guardArn:c.guardArn,configurationDigest:digest})});
  const lambda=await api('lambda','GetFunctionConfiguration',{},signal,`/2015-03-31/functions/${encode(c.functionArn)}/configuration`,'GET'),f=lambda.value;
  verifyExecutionConfiguration(f);
  check(f.FunctionArn===c.functionArn&&f.Role===c.rolePolicies.find(r=>r.kind==='guard')!.roleArn&&f.CodeSha256===c.expectedCodeSha256&&f.Runtime==='python3.13'&&f.Handler==='guard.handler'&&f.State==='Active'&&f.LastUpdateStatus==='Successful'&&f.Environment?.Variables?.HIVEMIND_GUARD_SCHEMA==='1'&&f.Environment?.Variables?.HIVEMIND_GUARD_DIGEST===digest);check(f.Environment.Variables.HIVEMIND_GUARD_SCHEDULE_GROUP_ARN===c.scheduleGroupArn);same(JSON.parse(f.Environment.Variables.HIVEMIND_GUARD_MANIFEST),c.manifest);
  const invoke=await api('lambda','GetPolicy',{},signal,`/2015-03-31/functions/${encode(c.functionArn)}/policy`,'GET'),permission=data(JSON.parse(invoke.value.Policy));check(Array.isArray(permission.Statement)&&permission.Statement.length===1);const statement=permission.Statement[0];check(typeof statement.Sid==='string'&&statement.Sid.length>0&&statement.Sid.length<=128);same({...statement,Sid:undefined},{Sid:undefined,Effect:'Allow',Principal:{Service:'events.amazonaws.com'},Action:'lambda:InvokeFunction',Resource:c.functionArn,Condition:{ArnLike:{'AWS:SourceArn':c.guardArn},StringEquals:{'AWS:SourceAccount':c.accountId}}});
  const concurrency=await api('lambda','GetFunctionConcurrency',{},signal,`/2017-10-31/functions/${encode(c.functionArn)}/concurrency`,'GET');check(concurrency.value.ReservedConcurrentExecutions===undefined||Number.isSafeInteger(concurrency.value.ReservedConcurrentExecutions)&&concurrency.value.ReservedConcurrentExecutions>0);observations.push(invoke.id,concurrency.id);const installedAt=Date.parse(f.LastModified);check(Number.isSafeInteger(installedAt)&&installedAt>=0&&installedAt<=now());
  const tableName=c.manifest.registryTableArn.split('/').at(-1)!;const table=await api('dynamodb','DescribeTable',{TableName:tableName},signal);check(table.value.Table?.TableArn===c.manifest.registryTableArn&&table.value.Table?.TableStatus==='ACTIVE');same(table.value.Table.KeySchema,[{AttributeName:'owner',KeyType:'HASH'}]);same(table.value.Table.AttributeDefinitions,[{AttributeName:'owner',AttributeType:'S'}]);const ttl=await api('dynamodb','DescribeTimeToLive',{TableName:tableName},signal);check(ttl.value.TimeToLiveDescription?.TimeToLiveStatus==='DISABLED');observations.push(table.id,ttl.id);
  observations.push(rule.id,target.id,lambda.id,rule.value,target.value,f.CodeSha256,{Timeout:f.Timeout,MemorySize:f.MemorySize,Architectures:f.Architectures,VpcConfig:f.VpcConfig??{}},digest);await roles(signal,observations);signal.throwIfAborted();request(r);
  const bindingHash=hash(JSON.stringify(r)),guard:AwsTtlGuardEvidence={kind:'preexisting_termination_guard',guardArn:c.guardArn,evidenceId:awsGuardDigest({bindingHash,observations}),bindingHash,installedAt,observedAt:now(),validUntil:Math.min(c.manifest.validUntil,p.quote.validUntil),maxExposureMicros:p.quote.maxExposureMicros};
  for(const [key,value] of issued)if(value.at<now()-60000)issued.delete(key);check(issued.size<1000);issued.set(bindingHash,{guard:structuredClone(guard),at:now()});return guard;
 }catch{throw fail();}},
 async arm(value,evidence,outer){try{
  const r=structuredClone(value);request(r);const bindingHash=hash(JSON.stringify(r)),known=issued.get(bindingHash);check(known&&known.at>=now()-60000);same(evidence,known.guard);
  const name='hm-'+bindingHash.slice(0,48),timerArn=`arn:aws:scheduler:${c.region}:${c.accountId}:schedule/${group}/${name}`,signal=AbortSignal.any([AbortSignal.timeout(10000),...(outer?[outer]:[])]);
  const item={owner:{S:r.ownershipToken},schemaVersion:{N:'1'},configurationDigest:{S:digest},bindingHash:{S:bindingHash},requestJson:{S:awsGuardCanonical(r)},timerArn:{S:timerArn}};const tableName=c.manifest.registryTableArn.split('/').at(-1)!;try{await api('dynamodb','PutItem',{TableName:tableName,Item:item,ConditionExpression:'attribute_not_exists(#owner)',ExpressionAttributeNames:{'#owner':'owner'}},signal);}catch(error){if((error as {status?:number}).status!==400)throw error;}const saved=await api('dynamodb','GetItem',{TableName:tableName,Key:{owner:{S:r.ownershipToken}},ConsistentRead:true},signal);same(saved.value.Item,item);
  const target={Arn:c.functionArn,RoleArn:c.schedulerRoleArn,Input:awsGuardCanonical({schemaVersion:1,kind:'timer',guardArn:c.guardArn,configurationDigest:digest,timerArn,request:r}),RetryPolicy:{MaximumEventAgeInSeconds:3600,MaximumRetryAttempts:185}};
  const body={GroupName:group,ScheduleExpression:'at('+new Date(Math.ceil(r.expiresAt/1000)*1000).toISOString().slice(0,19)+')',ScheduleExpressionTimezone:'UTC',FlexibleTimeWindow:{Mode:'OFF'},State:'ENABLED',ActionAfterCompletion:'DELETE',ClientToken:hash('timer:'+bindingHash),Target:target};
  try{const created=await api('scheduler','CreateSchedule',body,signal,'/schedules/'+name);check(created.value.ScheduleArn===timerArn);}catch(error){if((error as {status?:number}).status!==409)throw error;}
  const actual=await api('scheduler','GetSchedule',{},signal,'/schedules/'+name+'?groupName='+encode(group),'GET');check(actual.value.Arn===timerArn&&actual.value.Name===name&&actual.value.GroupName===group);for(const field of ['ScheduleExpression','ScheduleExpressionTimezone','FlexibleTimeWindow','State','ActionAfterCompletion','Target'] as const)same(actual.value[field],body[field]);signal.throwIfAborted();check(now()<r.expiresAt);
  const result:AwsOwnershipTimerEvidence={kind:'owned_expiry_timer',guardArn:c.guardArn,timerArn,evidenceId:awsGuardDigest({bindingHash,timerArn,remote:actual.id,settings:body}),bindingHash,expiresAt:r.expiresAt};return result;
 }catch{throw fail();}}
 };
}
