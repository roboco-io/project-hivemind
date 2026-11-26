import assert from 'node:assert/strict';import test from 'node:test';
import {publishDelegatedArtifacts,type DelegatedPublisherPorts} from '../scripts/delegated/publisher.js';
import {buildDelegatedInstancePolicy} from '../packages/adapters/src/delegated-instance-policy.js';
import {workloadFingerprint} from '../packages/core/src/delegated.js';import type {WorkloadDescriptor,DelegatedReceipt} from '../packages/contracts/src/delegated.js';
const descriptor:WorkloadDescriptor={version:1,workloadId:'train',amiId:'ami-0123456789abcdef0',bootstrapSha256:'a'.repeat(64),inputManifestDigests:['b'.repeat(64)],iam:{instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/train',policyRevision:'v1',policySha256:'c'.repeat(64)},accountId:'123456789012',region:'us-east-2',availabilityZoneId:'use2-az1',s3:{bucket:'train-bucket',prefix:'tasks/t1/',maxObjects:4,maxObjectBytes:1000000000,maxTotalBytes:2000000000,retentionMs:60000,storageReserveMicros:10,requestReserveMicros:20,transferReserveMicros:30},hf:{repo:'org/model',visibility:'private',tokenRef:'hf-scoped',delivery:{mode:'instance-private-envelope',audience:'central',path:'/run/hivemind/hf-token',fileMode:'0600',ttlMs:60000,trainingEnvironment:false}},qualityGateIds:['eval'],releasePolicy:{id:'release',revision:'v1',allowPublicTransition:true}};
descriptor.awsDelivery={mode:'instance_role_scoped',purpose:'delegated-upload',roleArn:'arn:aws:iam::123456789012:role/TrainingRole',durationSeconds:120,policySha256:buildDelegatedInstancePolicy({accountId:descriptor.accountId,region:descriptor.region,bucket:descriptor.s3.bucket,prefix:descriptor.s3.prefix,policyRevision:descriptor.iam.policyRevision}).scopePolicyHash};
const binding={taskId:'t1',revision:1,workloadId:'train',descriptorHash:workloadFingerprint(descriptor),instanceId:'i-0123456789abcdef0',accountId:descriptor.accountId,region:descriptor.region};
const artifact={path:'/outputs/model.safetensors',name:'model.safetensors',size:500000000,sha256:'d'.repeat(64),receiptId:'s3-1'};
function fixture(){const calls:string[]=[];const receipts:DelegatedReceipt[]=[];let active=true;const ports:DelegatedPublisherPorts={now:()=>1000,assertCurrent:async()=>{if(!active)throw new Error('stopped');},inspectArtifact:async()=>({size:artifact.size,sha256:artifact.sha256,regularFile:true,symlink:false}),withParentCredentials:async consume=>{calls.push('parent');return consume({accessKeyId:'parent',secretAccessKey:'parentsecret',sessionToken:'parentsession',expiresAt:100000,arn:`arn:aws:sts::123456789012:assumed-role/TrainingRole/${binding.instanceId}`,sessionId:'AROAID:'+binding.instanceId});},scopeDown:{withCredentials:async(_parent,r,consume)=>{calls.push('scope');assert.equal(r.durationSeconds,120);assert.ok(r.policy.includes('arn:aws:s3:::train-bucket/tasks/t1/*'));return consume({accessKeyId:'scoped',secretAccessKey:'scopedsecret',sessionToken:'scopedsession'},{expiresAt:100000,assertValid:()=>{}});}},withHfTokenFile:async consume=>{calls.push('tokenfile');return consume('/run/hivemind/hf-token');},sdk:{s3Upload:async(input,creds)=>{calls.push('s3');assert.equal(creds.accessKeyId,'scoped');assert.equal(input.path,artifact.path);assert.equal(input.key,'tasks/t1/model.safetensors');return {versionId:'exact-version'};},hfCommit:async input=>{calls.push('hf');assert.equal(input.repo,'org/model');assert.equal(input.visibility,'private');return {commit:'e'.repeat(40),files:[{path:artifact.name,size:artifact.size,oid:artifact.sha256,sha256:artifact.sha256}]};}},report:async r=>{calls.push('report');receipts.push(r);}};return {ports,calls,receipts,stop:()=>{active=false;}};}
test('large local files go directly to SDKs with scoped-only AWS credentials and metadata reports',async()=>{const f=fixture();const result=await publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports);assert.deepEqual(result,f.receipts);assert.deepEqual(f.calls,['parent','scope','s3','report','tokenfile','hf','report']);assert.equal(result[0]?.kind,'s3');assert.equal(result[1]?.kind,'hf');assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('/outputs/'));});
test('scope-down denial does not fall back to parent upload or resolve HF token',async()=>{const f=fixture();f.ports.scopeDown.withCredentials=async()=>{throw new Error('denied');};await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports));assert.deepEqual(f.calls,['parent']);assert.equal(f.receipts.length,0);});
test('all metadata IDs are admitted before any irreversible upload',async()=>{
 for(const hfReceiptId of ['bad id',artifact.receiptId]){const f=fixture();await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId,expiresAt:100000},f.ports));assert.deepEqual(f.calls,[]);}
});
test('quota path escape and current-authority failure prevent any SDK calls',async()=>{
 for(const changed of [{name:'../outside'},{path:'/etc/passwd'},{size:2000000001}]){const f=fixture();await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[{...artifact,...changed}],hfReceiptId:'hf-1',expiresAt:100000},f.ports));assert.deepEqual(f.calls,[]);}
 const f=fixture();f.stop();await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports));assert.deepEqual(f.calls,[]);
});

test('small git-tracked HF files bind their actual git object hash instead of claiming LFS SHA',async()=>{
 const f=fixture();const gitSha1='f'.repeat(40);const config={...artifact,gitSha1};f.ports.inspectArtifact=async()=>({size:artifact.size,sha256:artifact.sha256,regularFile:true,symlink:false,gitSha1});
 f.ports.sdk.hfCommit=async()=>({commit:'e'.repeat(40),files:[{path:artifact.name,size:artifact.size,oid:gitSha1}]});
 const result=await publishDelegatedArtifacts({binding,descriptor,artifacts:[config],hfReceiptId:'hf-1',expiresAt:100000},f.ports);assert.equal(result[1]?.kind,'hf');
});

test('scoped credential validity is checked after asynchronous workload refresh immediately before SDK',async()=>{
 const f=fixture();let valid=true;let scopes=0;
 f.ports.scopeDown.withCredentials=async(_parent,_request,consume)=>{scopes++;return consume({accessKeyId:'scoped',secretAccessKey:'scopedsecret',sessionToken:'scopedsession'},{expiresAt:2000,assertValid:()=>{if(!valid)throw new Error('child expired');}});};
 f.ports.assertCurrent=async()=>{if(scopes){await Promise.resolve();valid=false;}};
 await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports));assert.ok(!f.calls.includes('s3'));assert.equal(f.receipts.length,0);
});

test('GSC publisher requires exact approved delivery policy duration purpose and role before SDK',async()=>{
 for(const change of ['missing','policy','duration','role','purpose']){
  const d=structuredClone(descriptor);if(change==='missing')delete d.awsDelivery;
  else if(change==='policy')d.awsDelivery!.policySha256='0'.repeat(64);
  else if(change==='duration')d.awsDelivery!.durationSeconds=121;
  else if(change==='role')d.awsDelivery!.roleArn='arn:aws:iam::123456789012:role/OtherRole';
  else (d.awsDelivery as unknown as {purpose:string}).purpose='other';
  const f=fixture();await assert.rejects(publishDelegatedArtifacts({binding:{...binding,descriptorHash:change==='duration'||change==='purpose'?binding.descriptorHash:workloadFingerprint(d)},descriptor:d,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports));assert.ok(!f.calls.includes('s3'));assert.ok(!f.calls.includes('hf'));
 }
});
test('publisher consumes the exact shorter GSC duration included in approval',async()=>{
 const d=structuredClone(descriptor);d.awsDelivery!.durationSeconds=60;const f=fixture();let duration=0;
 f.ports.scopeDown.withCredentials=async(_parent,request,consume)=>{duration=request.durationSeconds;return consume({accessKeyId:'scoped',secretAccessKey:'scopedsecret',sessionToken:'scopedsession'},{expiresAt:61000,assertValid:()=>{}});};
 await publishDelegatedArtifacts({binding:{...binding,descriptorHash:workloadFingerprint(d)},descriptor:d,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports);assert.equal(duration,60);
});
test('missing empty or null S3 version never becomes a report or HF publication',async()=>{
 for(const versionId of [undefined,'','null']){
  const f=fixture();f.ports.sdk.s3Upload=async()=>({versionId} as {versionId:string});
  await assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt:100000},f.ports),/versioned S3 result required/);
  assert.equal(f.receipts.length,0);assert.ok(!f.calls.includes('report'));assert.ok(!f.calls.includes('tokenfile'));assert.ok(!f.calls.includes('hf'));
 }
});
for(const phase of ['tokenfile','hf'] as const)test(`authority expiring during awaited ${phase} admission prevents the next HF side effect`,async()=>{
 const f=fixture();let now=1000;const expiresAt=100000;f.ports.now=()=>now;
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<void>(r=>{release=r;});
 f.ports.assertCurrent=async()=>{
  if(f.receipts.length===1&&(phase==='tokenfile'?!f.calls.includes('tokenfile'):f.calls.includes('tokenfile'))){enter();await held;}
 };
 const outcome=assert.rejects(publishDelegatedArtifacts({binding,descriptor,artifacts:[artifact],hfReceiptId:'hf-1',expiresAt},f.ports),/upload authority expired/);
 await entered;now=expiresAt;release();await outcome;
 assert.equal(f.receipts.length,1);assert.equal(f.receipts[0]!.kind,'s3');assert.ok(!f.calls.includes('hf'));
 if(phase==='tokenfile')assert.ok(!f.calls.includes('tokenfile'));
});
