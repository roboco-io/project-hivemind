import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {externalParametersHash} from '../packages/core/src/autonomous-external.js';
import {createAwsTtlGuardPort,awsGuardCanonical,awsGuardDigest,awsGuardPolicies,type AwsGuardOptions} from '../packages/adapters/src/autonomous-aws-guard.ts';
import type {ExternalInvocation,ExternalInspection} from '../packages/contracts/src/autonomous-external.js';
// Dynamic import keeps the first red about missing factory behavior, not static resolution.
async function factory(){const module=await import('../packages/adapters/src/autonomous-external.js');return module.createExternalProviderTransport;}
function receiptOnly(value:ExternalInspection){assert.ok(!value||!('state' in value));return value;}
const profile={id:'p',enabled:true,provider:'aws' as const,credentialRef:'ref',target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'w'},operations:['aws.spot.start' as const],maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1};
const invocation:ExternalInvocation={actionId:'a',taskId:'t',revision:1,profile,operation:'aws.spot.start',parameters:{lifetimeMs:1000},parametersHash:'a'.repeat(64),ownershipToken:'owner',idempotencyKey:'idem',expiresAt:2000};
invocation.parametersHash=externalParametersHash(profile,invocation.operation,invocation.parameters);
const aws={enabled:true,accountId:'123456789012',region:'ap-northeast-2',workloadId:'w',imageId:'ami-1234',instanceType:'t3.micro',subnetId:'subnet-1234',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/worker',maxLifetimeMs:60000,credentialRef:'ref',maxUpperBoundMicros:10,billingPolicy:'reserved_ceiling_only' as const};
const identityXml='<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/worker</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>';
const credential={provider:'aws' as const,accessKeyId:'TESTACCESS',secretAccessKey:'synthetic-secret'};
const artifacts={async load(_digest:string){return {files:[]};}};
test('disabled transports fail closed before any HTTP',async()=>{let calls=0;const create=await factory();const port=create({aws,artifacts,fetch:async()=>{calls++;throw Error('unexpected');}});await assert.rejects(port.execute(invocation,credential),/External provider unavailable/);assert.equal(calls,0);});
function verifySignature(url:string,init:RequestInit){
 const headers=new Headers(init.headers),authorization=headers.get('authorization')!;const match=/^AWS4-HMAC-SHA256 Credential=TESTACCESS\/(\d{8})\/ap-northeast-2\/(ec2|sts)\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(authorization);assert.ok(match);
 const signed=match[3]!,canonicalHeaders=signed.split(';').map(k=>`${k}:${headers.get(k)!.trim()}\n`).join('');
 const canonical=['POST',new URL(url).pathname,'',canonicalHeaders,signed,hash(String(init.body))].join('\n');
 const scope=`${match[1]}/ap-northeast-2/${match[2]}/aws4_request`,toSign=['AWS4-HMAC-SHA256',headers.get('x-amz-date'),scope,hash(canonical)].join('\n');
 let key:Buffer=Buffer.from('AWS4synthetic-secret');for(const part of [match[1]!,'ap-northeast-2',match[2]!,'aws4_request'])key=createHmac('sha256',key).update(part).digest();
 assert.equal(match[4],createHmac('sha256',key).update(toSign).digest('hex'));
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const marker=(i:ExternalInvocation)=>'hivemind:'+hash(JSON.stringify([i.ownershipToken,i.idempotencyKey,i.parametersHash]));
const artifact={files:[{path:'README.md',contentBase64:Buffer.from('hello').toString('base64')}]};
const artifactDigest=digest(artifact);
const blob=createHash('sha1').update(Buffer.concat([Buffer.from('blob 5\0'),Buffer.from('hello')])).digest('hex');
const sha='1'.repeat(40),next='2'.repeat(40),tree='3'.repeat(40);
function inv(provider:'hf'|'github'):ExternalInvocation {
 const i:ExternalInvocation={...invocation,profile:{...profile,provider,target:provider==='hf'?{repository:'owner/repo',revision:'main'}:{repository:'owner/repo',branch:'work'},operations:provider==='hf'?['hf.model.commit']:['github.branch.push']} as ExternalInvocation['profile'],operation:provider==='hf'?'hf.model.commit':'github.branch.push',parameters:provider==='hf'?{artifactDigest,message:'files'}:{artifactDigest,expectedHead:sha}};
 i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);return i;
}
const guardArn='arn:aws:events:ap-northeast-2:123456789012:rule/hivemind-ttl';
// Synthetic remote enforcement evidence only; no production guard is installed here.
const syntheticGuard={guardArn,port:{
 async attest(r:any){return {kind:'preexisting_termination_guard' as const,guardArn,evidenceId:'synthetic-observation',bindingHash:digest(r),installedAt:0,observedAt:1000,validUntil:r.expiresAt,maxExposureMicros:r.maxExposureMicros};},
 async arm(r:any){return {kind:'owned_expiry_timer' as const,guardArn,timerArn:'arn:aws:scheduler:ap-northeast-2:123456789012:schedule/hivemind/hm-'+digest(r).slice(0,48),evidenceId:'synthetic-timer',bindingHash:digest(r),expiresAt:r.expiresAt};}
}};
const artifactLoader={async load(){return structuredClone(artifact);}};
test('AWS fixed endpoint SigV4 start discovers provider-owned instance and confirms termination',async()=>{
 const calls:{url:string;body:URLSearchParams;headers:Headers}[]=[];let terminated=false;
 const xml=()=>`<DescribeInstancesResponse><requestId>req-1</requestId><reservationSet><item><ownerId>123456789012</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${hash('idem')}</clientToken><instanceState><name>${terminated?'terminated':'running'}</name></instanceState><tagSet><item><key>hivemind:owner</key><value>owner</value></item><item><key>hivemind:request</key><value>${hash('idem')}</value></item><item><key>hivemind:parameters</key><value>${invocation.parametersHash}</value></item><item><key>hivemind:workload</key><value>w</value></item><item><key>hivemind:guard</key><value>${guardArn}</value></item><item><key>hivemind:expires</key><value>${invocation.expiresAt}</value></item><item><key>hivemind:timer</key><value>arn:aws:scheduler:ap-northeast-2:123456789012:schedule/hivemind/hm-${digest({accountId:aws.accountId,region:aws.region,workloadId:aws.workloadId,actionId:invocation.actionId,ownershipToken:invocation.ownershipToken,clientToken:hash(invocation.idempotencyKey),parametersHash:invocation.parametersHash,expiresAt:invocation.expiresAt,maxExposureMicros:invocation.profile.upperBoundMicros,configurationHash:awsGuardDigest(launchPolicy(aws))}).slice(0,48)}</value></item></tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
 const fake:typeof fetch=async(url,init)=>{assert.equal(init?.redirect,'manual');verifySignature(String(url),init!);const body=new URLSearchParams(String(init?.body));calls.push({url:String(url),body,headers:new Headers(init?.headers)});const action=body.get('Action');if(action==='GetCallerIdentity')return new Response(identityXml);if(action==='DescribeVolumes')return new Response('<DescribeVolumesResponse><requestId>vol-1</requestId><volumeSet></volumeSet></DescribeVolumesResponse>');if(action==='TerminateInstances'){terminated=true;return new Response('<TerminateInstancesResponse><requestId>req-2</requestId></TerminateInstancesResponse>');}return new Response(action==='RunInstances'?'<RunInstancesResponse><requestId>req-0</requestId></RunInstancesResponse>':xml());};
 const create=await factory();const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,fetch:fake,now:()=>1000});const receipt=await port.execute(invocation,credential);assert.equal(receipt.resource?.id,'i-1234abcd');assert.equal(receipt.billing.verifiedCostMicros,null);const start=calls.find(c=>c.body.get('Action')==='RunInstances')!;assert.equal(start.url,'https://ec2.ap-northeast-2.amazonaws.com/');assert.match(start.headers.get('authorization')!,/^AWS4-HMAC-SHA256 /);assert.equal(start.body.get('ImageId'),aws.imageId);assert.equal(start.body.get('ClientToken'),hash('idem'));
 assert.equal(await port.confirmAbsent(invocation,receipt.resource!,credential),false);await port.cleanup(invocation,receipt.resource!,credential);assert.equal(await port.confirmAbsent(invocation,receipt.resource!,credential),true);assert.ok(!JSON.stringify(receipt).includes('synthetic-secret'));
});
test('HF commits only immutable files to an existing private fixed repo with parent and provider proof',async()=>{
 const i=inv('hf');let posted='';const fake:typeof fetch=async(url,init)=>{const path=new URL(String(url)).pathname;if(init?.method==='POST'){posted=String(init.body);return Response.json({commitOid:next});}if(path.includes('/commits/'))return Response.json(posted?[{id:next,title:marker(i)}]:[]);return Response.json({private:true,sha:path.endsWith(next)?next:sha,siblings:[{rfilename:'README.md',blobId:blob}]});};
 const create=await factory(),port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,fetch:fake,now:()=>1000});const r=await port.execute(i,{provider:'hf',token:'synthetic-hf'});assert.equal(r.effect,'retained');const lines=posted.trim().split('\n').map(s=>JSON.parse(s));assert.equal(lines[0]?.value.parentCommit,sha);assert.equal(lines[1]?.key,'file');assert.equal(lines[1]?.value.path,'README.md');assert.equal(r.billing.verifiedCostMicros,null);assert.ok(!JSON.stringify(r).includes('synthetic-hf'));
});
test('GitHub commits exact artifact through fixed GraphQL expectedHeadOid CAS',async()=>{
 const i=inv('github');const requests:{path:string;method:string;body:any}[]=[];
 const fake:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({path,method,body});
  if(path==='/graphql')return Response.json({data:{createCommitOnBranch:{commit:{oid:next}}}});
  if(path.endsWith('/git/ref/heads/work'))return Response.json({object:{sha}});
  if(path.includes('/git/trees/'))return Response.json({sha:tree,truncated:false,tree:[{path:'README.md',mode:'100644',type:'blob',sha:blob}]});
  return Response.json({sha:path.endsWith(next)?next:sha,message:marker(i),tree:{sha:tree},parents:[{sha}]});
 };
 const create=await factory(),port=create({enabled:true,github:{enabled:true,repository:'owner/repo',branch:'work'},artifacts:artifactLoader,fetch:fake,now:()=>1000});
 const r=await port.execute(i,{provider:'github',token:'synthetic-gh'});assert.equal(r.effect,'retained');
 const mutations=requests.filter(r=>r.method!=='GET');assert.equal(mutations.length,1);assert.equal(mutations[0]?.path,'/graphql');
 const input=mutations[0]!.body.variables.input;assert.equal(input.expectedHeadOid,sha);assert.deepEqual(input.branch,{repositoryNameWithOwner:'owner/repo',branchName:'work'});
 assert.deepEqual(input.fileChanges,{additions:[{path:'README.md',contents:artifact.files[0]!.contentBase64}]});assert.equal(input.message.headline,marker(i));
});
test('target mismatch, credential mismatch, bad artifact and raw HTTP errors fail safely',async()=>{
 let calls=0;const create=await factory(),port=create({enabled:true,aws,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async()=>{calls++;throw Error('synthetic-secret');}});
 await assert.rejects(port.execute({...invocation,profile:{...profile,target:{...profile.target,accountId:'999999999999'}}},credential),/^Error: External provider unavailable$/);assert.equal(calls,0);
 await assert.rejects(port.execute(invocation,{provider:'github',token:'secret'}));assert.equal(calls,0);
 await assert.rejects(port.execute(invocation,credential),/^Error: External provider unavailable$/);
 const bad=inv('hf');bad.parameters={artifactDigest:'0'.repeat(64),message:'x'};calls=0;await assert.rejects(port.execute(bad,{provider:'hf',token:'hf'}));assert.equal(calls,0);
});
test('AWS absence confirmation requires a complete provider instance inventory',async()=>{
 const create=await factory(),port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async(_url,init)=>new Response(new URLSearchParams(String(init?.body)).get('Action')==='GetCallerIdentity'?identityXml:'<DescribeInstancesResponse><requestId>req-1</requestId></DescribeInstancesResponse>')});
 assert.equal(await port.confirmAbsent(invocation,{id:'i-1234abcd',cleanupRequired:true},credential),false);
});
test('artifact loader refuses secret/runtime paths and recognizable credential content before HTTP',async()=>{
 const create=await factory();for(const file of [{path:'auth.json',contentBase64:Buffer.from('{}').toString('base64')},{path:'src/runtime/config.json',contentBase64:'e30='},{path:'README.md',contentBase64:Buffer.from('Bearer syntheticcredentialvalue').toString('base64')},{path:'README.md',contentBase64:'aGVsbG8=\n'},{path:'../README.md',contentBase64:'e30='}]){
  const a={files:[file]},i=inv('hf');i.parameters={artifactDigest:digest(a),message:'x'};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);let calls=0;
  const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:{async load(){return a;}},now:()=>1000,fetch:async()=>{calls++;return Response.json({private:true,sha});}});
  await assert.rejects(port.execute(i,{provider:'hf',token:'synthetic-hf'}));assert.equal(calls,0,file.path);
 }
});
test('HF provider ownership title alone is insufficient when blob proof is wrong',async()=>{
 const create=await factory(),i=inv('hf'),port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async url=>String(url).includes('/commits/')?Response.json([{id:next,title:marker(i)}]):Response.json({private:true,sha:next,siblings:[{rfilename:'README.md',blobId:'0'.repeat(40)}]})});
 assert.equal(await port.inspect(i,{provider:'hf',token:'synthetic-hf'}),null);
});
test('AWS lost-create discovery verifies account and token and never invents zero billing',async()=>{
 const create=await factory();let terminations=0;const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async(_url,init)=>{const action=new URLSearchParams(String(init?.body)).get('Action');if(action==='GetCallerIdentity')return new Response(identityXml);if(action==='TerminateInstances')terminations++;return new Response('<DescribeInstancesResponse><requestId>req-1</requestId><reservationSet><item><ownerId>999999999999</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>wrong</clientToken><instanceState><name>running</name></instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>');}});
 assert.equal(await port.inspect(invocation,credential),null);await assert.rejects(port.cleanup(invocation,{id:'i-1234abcd',cleanupRequired:true},credential));assert.equal(terminations,0);
});
test('AWS TTL and operation parameter whitelist reject overrides before signing',async()=>{
 const create=await factory();let calls=0;const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async()=>{calls++;throw Error('should not call');}});
 for(const parameters of [{lifetimeMs:60001},{lifetimeMs:1000,imageId:'ami-override'},{lifetimeMs:-1}])await assert.rejects(port.execute({...invocation,parameters} as ExternalInvocation,credential));assert.equal(calls,0);
});
test('private repo is required and oversized/redirect/error responses expose no raw data',async()=>{
 const create=await factory();for(const response of [()=>Response.json({private:false,sha}),()=>new Response('private secret',{status:302,headers:{location:'https://attacker.invalid/'}}),()=>new Response('x'.repeat(1024*1024+1)),()=>new Response('provider-secret',{status:500})]){
  let mutations=0;const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async(url,init)=>{assert.equal(new URL(String(url)).hostname,'huggingface.co');assert.equal(init?.redirect,'manual');if(init?.method==='POST')mutations++;return response();}});
  await assert.rejects(port.execute(inv('hf'),{provider:'hf',token:'synthetic-hf'}),/^Error: External provider unavailable$/);assert.equal(mutations,0);
 }
});
test('AWS dispatch uses existing broker expiry rather than restarting the full lifetime',async()=>{
 const create=await factory();let calls=0;const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async()=>{calls++;throw Error('ambiguous');}});
 await assert.rejects(port.execute({...invocation,expiresAt:1500},credential));assert.equal(calls,1);
});
test('HTTP timeout is bounded and sanitizes errors even when fetch ignores abort',{timeout:7000},async()=>{
 const create=await factory(),port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async()=>new Promise<Response>(()=>{})});const started=Date.now();await assert.rejects(port.execute(invocation,credential),/^Error: External provider unavailable$/);assert.ok(Date.now()-started<6500);
});
test('GitHub expected-head mismatch prevents every write',async()=>{
 const create=await factory();let writes=0;const port=create({enabled:true,github:{enabled:true,repository:'owner/repo',branch:'work'},artifacts:artifactLoader,now:()=>1000,fetch:async(_url,init)=>{if(init?.method!=='GET')writes++;return Response.json({object:{sha:next}});}});
 await assert.rejects(port.execute(inv('github'),{provider:'github',token:'synthetic-gh'}));assert.equal(writes,0);
});
test('expiry reached during read-only HF preparation prevents the commit POST',async()=>{
 const create=await factory(),i=inv('hf');let clock=1000,writes=0;const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>clock,fetch:async(url,init)=>{if(init?.method==='POST'){writes++;return Response.json({commitOid:next});}if(String(url).includes('/commits/')){clock=i.expiresAt;return Response.json([]);}return Response.json({private:true,sha});}});
 await assert.rejects(port.execute(i,{provider:'hf',token:'synthetic-hf'}));assert.equal(writes,0);
});
test('AWS caller identity must confirm approved account before any EC2 mutation',async()=>{
 const create=await factory();const actions:string[]=[];const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async(url,init)=>{const action=new URLSearchParams(String(init?.body)).get('Action')!;actions.push(action);assert.equal(String(url),'https://sts.ap-northeast-2.amazonaws.com/');return new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>999999999999</Account><Arn>arn:aws:iam::999999999999:user/other</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');}});
 await assert.rejects(port.execute(invocation,credential));assert.deepEqual(actions,['GetCallerIdentity']);
});
test('HF lost commit response is recovered by provider ownership and file evidence without reposting',async()=>{
 const create=await factory(),i=inv('hf');let committed=false,posts=0;const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async(url,init)=>{if(init?.method==='POST'){posts++;committed=true;throw Error('token must not escape');}if(String(url).includes('/commits/'))return Response.json(committed?[{id:next,title:marker(i)}]:[]);return Response.json({private:true,sha:String(url).includes(next)?next:sha,siblings:[{rfilename:'README.md',blobId:blob}]});}});
 const c={provider:'hf' as const,token:'synthetic-hf'};await assert.rejects(port.execute(i,c),/^Error: External provider unavailable$/);const r=receiptOnly(await port.inspect(i,c));assert.equal(r?.effect,'retained');assert.equal(r?.billing.verifiedCostMicros,null);assert.equal((await port.execute(i,c)).evidenceId,r?.evidenceId);assert.equal(posts,1);
});
test('GitHub atomic CAS rejects branch movement after preflight without a REST overwrite',async()=>{
 const create=await factory();let current=sha,graphql=0,patches=0;
 const port=create({enabled:true,github:{enabled:true,repository:'owner/repo',branch:'work'},artifacts:artifactLoader,now:()=>1000,fetch:async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/git/ref/heads/work'))return Response.json({object:{sha:current}});
  if(path==='/graphql'){
   graphql++;current='0'.repeat(40);const body=JSON.parse(String(init?.body));
   assert.equal(body.variables.input.expectedHeadOid,sha);
   return Response.json({errors:[{type:'STALE_DATA',message:'expected head does not match'}],data:{createCommitOnBranch:null}});
  }
  if(init?.method==='PATCH'){patches++;current=next;return Response.json({object:{sha:next}});}
  throw Error('Unexpected REST write');
 }});
 await assert.rejects(port.execute(inv('github'),{provider:'github',token:'synthetic-gh'}),/^Error: External provider unavailable$/);
 assert.equal(graphql,1);assert.equal(patches,0);assert.equal(current,'0'.repeat(40));
});
test('AWS transport recovers a lost creation response only from complete provider ownership evidence',async()=>{
 const create=await factory();let launched=false;const owned=`<DescribeInstancesResponse><requestId>owned-1</requestId><reservationSet><item><ownerId>123456789012</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${hash('idem')}</clientToken><instanceState><name>running</name></instanceState><tagSet><item><key>hivemind:owner</key><value>owner</value></item><item><key>hivemind:request</key><value>${hash('idem')}</value></item><item><key>hivemind:parameters</key><value>${invocation.parametersHash}</value></item><item><key>hivemind:workload</key><value>w</value></item></tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`;
 const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async(_url,init)=>{const action=new URLSearchParams(String(init?.body)).get('Action');if(action==='GetCallerIdentity')return new Response(identityXml);if(action==='RunInstances'){launched=true;throw Error('lost');}assert.ok(launched);return new Response(owned);}});
 await assert.rejects(port.execute(invocation,credential));const r=receiptOnly(await port.inspect(invocation,credential));assert.equal(r?.resource?.id,'i-1234abcd');assert.equal(r?.billing.verifiedCostMicros,null);
});
test('GitHub recovery requires commit ancestry and artifact blob proof, never a marker alone',async()=>{
 const create=await factory(),i=inv('github');let valid=true;const port=create({enabled:true,github:{enabled:true,repository:'owner/repo',branch:'work'},artifacts:artifactLoader,now:()=>1000,fetch:async(url)=>{const path=new URL(String(url)).pathname;if(path.includes('/git/ref/heads/'))return Response.json({object:{sha:next}});if(path.endsWith('/commits'))return Response.json([{sha:next,commit:{message:marker(i)}}]);if(path.includes('/git/trees/'))return Response.json({sha:tree,truncated:false,tree:[{path:'README.md',mode:'100644',type:'blob',sha:valid?blob:sha}]});return Response.json({sha:path.endsWith(sha)?sha:next,message:marker(i),parents:[{sha}],tree:{sha:tree}});}});
 assert.equal(receiptOnly(await port.inspect(i,{provider:'github',token:'synthetic-gh'}))?.effect,'retained');valid=false;assert.equal(await port.inspect(i,{provider:'github',token:'synthetic-gh'}),null);
});
test('GitHub proof rejects unrelated file changes outside the immutable artifact',async()=>{
 const create=await factory(),i=inv('github'),base='4'.repeat(40);const port=create({enabled:true,github:{enabled:true,repository:'owner/repo',branch:'work'},artifacts:artifactLoader,now:()=>1000,fetch:async(url)=>{const path=new URL(String(url)).pathname;if(path.includes('/git/ref/heads/'))return Response.json({object:{sha:next}});if(path.endsWith('/commits'))return Response.json([{sha:next,commit:{message:marker(i)}}]);if(path.endsWith('/git/commits/'+sha))return Response.json({sha,tree:{sha:base}});if(path.includes('/git/trees/'))return Response.json({sha:path.endsWith(base)?base:tree,truncated:false,tree:path.endsWith(base)?[]:[{path:'README.md',mode:'100644',type:'blob',sha:blob},{path:'extra.txt',mode:'100644',type:'blob',sha}]});return Response.json({sha:path.endsWith(sha)?sha:next,message:marker(i),parents:[{sha}],tree:{sha:tree}});}});
 assert.equal(await port.inspect(i,{provider:'github',token:'synthetic-gh'}),null);
});
test('AWS start has no admission without a preexisting TTL guard and armed ownership timer',async()=>{
 const create=await factory();let mutations=0;const port=create({enabled:true,aws,artifacts,now:()=>1000,fetch:async(_url,init)=>{const a=new URLSearchParams(String(init?.body)).get('Action');if(a==='RunInstances')mutations++;return new Response(a==='GetCallerIdentity'?identityXml:'<RunInstancesResponse><requestId>r</requestId></RunInstancesResponse>');}});
 await assert.rejects(port.execute(invocation,credential));assert.equal(mutations,0);
});
test('provider refuses forged canonical hash before any HTTP',async()=>{
 const create=await factory();let calls=0;const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async()=>{calls++;throw Error('no');}});
 await assert.rejects(port.execute({...inv('hf'),parametersHash:'f'.repeat(64)},{provider:'hf',token:'synthetic-hf'}));assert.equal(calls,0);
});
test('R2 artifact loader uses only the external artifact digest namespace',async()=>{
 const module=await import('../packages/adapters/src/autonomous-external.js');const keys:string[]=[];
 assert.equal(typeof (module as any).createExternalR2ArtifactLoader,'function');
 const loader=(module as any).createExternalR2ArtifactLoader({async get(key:string){keys.push(key);const b=Buffer.from(JSON.stringify(artifact));return {size:b.length,async arrayBuffer(){return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}};}});
 assert.deepEqual(await loader.load(artifactDigest),artifact);assert.deepEqual(keys,['external-artifacts/'+artifactDigest]);await assert.rejects(loader.load('https://attacker.invalid/artifact'));
});
test('AWS guard rejects self-echo boolean, stale/foreign proof, or missing timer before create',async()=>{
 const create=await factory();
 for(const mode of ['boolean','foreign','stale','timer']){
  let calls=0;const guard={guardArn,port:{
   async attest(r:any){const p=await syntheticGuard.port.attest(r);return mode==='boolean'?true:mode==='foreign'?{...p,bindingHash:'0'.repeat(64)}:mode==='stale'?{...p,observedAt:-1}:p;},
   async arm(r:any){const p=await syntheticGuard.port.arm(r);return mode==='timer'?{...p,expiresAt:r.expiresAt+1}:p;}
  }};
  const port=create({enabled:true,aws,awsTtlGuard:guard,artifacts,now:()=>1000,fetch:async()=>{calls++;throw Error('unexpected');}} as any);
  await assert.rejects(port.execute(invocation,credential));assert.equal(calls,0,mode);
 }
});
test('AWS guard/account/region/credential reference and exposure ceiling bind before start',async()=>{
 const create=await factory();
 for(const patch of [{credentialRef:'other'},{maxUpperBoundMicros:9},{maxUpperBoundMicros:undefined},{accountId:'999999999999'},{region:'us-east-1'}]){
  let calls=0;const port=create({enabled:true,aws:{...aws,...patch,...(patch.region?{allowedRegions:[patch.region]}:{})},awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,fetch:async()=>{calls++;throw Error('unexpected');}});
  await assert.rejects(port.execute(invocation,credential));assert.equal(calls,0);
 }
});
test('cancellation during actual HF HTTP preparation aborts authority and prevents commit POST',async()=>{
 const create=await factory(),controller=new AbortController();let posts=0;const signals:AbortSignal[]=[];
 const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async(url,init)=>{
  signals.push(init!.signal!);if(init?.method==='POST'){posts++;return Response.json({commitOid:next});}
  if(String(url).includes('/commits/')){controller.abort();return Response.json([]);}return Response.json({private:true,sha});
 }});
 await assert.rejects(port.execute(inv('hf'),{provider:'hf',token:'synthetic-hf'},{signal:controller.signal,assertActive(){controller.signal.throwIfAborted();}}));
 assert.equal(posts,0);assert.ok(signals.every(s=>s.aborted));
});
test('cancellation while remote guard is pending prevents any HTTP even if guard ignores abort',async()=>{
 const create=await factory(),controller=new AbortController();let started:()=>void=()=>{};const ready=new Promise<void>(r=>{started=r;});let calls=0;
 const guard={guardArn,port:{...syntheticGuard.port,async attest(){started();return new Promise<any>(()=>{});}}};
 const port=create({enabled:true,aws,awsTtlGuard:guard,artifacts,now:()=>1000,fetch:async()=>{calls++;throw Error('unexpected');}});
 const pending=port.execute(invocation,credential,{signal:controller.signal,assertActive(){controller.signal.throwIfAborted();}});await ready;controller.abort();
 await assert.rejects(pending,/External provider unavailable/);assert.equal(calls,0);
});
test('R2 loader rejects mismatched SourceSnapshot-shaped data and oversized objects',async()=>{
 const module=await import('../packages/adapters/src/autonomous-external.js');
 for(const data of [{version:1,files:artifact.files},artifact]){
  const bytes=Buffer.from(JSON.stringify(data));const loader=module.createExternalR2ArtifactLoader({async get(){return {size:bytes.length,async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};}});
  await assert.rejects(loader.load('0'.repeat(64)));
 }
 let read=false;const loader=module.createExternalR2ArtifactLoader({async get(){return {size:3*1024*1024,async arrayBuffer(){read=true;return new ArrayBuffer(0);}};}});
 await assert.rejects(loader.load(artifactDigest));assert.equal(read,false);
});
test('actual installation/opaque credentials and server forbidden values never enter HF/GH artifacts',async()=>{
 const create=await factory();
 for(const provider of ['hf','github'] as const)for(const location of ['bytes','path','message','server-value']){
  const token='ghs_actual_installation_synthetic',opaque='opaquePrivateValueForTest',value=location==='server-value'?opaque:token;
  const a={files:[{path:location==='path'?value+'.bin':'model.bin',contentBase64:Buffer.from(location==='bytes'||location==='server-value'?value:'safe bytes').toString('base64')}]};
  const i=inv(provider);i.parameters=provider==='hf'?{artifactDigest:digest(a),message:location==='message'?token:'safe'}:{artifactDigest:digest(a),expectedHead:sha};
  if(provider==='github'&&location==='message')continue;
  i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);let calls=0;
  const port=create({enabled:true,[provider]:{enabled:true,repository:'owner/repo',...(provider==='hf'?{revision:'main'}:{branch:'work'})},forbiddenValues:[opaque],artifacts:{async load(){return a;}},now:()=>1000,fetch:async()=>{calls++;throw Error('should not send');}} as any);
  await assert.rejects(port.execute(i,{provider,token}),/^Error: External provider unavailable$/);assert.equal(calls,0,provider+':'+location);
 }
});
test('Spot start tags both instances and volumes and denies missing billing admission/headroom',async()=>{
 const create=await factory();let startBody:URLSearchParams|undefined;
 const fetcher:typeof fetch=async(_u,init)=>{const p=new URLSearchParams(String(init?.body));if(p.get('Action')==='GetCallerIdentity')return new Response(identityXml);if(p.get('Action')==='RunInstances')startBody=p;throw Error('synthetic lost result');};
 const noPolicy=create({enabled:true,aws:{...aws,billingPolicy:undefined},awsTtlGuard:syntheticGuard,artifacts,fetch:fetcher,now:()=>1000} as any);
 await assert.rejects(noPolicy.execute(invocation,credential));assert.equal(startBody,undefined);
 const noRoom=create({enabled:true,aws:{...aws,billingPolicy:'verified_cost_source'},awsTtlGuard:syntheticGuard,costReader:{quote(){return {resourceUpperBoundMicros:9,maximumQueryFeeMicros:2};},async read(){throw Error();}},artifacts,fetch:fetcher,now:()=>1000} as any);
 await assert.rejects(noRoom.execute(invocation,credential));assert.equal(startBody,undefined);
 const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,fetch:fetcher,now:()=>1000});await assert.rejects(port.execute(invocation,credential));const recorded=startBody as unknown as URLSearchParams;assert.ok(recorded);
 assert.equal(recorded.get('TagSpecification.2.ResourceType'),'volume');
 for(let n=1;n<=7;n++){assert.equal(recorded.get(`TagSpecification.1.Tag.${n}.Key`),recorded.get(`TagSpecification.2.Tag.${n}.Key`));assert.equal(recorded.get(`TagSpecification.1.Tag.${n}.Value`),recorded.get(`TagSpecification.2.Tag.${n}.Value`));}
});
test('cost reader is called only by reconciliation after owned instance AND volume absence',async()=>{
 const create=await factory();let reads=0,volumeLive=true;
 const ownedInvocation={...invocation,ownedResource:{id:'i-1234abcd',cleanupRequired:true as const,actionId:invocation.actionId,ownershipToken:invocation.ownershipToken,idempotencyKey:invocation.idempotencyKey}};
 const port=create({enabled:true,aws,artifacts,now:()=>5000,costReader:{quote(){return {resourceUpperBoundMicros:8,maximumQueryFeeMicros:2};},async read(i:any,p:any){reads++;assert.equal(i.actionId,invocation.actionId);assert.equal(p.resourceConfirmedAbsent,true);return {verifiedCostMicros:7,final:false,evidenceId:'ce-actual-query-proof'};}},fetch:async(_u:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const p=new URLSearchParams(String(init?.body));if(p.get('Action')==='GetCallerIdentity')return new Response(identityXml);
  if(p.get('Action')==='DescribeInstances')return new Response('<DescribeInstancesResponse><requestId>r</requestId><reservationSet></reservationSet></DescribeInstancesResponse>');
  assert.equal(p.get('Action'),'DescribeVolumes');const tags=[['hivemind:owner','owner'],['hivemind:request',hash('idem')],['hivemind:parameters',invocation.parametersHash],['hivemind:workload','w']].map(([key,value])=>`<item><key>${key}</key><value>${value}</value></item>`).join('');
  return new Response(`<DescribeVolumesResponse><requestId>v</requestId><volumeSet>${volumeLive?`<item><volumeId>vol-1234abcd</volumeId><tagSet>${tags}</tagSet></item>`:''}</volumeSet></DescribeVolumesResponse>`);
 }} as any);
 assert.equal(await port.inspect(invocation,credential),null);assert.equal(reads,0);
 await port.inspect(ownedInvocation,credential);assert.equal(reads,0);volumeLive=false;
 const receipt=receiptOnly(await port.inspect(ownedInvocation,credential));assert.equal(reads,1);assert.equal(receipt?.billing.verifiedCostMicros,7);assert.equal(receipt?.billing.final,false);assert.equal(receipt?.resource?.id,'i-1234abcd');
});
test('opaque forbidden message is checked before JSON escaping and before any HTTP',async()=>{
 const create=await factory(),secret='opaque"PrivateValueTest',i=inv('hf');i.parameters={artifactDigest,message:secret};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);let calls=0;
 const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},forbiddenValues:[secret],artifacts:artifactLoader,now:()=>1000,fetch:async()=>{calls++;throw Error('must not send');}});
 await assert.rejects(port.execute(i,{provider:'hf',token:'synthetic-hf'}),/^Error: External provider unavailable$/);assert.equal(calls,0);
});
function launchPolicy(a:typeof aws){return {schemaVersion:1,accountId:a.accountId,region:a.region,workloadId:a.workloadId,imageId:a.imageId,instanceType:a.instanceType,subnetId:a.subnetId,instanceProfileArn:a.instanceProfileArn,maxLifetimeMs:a.maxLifetimeMs,maxUpperBoundMicros:a.maxUpperBoundMicros};}
test('AWS launch configuration hash is canonical across property order and non-launch configuration',async()=>{
 const module=await import('../packages/adapters/src/autonomous-external.js'),hashConfig=(module as any).externalAwsConfigurationHash;
 assert.equal(typeof hashConfig,'function');const reordered=Object.fromEntries(Object.entries(aws).reverse());
 assert.equal(hashConfig(aws),awsGuardDigest(launchPolicy(aws)));assert.equal(hashConfig(aws),hashConfig(reordered));
 assert.equal(hashConfig(aws),hashConfig({...aws,enabled:false,billingPolicy:'verified_cost_source',credentialRef:'rotated-reference',sessionToken:'ephemeral-synthetic'}));
 for(const patch of [{imageId:'ami-5678'},{subnetId:'subnet-5678'},{instanceType:'t3.small'},{instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/other'},{accountId:'999999999999'},{region:'us-east-1'},{workloadId:'other'},{maxLifetimeMs:60001},{maxUpperBoundMicros:11}])assert.notEqual(hashConfig({...aws,...patch}),hashConfig(aws));
});
test('actual provider interoperates with actual guard attestation/arm through fake AWS evidence',async()=>{
 const clock=Date.parse('2026-11-20T00:00:00Z'),account=aws.accountId,region=aws.region,prefix='hivemind-ttl';
 const functionArn=`arn:aws:lambda:${region}:${account}:function:${prefix}`;
 const roles=(['guard','scheduler','workload'] as const).map(kind=>({kind,roleArn:`arn:aws:iam::${account}:role/${prefix}-${kind}`,boundaryArn:`arn:aws:iam::${account}:policy/${prefix}-${kind}`,inlinePolicyName:'guard-policy'}));
 const config:AwsGuardOptions={enabled:true,accountId:account,region:'ap-northeast-2',guardArn,functionArn,scheduleGroupArn:`arn:aws:scheduler:${region}:${account}:schedule-group/${prefix}`,schedulerRoleArn:roles[1]!.roleArn,expectedCodeSha256:Buffer.alloc(32,1).toString('base64'),rolePolicies:roles,manifest:{schemaVersion:1,ownershipMode:'broker_uuid_registry_v1',registryTableArn:`arn:aws:dynamodb:${region}:${account}:table/${prefix}-bindings`,guardArn,validUntil:clock+86400000,profiles:[{workloadId:aws.workloadId,configurationHash:awsGuardDigest(launchPolicy(aws)),parameterPolicy:'opaque_broker_sha256',instanceProfileArn:aws.instanceProfileArn,maxLifetimeMs:aws.maxLifetimeMs,launchHeadroomMs:30000,quote:{source:'synthetic test quote',maxExposureMicros:10,validUntil:clock+86400000}}]},credentials:async()=>({accessKeyId:'GUARD_FIXTURE',secretAccessKey:'guard-synthetic-secret'}),now:()=>clock};
 let schedule:any;const registry=new Map<string,unknown>(),observed:string[]=[];
 const xml=(tag:string,value:string)=>`<${tag}>${value}</${tag}>`,encoded=(v:unknown)=>encodeURIComponent(JSON.stringify(v));
 config.fetchImpl=async(url,init)=>{
  const u=new URL(String(url)),headers=new Headers(init?.headers),form=new URLSearchParams(String(init?.body??''));assert.match(headers.get('authorization')!,/^AWS4-HMAC-SHA256 /);assert.equal(init?.redirect,'manual');
  const op=headers.get('x-amz-target')?.split('.').at(-1)??(u.hostname.startsWith('lambda.')?(u.pathname.endsWith('/policy')?'GetPolicy':u.pathname.endsWith('/concurrency')?'GetFunctionConcurrency':'GetFunctionConfiguration'):u.hostname.startsWith('scheduler.')?(init?.method==='POST'?'CreateSchedule':'GetSchedule'):form.get('Action')!);
  const body=headers.get('content-type')?.includes('json')?JSON.parse(String(init?.body??'{}')):Object.fromEntries(form);observed.push(op);let v:any;
  if(op==='DescribeRule')v={Arn:guardArn,Name:prefix,State:'ENABLED',ScheduleExpression:'rate(1 minute)',EventBusName:'default'};
  else if(op==='ListTargetsByRule')v={Targets:[{Id:'ttl-guard',Arn:functionArn,Input:awsGuardCanonical({schemaVersion:1,kind:'periodic',guardArn,configurationDigest:awsGuardDigest(config.manifest)})}]};
  else if(op==='GetFunctionConfiguration')v={FunctionArn:functionArn,Role:roles[0]!.roleArn,Runtime:'python3.13',Handler:'guard.handler',Timeout:55,MemorySize:256,Architectures:['x86_64'],VpcConfig:{SubnetIds:[],SecurityGroupIds:[],VpcId:'',Ipv6AllowedForDualStack:false},State:'Active',LastUpdateStatus:'Successful',CodeSha256:config.expectedCodeSha256,LastModified:new Date(clock-10000).toISOString(),Environment:{Variables:{HIVEMIND_GUARD_SCHEMA:'1',HIVEMIND_GUARD_DIGEST:awsGuardDigest(config.manifest),HIVEMIND_GUARD_MANIFEST:awsGuardCanonical(config.manifest),HIVEMIND_GUARD_SCHEDULE_GROUP_ARN:config.scheduleGroupArn}}};
  else if(op==='GetPolicy'&&u.hostname.startsWith('lambda.'))v={Policy:JSON.stringify({Version:'2012-10-17',Statement:[{Sid:'fixture',Effect:'Allow',Principal:{Service:'events.amazonaws.com'},Action:'lambda:InvokeFunction',Resource:functionArn,Condition:{ArnLike:{'AWS:SourceArn':guardArn},StringEquals:{'AWS:SourceAccount':account}}}]})};
  else if(op==='GetFunctionConcurrency')v={};
  else if(op==='DescribeTable')v={Table:{TableArn:config.manifest.registryTableArn,TableStatus:'ACTIVE',KeySchema:[{AttributeName:'owner',KeyType:'HASH'}],AttributeDefinitions:[{AttributeName:'owner',AttributeType:'S'}]}};
  else if(op==='DescribeTimeToLive')v={TimeToLiveDescription:{TimeToLiveStatus:'DISABLED'}};
  else if(op==='PutItem'){registry.set(body.Item.owner.S,structuredClone(body.Item));v={};}
  else if(op==='GetItem')v={Item:registry.get(body.Key.owner.S)};
  else if(op==='CreateSchedule'){schedule={...body,Name:u.pathname.split('/').at(-1)};v={ScheduleArn:`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/${schedule.Name}`};}
  else if(op==='GetSchedule')v={...schedule,Arn:`arn:aws:scheduler:${region}:${account}:schedule/${prefix}/${schedule.Name}`};
  else{
   const role=roles.find(r=>r.roleArn.split('/').at(-1)===body.RoleName)||roles.find(r=>r.boundaryArn===body.PolicyArn)||roles[2]!,policy=awsGuardPolicies(config)[role.kind];
   if(op==='GetRole')v=xml('Role',xml('Arn',role.roleArn)+xml('AssumeRolePolicyDocument',encoded(policy.trust))+xml('PermissionsBoundary',xml('PermissionsBoundaryArn',role.boundaryArn)));
   else if(op==='ListRolePolicies')v=xml('PolicyNames',xml('member',role.inlinePolicyName))+xml('IsTruncated','false');
   else if(op==='ListAttachedRolePolicies')v=xml('AttachedPolicies','')+xml('IsTruncated','false');
   else if(op==='GetRolePolicy')v=xml('PolicyDocument',encoded(policy.policy));
   else if(op==='GetPolicy')v=xml('Policy',xml('Arn',role.boundaryArn)+xml('DefaultVersionId','v1'));
   else if(op==='GetPolicyVersion')v=xml('PolicyVersion',xml('Document',encoded(policy.policy))+xml('IsDefaultVersion','true'));
   else if(op==='GetInstanceProfile')v=xml('InstanceProfile',xml('Arn',aws.instanceProfileArn)+xml('Roles',xml('member',xml('Arn',roles[2]!.roleArn))));
   else throw Error('Unexpected guard operation');
   return new Response(`<${op}Response><${op}Result>${v}</${op}Result><ResponseMetadata><RequestId>remote-guard-fixture</RequestId></ResponseMetadata></${op}Response>`,{headers:{'x-amzn-requestid':'remote-guard-fixture'}});
  }
  return Response.json(v,{headers:{'x-amzn-requestid':'remote-guard-fixture'}});
 };
 const guard=createAwsTtlGuardPort(config),i={...invocation,ownershipToken:'12345678-1234-4234-8234-123456789abc',parameters:{lifetimeMs:60000},expiresAt:clock+60000};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);
 const create=await factory(),port=create({enabled:true,aws:Object.fromEntries(Object.entries(aws).reverse()) as typeof aws,awsTtlGuard:{guardArn,port:guard},artifacts,now:()=>clock,fetch:async(_u,init)=>{
  const p=new URLSearchParams(String(init?.body));if(p.get('Action')==='GetCallerIdentity')return new Response(identityXml);
  if(p.get('Action')==='RunInstances'){assert.ok(observed.includes('GetSchedule'));observed.push('RunInstances');return new Response('<RunInstancesResponse><requestId>provider-create</requestId></RunInstancesResponse>');}
  const tags=[['hivemind:owner',i.ownershipToken],['hivemind:request',hash(i.idempotencyKey)],['hivemind:parameters',i.parametersHash],['hivemind:workload',aws.workloadId]].map(([k,v])=>xml('item',xml('key',k!)+xml('value',v!))).join('');
  return new Response(`<DescribeInstancesResponse><requestId>provider-read</requestId><reservationSet><item><ownerId>${account}</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${hash(i.idempotencyKey)}</clientToken><instanceState><name>running</name></instanceState><tagSet>${tags}</tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`);
 }});
 const result=await port.execute(i,credential);assert.equal(result.resource?.id,'i-1234abcd');assert.ok(observed.indexOf('GetSchedule')<observed.indexOf('RunInstances'));assert.ok(observed.includes('GetRolePolicy'));assert.equal(registry.size,1);
});
async function timingFixture(t:TestContext){
 const create=await factory();t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 let attestRequest:any,armRequest:any,attestSignal:AbortSignal|undefined,armSignal:AbortSignal|undefined;
 let releaseAttest:(value:any)=>void=()=>{},releaseArm:(value:any)=>void=()=>{};
 const attestWait=new Promise<any>(r=>{releaseAttest=r;}),armWait=new Promise<any>(r=>{releaseArm=r;});
 const controller=new AbortController();let creates=0;
 const i={...invocation,parameters:{lifetimeMs:60000},expiresAt:61000};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);
 const guard={guardArn,port:{async attest(r:any,s?:AbortSignal){attestRequest=r;attestSignal=s;return attestWait;},async arm(r:any,_g:any,s?:AbortSignal){armRequest=r;armSignal=s;return armWait;}}};
 const port=create({enabled:true,aws,awsTtlGuard:guard,artifacts,now:Date.now,fetch:async(_u,init)=>{
  const p=new URLSearchParams(String(init?.body));if(p.get('Action')==='GetCallerIdentity')return new Response(identityXml);
  if(p.get('Action')==='RunInstances'){creates++;return new Response('<RunInstancesResponse><requestId>r</requestId></RunInstancesResponse>');}
  const tags=[['hivemind:owner',i.ownershipToken],['hivemind:request',hash(i.idempotencyKey)],['hivemind:parameters',i.parametersHash],['hivemind:workload','w']].map(([k,v])=>`<item><key>${k}</key><value>${v}</value></item>`).join('');
  return new Response(`<DescribeInstancesResponse><requestId>r</requestId><reservationSet><item><ownerId>${aws.accountId}</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${hash(i.idempotencyKey)}</clientToken><instanceState><name>running</name></instanceState><tagSet>${tags}</tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`);
 }});
 const start=(expiresAt=i.expiresAt)=>port.execute({...i,expiresAt},credential,{signal:controller.signal,assertActive(){controller.signal.throwIfAborted();}});
 return {start,controller,get creates(){return creates;},get attestSignal(){return attestSignal;},get armSignal(){return armSignal;},async attest(){releaseAttest(await syntheticGuard.port.attest(attestRequest));},async arm(){releaseArm(await syntheticGuard.port.arm(armRequest));}};
}
async function flushTiming(){for(let n=0;n<32;n++)await Promise.resolve();}
test('attest and arm may each exceed five seconds without premature provider timeout',async t=>{
 const f=await timingFixture(t);let settled=false;const pending=f.start().finally(()=>{settled=true;});void pending.catch(()=>{});
 await flushTiming();t.mock.timers.tick(6000);await flushTiming();assert.equal(settled,false);assert.equal(f.attestSignal?.aborted,false);
 await f.attest();await flushTiming();t.mock.timers.tick(6000);await flushTiming();assert.equal(settled,false);assert.equal(f.armSignal?.aborted,false);
 await f.arm();assert.equal((await pending).resource?.id,'i-1234abcd');assert.equal(f.creates,1);
});
test('attest phase stops at 25 seconds and action expiry clips that bound',async t=>{
 const f=await timingFixture(t),pending=f.start();void pending.catch(()=>{});await flushTiming();t.mock.timers.tick(24999);await flushTiming();assert.equal(f.attestSignal?.aborted,false);
 t.mock.timers.tick(1);await assert.rejects(pending,/External provider unavailable/);assert.equal(f.attestSignal?.aborted,true);assert.equal(f.creates,0);
});
test('short action expiry and cancelled arm never create a VM despite ignored abort',async t=>{
 const f=await timingFixture(t),pending=f.start(9000);void pending.catch(()=>{});await flushTiming();t.mock.timers.tick(8000);await assert.rejects(pending);assert.equal(f.creates,0);
});
test('cancellation during delayed arm aborts the phase and prevents provider create',async t=>{
 const f=await timingFixture(t),pending=f.start();void pending.catch(()=>{});await flushTiming();await f.attest();await flushTiming();assert.ok(f.armSignal);f.controller.abort();await assert.rejects(pending);assert.equal(f.armSignal?.aborted,true);assert.equal(f.creates,0);
});
async function costTimingFixture(t:TestContext){
 const create=await factory();t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});let release:(value:any)=>void=()=>{},started=false;
 const cost=new Promise<any>(r=>{release=r;});
 const i={...invocation,ownedResource:{id:'i-1234abcd',cleanupRequired:true as const,actionId:invocation.actionId,ownershipToken:invocation.ownershipToken,idempotencyKey:invocation.idempotencyKey}};
 const port=create({enabled:true,aws,artifacts,now:Date.now,costReader:{quote(){return {resourceUpperBoundMicros:8,maximumQueryFeeMicros:2};},async read(){started=true;return cost;}},fetch:async(_u,init)=>{
  const action=new URLSearchParams(String(init?.body)).get('Action');if(action==='GetCallerIdentity')return new Response(identityXml);
  return new Response(action==='DescribeInstances'?'<DescribeInstancesResponse><requestId>r</requestId><reservationSet></reservationSet></DescribeInstancesResponse>':'<DescribeVolumesResponse><requestId>v</requestId><volumeSet></volumeSet></DescribeVolumesResponse>');
 }});
 return {start:()=>port.inspect(i,credential),get started(){return started;},release(){release({verifiedCostMicros:7,final:false,evidenceId:'bounded-cost-proof'});}};
}
test('readonly CE reconciliation survives five seconds without extending expired execution authority',async t=>{
 const f=await costTimingFixture(t);let settled=false;const pending=f.start().finally(()=>{settled=true;});await flushTiming();assert.equal(f.started,true);
 t.mock.timers.tick(6000);await flushTiming();assert.equal(settled,false);f.release();assert.equal(receiptOnly(await pending)?.billing.verifiedCostMicros,7);
});
test('outer CE proof is bounded at fifteen seconds even if cost source ignores cancellation',async t=>{
 const f=await costTimingFixture(t);let settled=false;const pending=f.start().finally(()=>{settled=true;});await flushTiming();assert.equal(f.started,true);
 t.mock.timers.tick(14999);await flushTiming();assert.equal(settled,false);t.mock.timers.tick(1);await flushTiming();assert.equal(settled,true);assert.equal(await pending,null);
});
async function orphanFixture(mode='available'){
 const module=await import('../packages/adapters/src/autonomous-external.js');
 const i={...invocation,ownedResource:{id:'i-1234abcd',cleanupRequired:true as const,actionId:invocation.actionId,ownershipToken:invocation.ownershipToken,idempotencyKey:invocation.idempotencyKey}};
 const request={accountId:aws.accountId,region:aws.region,workloadId:aws.workloadId,actionId:i.actionId,ownershipToken:i.ownershipToken,clientToken:hash(i.idempotencyKey),parametersHash:i.parametersHash,expiresAt:i.expiresAt,maxExposureMicros:i.profile.upperBoundMicros,configurationHash:module.externalAwsConfigurationHash(aws)};
 const timerArn=`arn:aws:scheduler:${aws.region}:${aws.accountId}:schedule/hivemind/hm-${digest(request).slice(0,48)}`;
 let removed=false,deleting=false,deletes=0,terminations=0;const actions:string[]=[];
 const tags=new Map([['hivemind:owner',i.ownershipToken],['hivemind:request',hash(i.idempotencyKey)],['hivemind:workload',aws.workloadId],['hivemind:parameters',i.parametersHash],['hivemind:guard',guardArn],['hivemind:timer',timerArn],['hivemind:expires',String(i.expiresAt)]]);
 if(mode.startsWith('wrong-'))tags.set('hivemind:'+mode.slice(6),'foreign');
 const port=module.createExternalProviderTransport({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>5000,fetch:async(_url,init)=>{
  const p=new URLSearchParams(String(init?.body)),action=p.get('Action')!;actions.push(action);
  if(action==='GetCallerIdentity')return new Response(identityXml);
  if(action==='DescribeInstances')return new Response('<DescribeInstancesResponse><requestId>instance-proof</requestId><reservationSet></reservationSet></DescribeInstancesResponse>');
  if(action==='TerminateInstances'){terminations++;throw Error('already absent');}
  if(action==='DeleteVolume'){assert.equal(p.get('VolumeId'),'vol-1234abcd');assert.ok(actions.includes('DescribeInstances'));assert.ok(actions.includes('DescribeVolumes'));deletes++;if(mode==='delayed')deleting=true;else removed=true;return new Response('<DeleteVolumeResponse><requestId>delete-ack</requestId><return>true</return></DeleteVolumeResponse>');}
  assert.equal(action,'DescribeVolumes');assert.equal(p.get('Filter.1.Value.1'),i.ownershipToken);assert.equal(p.get('Filter.2.Value.1'),hash(i.idempotencyKey));assert.equal(p.get('Filter.3.Value.1'),aws.workloadId);
  const tagXml=[...tags].map(([key,value])=>`<item><key>${key}</key><value>${value}</value></item>`).join('');
  const attachment=mode==='attached'?'<item><instanceId>i-foreign</instanceId><state>attached</state></item>':'';
  const state=mode==='in-use'?'in-use':mode==='deleted'?'deleted':deleting?'deleting':'available';
  return new Response(`<DescribeVolumesResponse><requestId>volume-proof</requestId><volumeSet>${removed?'':`<item><volumeId>vol-1234abcd</volumeId><status>${state}</status><attachmentSet>${attachment}</attachmentSet><tagSet>${tagXml}</tagSet></item>`}</volumeSet></DescribeVolumesResponse>`);
 }});
 return {port,i,resource:i.ownedResource,get deletes(){return deletes;},get terminations(){return terminations;},actions,remove(){removed=true;}};
}
test('cleanup deletes one detached surviving owned volume after instance absence and is idempotent',async()=>{
 const f=await orphanFixture();assert.equal(await f.port.confirmAbsent(f.i,f.resource,credential),false);
 await f.port.cleanup(f.i,f.resource,credential);assert.equal(f.deletes,1);assert.equal(f.terminations,0);
 assert.equal(await f.port.confirmAbsent(f.i,f.resource,credential),true);await f.port.cleanup(f.i,f.resource,credential);assert.equal(f.deletes,1);
 const receipt=receiptOnly(await f.port.inspect(f.i,credential));assert.equal(receipt?.billing.verifiedCostMicros,null);assert.equal(receipt?.billing.final,false);
});
test('wrong original guard/timer/parameters or attached/in-use volumes never authorize deletion',async()=>{
 for(const mode of ['wrong-guard','wrong-timer','wrong-parameters','wrong-owner','wrong-request','wrong-workload','wrong-expires','attached','in-use']){
  const f=await orphanFixture(mode);await f.port.cleanup(f.i,f.resource,credential).catch(()=>{});assert.equal(f.deletes,0,mode);assert.equal(await f.port.confirmAbsent(f.i,f.resource,credential),false,mode);
 }
});
test('volume deletion ACK is not absence; deleting stays pending until actual read-back is absent',async()=>{
 const f=await orphanFixture('delayed');await f.port.cleanup(f.i,f.resource,credential);assert.equal(f.deletes,1);
 assert.equal(await f.port.confirmAbsent(f.i,f.resource,credential),false);await f.port.cleanup(f.i,f.resource,credential);assert.equal(f.deletes,1);
 f.remove();assert.equal(await f.port.confirmAbsent(f.i,f.resource,credential),true);
});
test('known resource reference cannot authorize a different instance or a read-only inspection cleanup',async()=>{
 const f=await orphanFixture();await assert.rejects(f.port.cleanup(f.i,{id:'i-0000abcd',cleanupRequired:true},credential));assert.equal(f.actions.length,0);
 const read={...f.i,operation:'aws.spot.inspect' as const,parameters:{startActionId:f.i.actionId},parametersHash:''};read.profile={...read.profile,operations:['aws.spot.inspect']} as ExternalInvocation['profile'];read.parametersHash=externalParametersHash(read.profile,read.operation,read.parameters);
 await assert.rejects(f.port.cleanup(read,f.resource,credential));assert.equal(f.deletes,0);
});

test('HF public large provider forwards validated consent and protected values; private omission stays compatible',async()=>{
 const {externalLargeManifestDigest,largeOwnerKey,largeStorageRef}=await import('../packages/core/src/autonomous-external-large.ts');
 const create=await factory();
 for(const visibility of ['public','private'] as const)for(const secret of [false,true]){
  const content=Buffer.from(secret?'protected-fixture-value':'safe model bytes'),oid=hash(content.toString()),owner=largeOwnerKey('t',1,'p');
  const manifest={version:1 as const,taskId:'t',revision:1,profileId:'p',files:[{path:'model.bin',size:content.length,sha256:oid,storageRef:largeStorageRef(owner,oid)}]};
  const i=inv('hf');i.profile={...i.profile,provider:'hf',target:{repository:'owner/repo',revision:'main',...(visibility==='public'?{visibility,allowPublicLarge:true as const}:{})},operations:['hf.model.lfs_commit']};i.operation='hf.model.lfs_commit';i.parameters={manifestDigest:externalLargeManifestDigest(manifest),message:'model'};i.parametersHash=externalParametersHash(i.profile,i.operation,i.parameters);
  let committed=false,calls=0;
  const hf={enabled:true,repository:'owner/repo',revision:'main',...(visibility==='public'?{visibility}:{}),lfs:{limits:{maxFileBytes:1024,maxTotalBytes:1024,maxFiles:32},uploadHosts:['cdn.example.test'],async loadManifest(){return manifest;},async open(){return new Blob([content]).stream();}}};
  const port=create({enabled:true,hf,artifacts,now:()=>1000,forbiddenValues:['protected-fixture-value'],fetch:async(url,init)=>{
   calls++;const u=String(url);assert.equal(init?.redirect,'manual');
   if(u.includes('/commits/'))return Response.json(committed?[{id:next,title:marker(i)}]:[]);
   if(u.endsWith('/preupload/main'))return Response.json({files:[{path:'model.bin',uploadMode:'lfs',shouldIgnore:false}]});
   if(u.endsWith('/objects/batch'))return Response.json({objects:[{oid,size:content.length}]});
   if(u.endsWith('/commit/main')){
    assert.ok(init?.body instanceof ReadableStream);const reader=init.body.getReader();
    try{for(;;){const {done,value}=await reader.read();if(done)break;assert.ok(value instanceof Uint8Array);assert.ok(value.byteLength);}}finally{reader.releaseLock();}
    committed=true;return Response.json({commitOid:next});
   }
   return Response.json({private:visibility==='private',sha:committed?next:sha,siblings:committed?[{rfilename:'model.bin',lfs:{sha256:oid,size:content.length}}]:[]});
  }});
  if(secret){await assert.rejects(port.execute(i,{provider:'hf',token:'synthetic-hf'}));assert.equal(calls,0);}
  else{assert.equal((await port.execute(i,{provider:'hf',token:'synthetic-hf'})).effect,'retained');assert.equal(committed,true);}
 }
});

test('HF inline requests run on Worker manual redirect mode and reject 302 without following',async()=>{
 const create=await factory();
 for(const redirect of [false,true]){
  const i=inv('hf');let posted=false;const calls:string[]=[];
  const port=create({enabled:true,hf:{enabled:true,repository:'owner/repo',revision:'main'},artifacts:artifactLoader,now:()=>1000,fetch:async(url,init)=>{
   // Workers reject this mode before making any network request.
   if(init?.redirect==='error')throw new TypeError('Unsupported redirect mode');
   assert.equal(init?.redirect,'manual');const u=String(url);calls.push(u);assert.equal(new URL(u).hostname,'huggingface.co');
   if(redirect)return new Response(null,{status:302,headers:{location:'https://attacker.invalid/redirect'}});
   if(init?.method==='POST'){posted=true;return Response.json({commitOid:next});}
   if(u.includes('/commits/'))return Response.json(posted?[{id:next,title:marker(i)}]:[]);
   return Response.json({private:true,sha:posted?next:sha,siblings:[{rfilename:'README.md',blobId:blob}]});
  }});
  if(redirect){await assert.rejects(port.execute(i,{provider:'hf',token:'synthetic-hf'}),/External provider unavailable/);assert.equal(calls.length,1);assert.equal(posted,false);}
  else{assert.equal((await port.execute(i,{provider:'hf',token:'synthetic-hf'})).effect,'retained');assert.equal(posted,true);assert.ok(calls.length>=4);}
 }
});
test('delegated launch forces safe IMDS locator tags on instance and volume without replacing ownership tags',async()=>{
 const create=await factory();let launched:URLSearchParams|undefined;
 const metadata={taskId:invocation.taskId,revision:invocation.revision,profileId:invocation.profile.id,descriptorHash:'d'.repeat(64),inputManifestDigest:'a'.repeat(64)};
 const port=create({enabled:true,aws,awsTtlGuard:syntheticGuard,artifacts,now:()=>1000,delegatedLaunch:metadata,fetch:async(_u:RequestInfo|URL,init?:RequestInit)=>{const p=new URLSearchParams(String(init?.body));if(p.get('Action')==='GetCallerIdentity')return new Response(identityXml);if(p.get('Action')==='RunInstances')launched=p;throw Error('stop after captured launch');}} as any);
 await assert.rejects(port.execute(invocation,credential));assert.ok(launched);assert.equal(launched.get('MetadataOptions.InstanceMetadataTags'),'enabled');assert.equal(launched.get('TagSpecification.1.Tag.1.Key'),'hivemind:owner');
 const expected=[['hivemind:task',invocation.taskId],['hivemind:revision',String(invocation.revision)],['hivemind:profile',invocation.profile.id],['hivemind:descriptor','d'.repeat(64)],['hivemind:input','a'.repeat(64)]];
 for(const [index,[key,value]] of expected.entries()){assert.equal(launched.get(`TagSpecification.1.Tag.${index+8}.Key`),key);assert.equal(launched.get(`TagSpecification.1.Tag.${index+8}.Value`),value);assert.equal(launched.get(`TagSpecification.2.Tag.${index+8}.Value`),value);}
});
