import {WorkloadDescriptorSchema} from '../../contracts/src/delegated.js';
import {buildDelegatedInstancePolicy} from './delegated-instance-policy.js';
/** Validate before training as well as immediately before the SDK upload path. */
export function delegatedUploadAdmission(input:unknown):{scopePolicy:string;policyHash:string;durationSeconds:number;roleArn:string}{
 const d=WorkloadDescriptorSchema.parse(input),delivery=d.awsDelivery;
 const built=buildDelegatedInstancePolicy({accountId:d.accountId,region:d.region,bucket:d.s3.bucket,prefix:d.s3.prefix,policyRevision:d.iam.policyRevision});
 if(!delivery||delivery.mode!=='instance_role_scoped'||delivery.purpose!=='delegated-upload'||delivery.policySha256!==built.scopePolicyHash||!delivery.roleArn.startsWith(`arn:aws:iam::${d.accountId}:role/`))throw new Error('approved AWS delivery required');
 return {scopePolicy:JSON.stringify(built.scopePolicy),policyHash:built.scopePolicyHash,durationSeconds:delivery.durationSeconds,roleArn:delivery.roleArn};
}
