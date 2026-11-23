import {createHash} from 'node:crypto';
import {WorkloadDescriptorSchema,DelegatedReceiptSchema} from '../../packages/contracts/src/delegated.js';
import {workloadFingerprint} from '../../packages/core/src/delegated.js';
import {delegatedUploadAdmission} from '../../packages/adapters/src/delegated-upload-admission.js';
import type {DelegatedBinding,WorkloadDescriptor,DelegatedReceipt,HfReceipt} from '../../packages/contracts/src/delegated.js';
import type {AwsParentSession,AwsScopeDownRequest,AwsScopedCredentialControl} from '../../packages/adapters/src/aws-scoped-credentials.js';
import type {AwsSessionCredentials} from '../../packages/adapters/src/aws-web-identity.js';
export interface DelegatedLocalArtifact {path:string;name:string;size:number;sha256:string;receiptId:string;gitSha1?:string}
export interface DelegatedDirectSdkPort {
 /** Local official SDK: streamed file body, fixed regional S3, never the central HTTP API. */
 s3Upload(input:{bucket:string;key:string;path:string;size:number;sha256:string;accountId:string;region:string},credentials:AwsSessionCredentials):Promise<{versionId:string}>;
 /** tokenFile is private uploader-only; HF SDK must not persist its token elsewhere. */
 hfCommit(input:{repo:string;visibility:'private'|'public';artifacts:readonly DelegatedLocalArtifact[];tokenFile:string}):Promise<{commit:string;files:HfReceipt['files']}>;
}
export interface DelegatedPublisherPorts {
 assertCurrent(binding:DelegatedBinding):Promise<void>;
 inspectArtifact(path:string):Promise<{size:number;sha256:string;regularFile:boolean;symlink:boolean;gitSha1?:string}>;
 withParentCredentials<T>(consume:(parent:AwsParentSession)=>Promise<T>):Promise<T>;
 scopeDown:{withCredentials<T>(parent:Readonly<AwsParentSession>,request:Readonly<AwsScopeDownRequest>,consume:(credentials:AwsSessionCredentials,control:AwsScopedCredentialControl)=>Promise<T>):Promise<T>};
 withHfTokenFile<T>(consume:(path:string)=>Promise<T>):Promise<T>;
 sdk:DelegatedDirectSdkPort;report(receipt:DelegatedReceipt):Promise<void>;now?:()=>number;
}
export async function publishDelegatedArtifacts(input:{binding:DelegatedBinding;descriptor:WorkloadDescriptor;artifacts:readonly DelegatedLocalArtifact[];hfReceiptId:string;expiresAt:number},ports:DelegatedPublisherPorts):Promise<DelegatedReceipt[]>{
 const d=WorkloadDescriptorSchema.parse(input.descriptor),binding=structuredClone(input.binding),artifacts=structuredClone(input.artifacts);
 const now=ports.now??Date.now;const expiresAt=input.expiresAt;
 if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.hfReceiptId)||artifacts.some(a=>a.receiptId===input.hfReceiptId))throw new Error('receipt identity denied');
 const assertCurrent=async()=>{if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())throw new Error('upload authority expired');await ports.assertCurrent(binding);if(expiresAt<=now())throw new Error('upload authority expired');};
 if(binding.descriptorHash!==workloadFingerprint(d)||binding.workloadId!==d.workloadId||binding.accountId!==d.accountId||binding.region!==d.region)throw new Error('upload approval mismatch');
 const delivery=delegatedUploadAdmission(d),{scopePolicy,policyHash}=delivery;
 if(!artifacts.length||artifacts.length>Math.min(d.s3.maxObjects,256)||new Set(artifacts.map(a=>a.name)).size!==artifacts.length||new Set(artifacts.map(a=>a.receiptId)).size!==artifacts.length)throw new Error('artifact quota or duplicate');
 let total=0;
 for(const a of artifacts){
  if(!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/.test(a.name)||a.name.includes('..')||a.name.endsWith('/')||!a.path.startsWith('/outputs/')||a.path.includes('..')||!Number.isSafeInteger(a.size)||a.size<=0||a.size>Math.min(d.s3.maxObjectBytes,5*1024**3)||!/^[a-f0-9]{64}$/.test(a.sha256)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(a.receiptId))throw new Error('artifact scope denied');
  total+=a.size;if(!Number.isSafeInteger(total)||total>d.s3.maxTotalBytes)throw new Error('artifact bytes exceeded');
  const actual=await ports.inspectArtifact(a.path);if(!actual.regularFile||actual.symlink||actual.size!==a.size||actual.sha256!==a.sha256||(a.gitSha1!==undefined&&actual.gitSha1!==a.gitSha1))throw new Error('artifact integrity mismatch');
 }
 const expectedArn=`arn:aws:sts::${binding.accountId}:assumed-role/${delivery.roleArn.split('/').at(-1)}/${binding.instanceId}`;
 const receipts:DelegatedReceipt[]=[];
 for(const a of artifacts){
  await assertCurrent();
  const uploaded=await ports.withParentCredentials(async parent=>{
   if(parent.arn!==expectedArn||parent.sessionId.split(':').at(-1)!==binding.instanceId)throw new Error('parent instance session mismatch');
   return ports.scopeDown.withCredentials(parent,{policy:scopePolicy,policyHash,durationSeconds:delivery.durationSeconds,expiresAt:Math.min(expiresAt,parent.expiresAt),description:'hivemind-upload-'+createHash('sha256').update(binding.taskId+':'+binding.revision).digest('hex').slice(0,32)},async (credentials,control)=>{
    await assertCurrent();control.assertValid();
    return ports.sdk.s3Upload({bucket:d.s3.bucket,key:d.s3.prefix+a.name,path:a.path,size:a.size,sha256:a.sha256,accountId:d.accountId,region:d.region},credentials);
   });
  });
  if(!uploaded.versionId||uploaded.versionId==='null')throw new Error('versioned S3 result required');
  const receipt=DelegatedReceiptSchema.parse({kind:'s3',receiptId:a.receiptId,bucket:d.s3.bucket,key:d.s3.prefix+a.name,versionId:uploaded.versionId,size:a.size,sha256:a.sha256,ownerAccountId:d.accountId});
  await assertCurrent();await ports.report(receipt);receipts.push(receipt);
 }
 await assertCurrent();
 const result=await ports.withHfTokenFile(async tokenFile=>{
  if(tokenFile!==d.hf.delivery.path)throw new Error('HF private token path mismatch');await assertCurrent();
  return ports.sdk.hfCommit({repo:d.hf.repo,visibility:d.hf.visibility,artifacts,tokenFile});
 });
 if(result.files.length!==artifacts.length)throw new Error('HF file result mismatch');
 for(const a of artifacts){const found=result.files.filter(f=>f.path===a.name);if(found.length!==1||found[0]!.size!==a.size||(found[0]!.sha256!==undefined?found[0]!.sha256!==a.sha256:!a.gitSha1||found[0]!.oid!==a.gitSha1))throw new Error('HF file result mismatch');}
 const receipt=DelegatedReceiptSchema.parse({kind:'hf',receiptId:input.hfReceiptId,repo:d.hf.repo,commit:result.commit,visibility:d.hf.visibility,files:result.files});
 await assertCurrent();await ports.report(receipt);receipts.push(receipt);
 return receipts;
}
