import {delegatedUploadAdmission} from '../../packages/adapters/src/delegated-upload-admission.js';
import {createHash} from 'node:crypto';
import {InputManifestSchema,WorkloadDescriptorSchema} from '../../packages/contracts/src/delegated.js';
import {inputManifestDigest,workloadFingerprint} from '../../packages/core/src/delegated.js';
import type {DelegatedBinding,InputManifest,WorkloadDescriptor} from '../../packages/contracts/src/delegated.js';
export const APPROVED_TRAINING_ENTRYPOINT='/opt/hivemind/bin/train-approved';
export interface DelegatedTrainingIsolation {imdsBlocked:true;credentialFilesHidden:true;unprivileged:true}
export interface DelegatedBootstrapPorts {
 readBootstrap():Promise<Uint8Array>;readManifest():Promise<Uint8Array>;
 verifyInput(ref:InputManifest['code']):Promise<string>;
 enrollBootstrapKey():Promise<{keyThumbprint:string}>;
 isolateTraining():Promise<DelegatedTrainingIsolation>;
 runTraining(input:{entrypoint:typeof APPROVED_TRAINING_ENTRYPOINT;manifest:InputManifest;env:Record<string,string>}):Promise<void>;
 uploadAndReport():Promise<void>;
}
export async function runTrustedDelegatedBootstrap(input:{descriptor:WorkloadDescriptor;binding:DelegatedBinding;environment?:Record<string,string|undefined>},ports:DelegatedBootstrapPorts):Promise<void>{
 const descriptor=WorkloadDescriptorSchema.parse(input.descriptor),binding=structuredClone(input.binding);
 if(binding.descriptorHash!==workloadFingerprint(descriptor)||binding.workloadId!==descriptor.workloadId||binding.accountId!==descriptor.accountId||binding.region!==descriptor.region)throw new Error('bootstrap approval mismatch');
 delegatedUploadAdmission(descriptor);
 const self=await ports.readBootstrap();if(self.byteLength>4*1024*1024||createHash('sha256').update(self).digest('hex')!==descriptor.bootstrapSha256)throw new Error('bootstrap integrity mismatch');
 const bytes=await ports.readManifest();if(bytes.byteLength>65536)throw new Error('manifest exceeds limit');
 const manifest=InputManifestSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 if(!descriptor.inputManifestDigests.includes(inputManifestDigest(manifest)))throw new Error('manifest approval mismatch');
 for(const ref of [manifest.code,...manifest.data])if(await ports.verifyInput(structuredClone(ref))!==ref.sha256)throw new Error('input integrity mismatch');
 const key=await ports.enrollBootstrapKey();if(!/^[A-Za-z0-9_-]{43}$/.test(key.keyThumbprint))throw new Error('bootstrap key enrollment failed');
 const isolation=await ports.isolateTraining();if(isolation.imdsBlocked!==true||isolation.credentialFilesHidden!==true||isolation.unprivileged!==true)throw new Error('training isolation required');
 // No inherited environment. Parent/scoped AWS credentials and HF credentials stay in the uploader.
 await ports.runTraining({entrypoint:APPROVED_TRAINING_ENTRYPOINT,manifest:structuredClone(manifest),env:{LANG:'C.UTF-8',PATH:'/usr/local/bin:/usr/bin:/bin'}});
 await ports.uploadAndReport();
}
