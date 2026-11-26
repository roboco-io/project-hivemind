import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createAwsTtlGuardPort,awsGuardPolicies,awsGuardCanonical,awsGuardDigest,type AwsGuardOptions} from '../packages/adapters/src/autonomous-aws-guard.js';
import {externalAwsConfigurationHash} from '../packages/adapters/src/autonomous-external.js';
import type {AwsTtlGuardRequest} from '../packages/adapters/src/autonomous-external.js';
// Explicit FIXTURE account and synthetic credentials. No AWS connection or auth discovery.
const account='111111111111',region='ap-northeast-2',prefix='fixture-hivemind';
const guardArn=`arn:aws:events:${region}:${account}:rule/${prefix}`;
const now=Date.parse('2026-11-20T00:00:00Z');
const fixtureLaunchPolicy={accountId:account,region,workloadId:'fixture-workload',imageId:'ami-1234',instanceType:'t3.micro',subnetId:'subnet-1234',instanceProfileArn:`arn:aws:iam::${account}:instance-profile/${prefix}-workload`,maxLifetimeMs:3600000,maxUpperBoundMicros:100};
const fixtureConfigurationHash=externalAwsConfigurationHash(fixtureLaunchPolicy);
const request:AwsTtlGuardRequest={accountId:account,region,workloadId:'fixture-workload',actionId:'fixture-action',ownershipToken:'12345678-1234-4234-8234-123456789abc',clientToken:'a'.repeat(64),parametersHash:'b'.repeat(64),expiresAt:now+120000,maxExposureMicros:100,configurationHash:fixtureConfigurationHash};
const xml=(tag:string,value:string)=>`<${tag}>${value}</${tag}>`;
const encode=(v:unknown)=>encodeURIComponent(JSON.stringify(v));
function fixture(selectedRegion='ap-northeast-2'){
 const region=selectedRegion,guardArn=`arn:aws:events:${region}:${account}:rule/${prefix}`,functionArn=`arn:aws:lambda:${region}:${account}:function:${prefix}`;
 const calls:{url:string;init:RequestInit;body:any}[]=[],roles=['guard','scheduler','workload'].map(kind=>({kind:kind as 'guard'|'scheduler'|'workload',roleArn:`arn:aws:iam::${account}:role/${prefix}-${kind}`,boundaryArn:`arn:aws:iam::${account}:policy/${prefix}-${kind}`,inlinePolicyName:'guard-policy'}));
 const manifest={schemaVersion:1 as const,ownershipMode:'broker_uuid_registry_v1' as const,registryTableArn:`arn:aws:dynamodb:${region}:${account}:table/${prefix}-bindings`,guardArn,validUntil:now+86400000,profiles:[{workloadId:'fixture-workload',configurationHash:fixtureConfigurationHash,parameterPolicy:'opaque_broker_sha256' as const,launchHeadroomMs:30000,instanceProfileArn:`arn:aws:iam::${account}:instance-profile/${prefix}-workload`,maxLifetimeMs:3600000,quote:{source:'SYNTHETIC user quote',maxExposureMicros:100,validUntil:now+86400000}}]};
 if(region!=='ap-northeast-2')Object.assign(manifest,{region,allowedRegions:[region]});
 const config:AwsGuardOptions={...(region!=='ap-northeast-2'?{allowedRegions:[region]}:{}),enabled:true,accountId:account,region,guardArn,functionArn,scheduleGroupArn:`arn:aws:scheduler:${region}:${account}:schedule-group/${prefix}`,schedulerRoleArn:roles[1]!.roleArn,rolePolicies:roles,expectedCodeSha256:Buffer.alloc(32,1).toString('base64'),manifest,credentials:async()=>({accessKeyId:'FIXTURE_ACCESS_KEY',secretAccessKey:'FIXTURE_SECRET',sessionToken:'FIXTURE_SESSION'}),now:()=>now};
 let mutate=(value:any,_operation:string)=>value;let schedule:any;const registry=new Map<string,unknown>();
 config.fetchImpl=async(input,init)=>{
  const url=new URL(String(input)),headers=new Headers(init?.headers);assert.match(headers.get('authorization')!,/^AWS4-HMAC-SHA256 /);assert.equal(headers.get('x-amz-security-token'),'FIXTURE_SESSION');assert.equal(init?.redirect,'manual');
  const form=new URLSearchParams(String(init?.body??''));const operation=headers.get('x-amz-target')?.split('.').at(-1)??(url.hostname.startsWith('lambda.')?(url.pathname.endsWith('/policy')?'GetPolicy':url.pathname.endsWith('/concurrency')?'GetFunctionConcurrency':'GetFunctionConfiguration'):url.hostname.startsWith('scheduler.')?(init?.method==='POST'?'CreateSchedule':'GetSchedule'):form.get('Action')!);
  const body=headers.get('content-type')?.includes('json')?JSON.parse(String(init?.body??'{}')):Object.fromEntries(form);calls.push({url:url.href,init:init!,body});const policies=awsGuardPolicies(config);
  let value:any;
  if(operation==='DescribeRule')value={Arn:guardArn,Name:prefix,State:'ENABLED',ScheduleExpression:'rate(1 minute)',EventBusName:'default'};
  else if(operation==='ListTargetsByRule')value={Targets:[{Id:'ttl-guard',Arn:functionArn,Input:awsGuardCanonical({schemaVersion:1,kind:'periodic',guardArn,configurationDigest:awsGuardDigest(manifest)})}]};
  else if(operation==='GetFunctionConfiguration')value={FunctionArn:functionArn,Role:roles[0]!.roleArn,Runtime:'python3.13',Handler:'guard.handler',Timeout:55,MemorySize:256,Architectures:['x86_64'],VpcConfig:{SubnetIds:[],SecurityGroupIds:[],VpcId:'',Ipv6AllowedForDualStack:false},State:'Active',LastUpdateStatus:'Successful',CodeSha256:config.expectedCodeSha256,LastModified:new Date(now-10000).toISOString(),Environment:{Variables:{HIVEMIND_GUARD_SCHEMA:'1',HIVEMIND_GUARD_DIGEST:awsGuardDigest(manifest),HIVEMIND_GUARD_MANIFEST:awsGuardCanonical(manifest),HIVEMIND_GUARD_SCHEDULE_GROUP_ARN:config.scheduleGroupArn}}};
  else if(operation==='GetPolicy'&&url.hostname.startsWith('lambda.'))value={Policy:JSON.stringify({Version:'2012-10-17',Statement:[{Sid:'fixture',Effect:'Allow',Principal:{Service:'events.amazonaws.com'},Action:'lambda:InvokeFunction',Resource:functionArn,Condition:{ArnLike:{'AWS:SourceArn':guardArn},StringEquals:{'AWS:SourceAccount':account}}}]})};
  else if(operation==='GetFunctionConcurrency')value={};
  else if(operation==='DescribeTable')value={Table:{TableArn:manifest.registryTableArn,TableStatus:'ACTIVE',KeySchema:[{AttributeName:'owner',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'owner',AttributeType:'S'}]}};
  else if(operation==='DescribeTimeToLive')value={TimeToLiveDescription:{TimeToLiveStatus:'DISABLED'}};
  else if(operation==='PutItem'){const owner=body.Item.owner.S;if(registry.has(owner))return Response.json({}, {status:400});registry.set(owner,structuredClone(body.Item));value={};}
  else if(operation==='GetItem')value={Item:registry.get(body.Key.owner.S)};
  else if(operation==='CreateSchedule'){schedule={...body,Name:url.pathname.split('/').at(-1)};value={ScheduleArn:`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/${schedule.Name}`};}
  else if(operation==='GetSchedule')value={...schedule,Arn:`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/${schedule.Name}`};
  else {
   const role=roles.find(r=>r.roleArn.split('/').at(-1)===body.RoleName)||roles.find(r=>r.boundaryArn===body.PolicyArn)||roles[2]!;const docs=policies[role.kind];
   if(operation==='GetRole')value=xml('Role',xml('Arn',role.roleArn)+xml('AssumeRolePolicyDocument',encode(docs.trust))+xml('PermissionsBoundary',xml('PermissionsBoundaryArn',role.boundaryArn)));
   else if(operation==='ListRolePolicies')value=xml('PolicyNames',xml('member',role.inlinePolicyName))+xml('IsTruncated','false');
   else if(operation==='ListAttachedRolePolicies')value=xml('AttachedPolicies','')+xml('IsTruncated','false');
   else if(operation==='GetRolePolicy')value=xml('PolicyDocument',encode(docs.policy));
   else if(operation==='GetPolicy')value=xml('Policy',xml('Arn',role.boundaryArn)+xml('DefaultVersionId','v1'));
   else if(operation==='GetPolicyVersion')value=xml('PolicyVersion',xml('Document',encode(docs.policy))+xml('IsDefaultVersion','true'));
   else if(operation==='GetInstanceProfile')value=xml('InstanceProfile',xml('Arn',manifest.profiles[0]!.instanceProfileArn)+xml('Roles',xml('member',xml('Arn',roles[2]!.roleArn))));
   else throw Error('Unexpected operation '+operation);
   return new Response(`<${operation}Response><${operation}Result>${mutate(value,operation)}</${operation}Result><ResponseMetadata><RequestId>fixture-request</RequestId></ResponseMetadata></${operation}Response>`,{headers:{'x-amzn-requestid':'fixture-request'}});
  }
  return Response.json(mutate(value,operation),{headers:{'x-amzn-requestid':'fixture-request'}});
 };
 return {config,calls,mutate(fn:typeof mutate){mutate=fn;}};
}
test('FIXTURE SigV4 read attestation and owned schedule precede any provider create',async()=>{
 const f=fixture(),port=createAwsTtlGuardPort(f.config),evidence=await port.attest(request);assert.equal(evidence.guardArn,guardArn);assert.equal(evidence.bindingHash,createHash('sha256').update(JSON.stringify(request)).digest('hex'));assert.equal(evidence.maxExposureMicros,100);assert.ok(f.calls.length>10);assert.ok(f.calls.every(c=>!String(c.init.body).includes('RunInstances')));
 const timer=await port.arm(request,evidence);assert.equal(timer.expiresAt,request.expiresAt);assert.ok(timer.timerArn.startsWith(`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/`));const creation=f.calls.find(c=>c.init.method==='POST'&&c.url.includes('scheduler.'))!;assert.equal(creation.body.ActionAfterCompletion,'DELETE');assert.equal(creation.body.Target.RoleArn,f.config.schedulerRoleArn);assert.equal(JSON.parse(creation.body.Target.Input).request.clientToken,request.clientToken);
});
test('missing config denies without any credential discovery',async()=>{await assert.rejects(createAwsTtlGuardPort().attest(request));const f=fixture();let calls=0;f.config.enabled=false;f.config.credentials=async()=>{calls++;throw Error();};await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));assert.equal(calls,0);});
test('FIXTURE admission binds owner, workload, parameter hash, configuration and trusted quote before reads',async()=>{
 for(const patch of [{ownershipToken:'other'},{workloadId:'other'},{configurationHash:'d'.repeat(64)},{parametersHash:'not-a-sha256'},{accountId:'222222222222'},{region:'us-east-1'},{expiresAt:now-1},{expiresAt:now+86400001},{maxExposureMicros:1}]){const f=fixture();await assert.rejects(createAwsTtlGuardPort(f.config).attest({...request,...patch}));assert.equal(f.calls.length,0);}
});
test('remote disabled rule, target, Lambda, role policy and boundary mismatches deny admission',async()=>{
 for(const change of [(v:any,op:string)=>op==='DescribeRule'?{...v,State:'DISABLED'}:v,(v:any,op:string)=>op==='ListTargetsByRule'?{...v,NextToken:'unseen-targets'}:v,(v:any,op:string)=>op==='GetFunctionConfiguration'?{...v,CodeSha256:Buffer.alloc(32,2).toString('base64')}:v,(v:any,op:string)=>op==='GetFunctionConfiguration'?{...v,Role:`arn:aws:iam::${account}:role/other`}:v,(v:any,op:string)=>op==='GetRole'?v.replace(/PermissionsBoundaryArn>/g,'OtherBoundaryArn>'):v,(v:any,op:string)=>op==='GetRolePolicy'?xml('PolicyDocument',encode({Version:'2012-10-17',Statement:[]})):v,(v:any,op:string)=>op==='ListAttachedRolePolicies'?xml('AttachedPolicies',xml('member','unexpected'))+xml('IsTruncated','false'):v,(v:any,op:string)=>op==='GetFunctionConcurrency'?{ReservedConcurrentExecutions:0}:v,(v:any,op:string)=>op==='GetPolicy'&&typeof v==='object'?{Policy:JSON.stringify({Statement:[]})}:v]){const f=fixture();f.mutate(change);await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));assert.ok(f.calls.every(call=>!call.url.includes('scheduler.')));}
});
test('arm rejects forged, different request and mismatched read-back before provider admission',async()=>{
 const f=fixture(),port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);
 await assert.rejects(port.arm(request,{...guard,evidenceId:'invented'}));await assert.rejects(port.arm({...request,actionId:'other'},guard));
 f.mutate((v,op)=>op==='GetSchedule'?{...v,Target:{...v.Target,RoleArn:'arn:aws:iam::111111111111:role/other'}}:v);await assert.rejects(port.arm(request,guard));
});
test('FIXTURE idempotent timer conflict only succeeds after exact owned read-back',async()=>{
 const f=fixture(),base=f.config.fetchImpl!;let creates=0;f.config.fetchImpl=async(input,init)=>{if(String(input).includes('scheduler.')&&init?.method==='POST'&&++creates>1)return Response.json({}, {status:409});return base(input,init);};const port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);const first=await port.arm(request,guard),second=await port.arm(request,guard);assert.equal(first.timerArn,second.timerArn);assert.equal(creates,2);
});
test('lost create acknowledgement never yields timer evidence',async()=>{const f=fixture(),base=f.config.fetchImpl!;f.config.fetchImpl=async(input,init)=>{if(String(input).includes('scheduler.')&&init?.method==='POST')throw Error('synthetic lost ACK');return base(input,init);};const port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);await assert.rejects(port.arm(request,guard));});
test('aborted admission cannot hang on a fetch that ignores signal',async()=>{
 const f=fixture();f.config.fetchImpl=()=>new Promise(()=>{});const controller=new AbortController();const pending=createAwsTtlGuardPort(f.config).attest(request,controller.signal);controller.abort();await assert.rejects(pending);
});
test('independent verifier checks SigV4 body/path/query binding including global IAM region',async()=>{
 const f=fixture();await createAwsTtlGuardPort(f.config).attest(request);
 const digest=(v:string)=>createHash('sha256').update(v).digest('hex');const mac=(k:string|Uint8Array,v:string)=>createHmac('sha256',k).update(v).digest();const uri=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 for(const call of f.calls){const url=new URL(call.url),h=new Headers(call.init.headers),auth=h.get('authorization')!;const match=/Credential=FIXTURE_ACCESS_KEY\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(auth)!;assert.ok(match);const scope=match[1]!,names=match[2]!.split(';'),date=h.get('x-amz-date')!,parts=scope.split('/');assert.equal(parts[1],url.hostname==='iam.amazonaws.com'?'us-east-1':'ap-northeast-2');const query=[...url.searchParams].sort().map(([k,v])=>uri(k)+'='+uri(v)).join('&');const canonical=[call.init.method,uri(url.pathname).replace(/%2F/g,'/'),query,names.map(n=>n+':'+h.get(n)!.trim()+'\n').join(''),names.join(';'),digest(String(call.init.body??''))].join('\n');const key=mac(mac(mac(mac('AWS4FIXTURE_SECRET',parts[0]!),parts[1]!),parts[2]!),parts[3]!);assert.equal(createHmac('sha256',key).update('AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+digest(canonical)).digest('hex'),match[3]);}
});
test('attestation evidence contains no synthetic credentials and refuses stale evidence',async()=>{
 const f=fixture();let clock=now;f.config.now=()=>clock;const port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);assert.equal(JSON.stringify(guard).includes('FIXTURE_SECRET'),false);assert.equal(JSON.stringify(guard).includes('FIXTURE_SESSION'),false);clock+=61000;await assert.rejects(port.arm(request,guard));
});
import {ExternalBroker} from '../packages/core/src/autonomous-external.js';
test('two actual broker-generated UUID owners and lifetime hashes use one unchanged dynamic guard manifest',async()=>{
 const f=fixture(),port=createAwsTtlGuardPort(f.config),manifestBefore=awsGuardCanonical(f.config.manifest);let state:any={version:1,approvals:{},actions:{}};const seen:string[]=[];
 const profile={id:'fixture-profile',enabled:true,provider:'aws' as const,credentialRef:'fixture',target:{accountId:account,region,workloadId:'fixture-workload'},operations:['aws.spot.start' as const],maxLifetimeMs:3600000,upperBoundMicros:100,maxActiveActions:2};
 const broker=new ExternalBroker({now:()=>now,store:{transaction<T>(fn:(s:any)=>T){const copy=structuredClone(state),result=fn(copy);state=copy;return structuredClone(result);}},registry:{get:()=>profile},resolver:{async withCredential(_ref,_scope,fn){return fn({});}},transport:{async execute(inv){
  const dynamic:AwsTtlGuardRequest={accountId:account,region,workloadId:'fixture-workload',actionId:inv.actionId,ownershipToken:inv.ownershipToken,clientToken:createHash('sha256').update(inv.idempotencyKey).digest('hex'),parametersHash:inv.parametersHash,expiresAt:inv.expiresAt,maxExposureMicros:inv.profile.upperBoundMicros,configurationHash:fixtureConfigurationHash};
  const guard=await port.attest(dynamic),timer=await port.arm(dynamic,guard);seen.push(timer.timerArn);return {ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:timer.evidenceId,outcome:'succeeded' as const,effect:'resource' as const,resource:{id:'fixture-'+inv.actionId,cleanupRequired:true},billing:{verifiedCostMicros:null,final:false}};
 },async inspect(){return null;},async cleanup(){},async confirmAbsent(){return false;}}});
 broker.serverApprove({taskId:'fixture-task',revision:1,profileId:profile.id,endsAt:now+3600000,budgetMicros:200});
 const base={taskId:'fixture-task',revision:1,profileId:profile.id,operation:'aws.spot.start' as const};const a=await broker.execute({...base,requestId:'first',parameters:{lifetimeMs:120000}}),b=await broker.execute({...base,requestId:'second',parameters:{lifetimeMs:180000}});
 assert.notEqual(a.ownershipToken,b.ownershipToken);assert.notEqual(a.parametersHash,b.parametersHash);assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);assert.equal(awsGuardCanonical(f.config.manifest),manifestBefore);assert.equal(manifestBefore.includes(a.ownershipToken),false);
});
test('legacy static manifest and malformed owner/hash have no dynamic admission capability',async()=>{
 const f=fixture();delete (f.config.manifest as any).ownershipMode;await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));assert.equal(f.calls.length,0);
 for(const patch of [{ownershipToken:'non-uuid'},{ownershipToken:'12345678-1234-1234-8234-123456789abc'},{parametersHash:'not-a-sha256'}]){const g=fixture();await assert.rejects(createAwsTtlGuardPort(g.config).attest({...request,...patch}));assert.equal(g.calls.length,0);}
});
test('dynamic registry prevents owner reuse or a forged request-marker read-back',async()=>{
 const f=fixture(),port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);await port.arm(request,guard);
 const other={...request,actionId:'different-action',clientToken:'d'.repeat(64)};const second=await port.attest(other);await assert.rejects(port.arm(other,second));
 const broken=fixture();broken.mutate((v,op)=>op==='GetItem'?{...v,Item:{...v.Item,bindingHash:{S:'0'.repeat(64)}}}:v);const gate=createAwsTtlGuardPort(broken.config),proof=await gate.attest(request);await assert.rejects(gate.arm(request,proof));assert.equal(broken.calls.some(c=>c.url.includes('scheduler.')),false);
});
test('dynamic registry must exist and must retain bindings beyond oneoff expiry',async()=>{
 for(const change of [(v:any,op:string)=>op==='DescribeTable'?{Table:{...v.Table,TableArn:'arn:aws:dynamodb:ap-northeast-2:222222222222:table/other'}}:v,(v:any,op:string)=>op==='DescribeTimeToLive'?{TimeToLiveDescription:{TimeToLiveStatus:'ENABLED'}}:v]){const f=fixture();f.mutate(change);await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));}
});
test('P1 Lambda Timeout 1 cannot attest a guard synthesized with Timeout 55',async()=>{
 const f=fixture();f.mutate((v,operation)=>operation==='GetFunctionConfiguration'?{...v,Timeout:1}:v);
 await assert.rejects(createAwsTtlGuardPort(f.config).attest(request),{message:'AWS TTL guard unavailable'});
 assert.equal(f.calls.some(call=>call.url.includes('scheduler.')),false);
});
test('guard rejects timeout memory architecture and VPC execution-envelope drift before arming',async()=>{
 const patches=[{Timeout:54},{Timeout:undefined},{Timeout:'55'},{MemorySize:128},{MemorySize:512},{MemorySize:undefined},{Architectures:['arm64']},{Architectures:[]},{Architectures:undefined},{VpcConfig:null},{VpcConfig:{VpcId:'vpc-fixture',SubnetIds:[],SecurityGroupIds:[]}},{VpcConfig:{SubnetIds:['subnet-fixture']}},{VpcConfig:{SecurityGroupIds:['sg-fixture']}},{VpcConfig:{Ipv6AllowedForDualStack:true}},{VpcConfig:{SubnetIds:'not-an-array'}},{VpcConfig:{unknown:'changed-network'}}];
 for(const patch of patches){const f=fixture();f.mutate((v,op)=>op==='GetFunctionConfiguration'?{...v,...patch}:v);await assert.rejects(createAwsTtlGuardPort(f.config).attest(request),{message:'AWS TTL guard unavailable'});assert.equal(f.calls.some(call=>call.url.includes('scheduler.')),false);}
});
test('guard accepts the actual non-VPC execution envelope and retains concurrency denial',async()=>{
 for(const VpcConfig of [undefined,{}, {SubnetIds:[],SecurityGroupIds:[],VpcId:'',Ipv6AllowedForDualStack:false}]){const f=fixture();f.mutate((v,op)=>op==='GetFunctionConfiguration'?{...v,VpcConfig}:v);assert.equal((await createAwsTtlGuardPort(f.config).attest(request)).kind,'preexisting_termination_guard');}
 const f=fixture();f.mutate((v,op)=>op==='GetFunctionConcurrency'?{ReservedConcurrentExecutions:0}:v);await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));
});
test('actual provider transport and concrete guard admit two broker UUIDs using the shared launch-policy hash',async()=>{
 const provider=await import('../packages/adapters/src/autonomous-external.js');
 const configurationHash=Reflect.get(provider,'externalAwsConfigurationHash') as (value:NonNullable<import('../packages/adapters/src/autonomous-external.js').ExternalProviderOptions['aws']>)=>string;
 assert.equal(typeof configurationHash,'function','Dirac-owned shared hash helper must be installed');
 const f=fixture();
 const aws={billingPolicy:'reserved_ceiling_only' as const,enabled:true,accountId:account,region,workloadId:'fixture-workload',imageId:'ami-1234',instanceType:'t3.micro',subnetId:'subnet-1234',instanceProfileArn:`arn:aws:iam::${account}:instance-profile/${prefix}-workload`,maxLifetimeMs:3600000,credentialRef:'fixture',maxUpperBoundMicros:100};
 const reordered=Object.fromEntries(Object.entries(aws).reverse()) as typeof aws;
 assert.equal(configurationHash(aws),configurationHash(reordered));assert.equal(configurationHash({...aws,enabled:false}),configurationHash(aws));
 f.config.manifest.profiles[0]!.configurationHash=configurationHash(aws);
 const unchanged=awsGuardCanonical(f.config.manifest),guard=createAwsTtlGuardPort(f.config),launched:{tags:Map<string,string>;token:string;id:string}[]=[];
 const providerCalls:string[]=[];
 const fakeAws:typeof fetch=async(_url,init)=>{
  const params=new URLSearchParams(String(init?.body)),operation=params.get('Action')!;providerCalls.push(operation);
  if(operation==='GetCallerIdentity')return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${account}</Account><Arn>arn:aws:iam::${account}:role/fixture-provider</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`);
  if(operation==='RunInstances'){
   const token=params.get('ClientToken')!;const registry=f.calls.filter(call=>call.body.Item?.requestJson).map(call=>JSON.parse(call.body.Item.requestJson.S));const armed=registry.find(r=>r.clientToken===token);assert.ok(armed,'immutable registry binding must precede RunInstances');
   const schedules=f.calls.filter(call=>call.url.includes('scheduler.')&&call.init.method==='GET');assert.ok(schedules.some(call=>call.url.includes('/hm-'+createHash('sha256').update(JSON.stringify(armed,Object.keys(request))).digest('hex').slice(0,48))));
   const tags=new Map<string,string>();for(let index=1;params.has(`TagSpecification.1.Tag.${index}.Key`);index++)tags.set(params.get(`TagSpecification.1.Tag.${index}.Key`)!,params.get(`TagSpecification.1.Tag.${index}.Value`)!);
   assert.equal(params.get('TagSpecification.2.ResourceType'),'volume');for(let index=1;index<=7;index++){assert.equal(params.get(`TagSpecification.2.Tag.${index}.Key`),params.get(`TagSpecification.1.Tag.${index}.Key`));assert.equal(params.get(`TagSpecification.2.Tag.${index}.Value`),params.get(`TagSpecification.1.Tag.${index}.Value`));}
   assert.equal(tags.get('hivemind:owner'),armed.ownershipToken);assert.equal(tags.get('hivemind:parameters'),armed.parametersHash);assert.equal(tags.get('hivemind:guard'),guardArn);assert.ok(tags.get('hivemind:timer')?.startsWith(`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/hm-`));
   launched.push({tags,token,id:'i-'+String(launched.length+1).padStart(17,'0')});return new Response('<RunInstancesResponse><requestId>fixture-create</requestId></RunInstancesResponse>');
  }
  assert.equal(operation,'DescribeInstances');const own=params.get('Filter.1.Value.1'),token=params.get('Filter.2.Value.1');const row=launched.find(item=>item.tags.get('hivemind:owner')===own&&item.token===token);
  const instances=row?`<item><ownerId>${account}</ownerId><instancesSet><item><instanceId>${row.id}</instanceId><clientToken>${row.token}</clientToken><instanceState><name>running</name></instanceState><tagSet>${[...row.tags].map(([key,value])=>`<item><key>${key}</key><value>${value}</value></item>`).join('')}</tagSet></item></instancesSet></item>`:'';
  return new Response(`<DescribeInstancesResponse><requestId>fixture-describe</requestId><reservationSet>${instances}</reservationSet></DescribeInstancesResponse>`);
 };
 const transport=provider.createExternalProviderTransport({enabled:true,aws:reordered,awsTtlGuard:{guardArn,port:guard},artifacts:{async load(){throw Error('No artifact load for fixture EC2');}},fetch:fakeAws,now:()=>now});
 let state:any={version:1,approvals:{},actions:{}};
 const profile={id:'actual-provider',enabled:true,provider:'aws' as const,credentialRef:'fixture',target:{accountId:account,region,workloadId:'fixture-workload'},operations:['aws.spot.start' as const],maxLifetimeMs:3600000,upperBoundMicros:100,maxActiveActions:2};
 const broker=new ExternalBroker({now:()=>now,store:{transaction<T>(fn:(s:any)=>T){const candidate=structuredClone(state),value=fn(candidate);state=candidate;return structuredClone(value);}},registry:{get:()=>profile},resolver:{async withCredential(_ref,_scope,consume){return consume({provider:'aws' as const,accessKeyId:'FIXTURE_PROVIDER',secretAccessKey:'FIXTURE_PROVIDER_SECRET'});}},transport});
 broker.serverApprove({taskId:'actual-provider-task',revision:1,profileId:profile.id,endsAt:now+3600000,budgetMicros:200});
 for(const [index,lifetimeMs] of [120000,180000].entries())await broker.execute({taskId:'actual-provider-task',revision:1,profileId:profile.id,requestId:'actual-'+index,operation:'aws.spot.start',parameters:{lifetimeMs}});
 assert.equal(launched.length,2);assert.notEqual(launched[0]!.tags.get('hivemind:owner'),launched[1]!.tags.get('hivemind:owner'));assert.notEqual(launched[0]!.tags.get('hivemind:parameters'),launched[1]!.tags.get('hivemind:parameters'));assert.equal(awsGuardCanonical(f.config.manifest),unchanged);assert.equal(providerCalls.filter(op=>op==='RunInstances').length,2);
});
test('R11 admission rejects legacy guard IAM that cannot delete owned residual volumes',async()=>{
 const f=fixture();const legacy:any=structuredClone(awsGuardPolicies(f.config).guard.policy);
 legacy.Statement=legacy.Statement.filter((s:any)=>!s.Action.includes('ec2:DeleteVolume')).map((s:any)=>({...s,Action:s.Action.filter((action:string)=>action!=='ec2:DescribeVolumes')}));
 f.mutate((value,operation)=>operation==='GetRolePolicy'?xml('PolicyDocument',encode(legacy)):value);
 await assert.rejects(createAwsTtlGuardPort(f.config).attest(request),{message:'AWS TTL guard unavailable'});assert.equal(f.calls.some(call=>call.url.includes('scheduler.')),false);
});

test('Ohio concrete guard attestation and timer use selected regional endpoints and reject foreign ARN',async()=>{
 const f=fixture('us-east-2'),r={...request,region:'us-east-2'},port=createAwsTtlGuardPort(f.config);
 const evidence=await port.attest(r);const timer=await port.arm(r,evidence);assert.match(timer.timerArn,/arn:aws:scheduler:us-east-2:/);
 for(const call of f.calls)assert.ok(new URL(call.url).hostname==='iam.amazonaws.com'||new URL(call.url).hostname.includes('.us-east-2.'));
 for(const patch of [{allowedRegions:undefined},{guardArn:f.config.guardArn.replace('us-east-2','ap-northeast-2')},{manifest:{...f.config.manifest,region:'ap-northeast-2'}}]){
  const denied=fixture('us-east-2');Object.assign(denied.config,patch);await assert.rejects(createAwsTtlGuardPort(denied.config).attest(r));assert.equal(denied.calls.length,0);
 }
});

test('Workers-compatible guard fetch avoids unsupported redirect error mode',async()=>{
 const f=fixture(),base=f.config.fetchImpl!;f.config.fetchImpl=async(input,init)=>{if(init?.redirect==='error')throw new TypeError('Unsupported redirect mode: error');return base(input,init);};
 const port=createAwsTtlGuardPort(f.config),guard=await port.attest(request);await port.arm(request,guard);assert.ok(f.calls.length>10);assert.ok(f.calls.every(c=>c.init.redirect==='manual'));
});
test('guard refuses 302 without following location or admitting a timer',async()=>{
 const f=fixture();const calls:{url:string;redirect:RequestRedirect|undefined}[]=[];f.config.fetchImpl=async(input,init)=>{calls.push({url:String(input),redirect:init?.redirect});return new Response('redirect',{status:302,headers:{location:'https://foreign.example.org/credential-target'}});};
 await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));assert.equal(calls.length,1);assert.equal(calls[0]!.redirect,'manual');assert.notEqual(new URL(calls[0]!.url).hostname,'foreign.example.org');
});
test('guard rejects a response marked redirected even when status is 200',async()=>{
 const f=fixture();let calls=0;f.config.fetchImpl=async()=>{calls++;const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;};await assert.rejects(createAwsTtlGuardPort(f.config).attest(request));assert.equal(calls,1);
});
test('delegated upload attestation accepts exact workload S3/GSC inline and boundary documents',async()=>{
 const f=fixture();f.config.manifest.delegatedUpload={bucket:'approved-models',prefix:'tasks/t1/',maxScopedSeconds:60};
 const evidence=await createAwsTtlGuardPort(f.config).attest(request);assert.ok(evidence);assert.ok(f.calls.some(c=>c.body.Action==='GetRolePolicy'));
});
test('delegated upload attestation rejects legacy inline or boundary policy despite unchanged guard protections',async()=>{
 for(const operation of ['GetRolePolicy','GetPolicyVersion']){
  const f=fixture();const old=awsGuardPolicies(f.config).workload.policy;
  f.config.manifest.delegatedUpload={bucket:'approved-models',prefix:'tasks/t1/',maxScopedSeconds:60};const current=awsGuardPolicies(f.config).workload.policy;
  f.mutate((value,op)=>op===operation&&typeof value==='string'?value.replace(encode(current),encode(old)):value);
  await assert.rejects(createAwsTtlGuardPort(f.config).attest(request),/AWS TTL guard unavailable/);
 }
});
