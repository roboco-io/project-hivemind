import {createHash} from 'node:crypto';
export interface DelegatedInstancePolicyInput { accountId:string;region:string;bucket:string;prefix:string;policyRevision:string;maxScopedSeconds?:number; inputVersions?:readonly {key:string;versionId:string}[] }
export interface DelegatedIamPolicy {Version:'2012-10-17';Statement:Record<string,unknown>[]}
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function buildDelegatedInstancePolicy(input:DelegatedInstancePolicyInput):{policy:DelegatedIamPolicy;policyHash:string;scopePolicy:DelegatedIamPolicy;scopePolicyHash:string} {
 const {accountId,region,bucket,prefix,policyRevision}=input;const maxScopedSeconds=input.maxScopedSeconds??120;
 const safePath=(p:string)=>p.length<=512&&!p.startsWith('/')&&!p.includes('..')&&/^[A-Za-z0-9_./-]+$/.test(p);
 if(!/^\d{12}$/.test(accountId)||!/^[a-z]{2}-[a-z]+-[0-9]+$/.test(region)||!Number.isSafeInteger(maxScopedSeconds)||maxScopedSeconds<1||maxScopedSeconds>120||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||!safePath(prefix)||!prefix.endsWith('/')||!/^[A-Za-z0-9_-]{1,64}$/.test(policyRevision)||(input.inputVersions?.length??0)>64)throw new Error('invalid delegated IAM scope');
 const bucketArn=`arn:aws:s3:::${bucket}`,objectArn=bucketArn+'/'+prefix+'*';
 const objectActions=['s3:PutObject','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'];
 const conditions={StringEquals:{'aws:RequestedRegion':region,'s3:ResourceAccount':accountId}};
 const uploads:Record<string,unknown>[]=[{Sid:'UploadApprovedPrefix',Effect:'Allow',Action:objectActions,Resource:objectArn,Condition:conditions}];
 const scopePolicy:DelegatedIamPolicy={Version:'2012-10-17',Statement:structuredClone(uploads)};
 const versions=(input.inputVersions??[]).map(v=>{if(!safePath(v.key)||!v.key.startsWith(prefix)||!v.versionId||v.versionId.length>256||/[\s*?]/.test(v.versionId))throw new Error('invalid delegated IAM version');return v;}).sort((a,b)=>a.key.localeCompare(b.key)||a.versionId.localeCompare(b.versionId));
 const policy:DelegatedIamPolicy={Version:'2012-10-17',Statement:[
  {Sid:'PolicyRevision'+hash(policyRevision).slice(0,16),Effect:'Deny',NotAction:[...objectActions,'s3:GetObjectVersion','sts:GetScopedCredentials','sts:GetCallerIdentity'],Resource:'*'},
  {Sid:'DenyOtherRegion',Effect:'Deny',Action:'*',Resource:'*',Condition:{StringNotEquals:{'aws:RequestedRegion':region}}},
  {Sid:'DenyObjectScopeEscape',Effect:'Deny',Action:[...objectActions,'s3:GetObjectVersion'],NotResource:objectArn},
  {Sid:'DenyUnexpectedObjectOwner',Effect:'Deny',Action:[...objectActions,'s3:GetObjectVersion'],Resource:'*',Condition:{StringNotEquals:{'s3:ResourceAccount':accountId}}},
  ...uploads,
  ...(versions.length?[{Sid:'DenyUnapprovedInputKey',Effect:'Deny',Action:'s3:GetObjectVersion',NotResource:[...new Set(versions.map(v=>bucketArn+'/'+v.key))]},
   ...[...new Set(versions.map(v=>v.key))].map((key,i)=>({Sid:'DenyUnapprovedInputVersion'+i,Effect:'Deny',Action:'s3:GetObjectVersion',Resource:bucketArn+'/'+key,Condition:{StringNotEquals:{'s3:VersionId':versions.filter(v=>v.key===key).map(v=>v.versionId)}}}))
  ]:[{Sid:'DenyAllInputReads',Effect:'Deny',Action:'s3:GetObjectVersion',Resource:'*'}]),
  ...versions.map((v,i)=>({Sid:'ReadApprovedVersion'+i,Effect:'Allow',Action:'s3:GetObjectVersion',Resource:bucketArn+'/'+v.key,Condition:{StringEquals:{...conditions.StringEquals,'s3:VersionId':v.versionId}}})),
  {Sid:'ScopeDownShortSession',Effect:'Allow',Action:'sts:GetScopedCredentials',Resource:'*',Condition:{NumericLessThanEquals:{'sts:DurationSeconds':maxScopedSeconds},Null:{'sts:DurationSeconds':'false'}}},
  {Sid:'DenyLongScopedSession',Effect:'Deny',Action:'sts:GetScopedCredentials',Resource:'*',Condition:{NumericGreaterThan:{'sts:DurationSeconds':maxScopedSeconds}}},
  {Sid:'DenyImplicitScopedDuration',Effect:'Deny',Action:'sts:GetScopedCredentials',Resource:'*',Condition:{Null:{'sts:DurationSeconds':'true'}}},
 ]};
 return {policy,policyHash:hash(policy),scopePolicy,scopePolicyHash:hash(scopePolicy)};
}
