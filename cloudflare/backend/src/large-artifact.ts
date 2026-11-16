export interface LargeArtifactRef {
 name:'source'|'data'; sha256:string; sizeBytes:number; format:'tar.gz'|'file'; expandedBytes:number; maxFiles:number;
}
export interface ArtifactReadGrant {jobId:string;attempt:string;expiresAt:number}
export const PART_BYTES=8*1024*1024;
export const MAX_ARTIFACT_BYTES=8*1024**3;
export function largeArtifactKey(sha256:string):string {
 if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid artifact digest');
 return 'large-inputs/'+sha256;
}
export function validateLargeArtifactRef(value:unknown):LargeArtifactRef {
 const r=value as LargeArtifactRef;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['name','sha256','sizeBytes','format','expandedBytes','maxFiles'].includes(k))||
  !['source','data'].includes(r.name)||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||
  !Number.isSafeInteger(r.sizeBytes)||r.sizeBytes<1||r.sizeBytes>(r.name==='source'?1024**3:MAX_ARTIFACT_BYTES)||!['tar.gz','file'].includes(r.format)||
  !Number.isSafeInteger(r.expandedBytes)||r.expandedBytes<1||r.expandedBytes>(r.name==='source'?2:8)*1024**3||
  !Number.isSafeInteger(r.maxFiles)||r.maxFiles<1||r.maxFiles>100000||
  (r.name==='source'&&r.format!=='tar.gz')||(r.name==='data'&&r.format!=='file')||
  (r.format==='file'&&(r.maxFiles!==1||r.expandedBytes!==r.sizeBytes)))throw Error('Invalid large artifact reference');
 return {name:r.name,sha256:r.sha256,sizeBytes:r.sizeBytes,format:r.format,expandedBytes:r.expandedBytes,maxFiles:r.maxFiles};
}
export function validateLargeArtifacts(value:unknown):LargeArtifactRef[]{
 if(!Array.isArray(value)||value.length<1||value.length>2)throw Error('Invalid large artifact list');
 const refs=value.map(validateLargeArtifactRef);
 if(new Set(refs.map(r=>r.name)).size!==refs.length||refs.reduce((n,r)=>n+r.expandedBytes,0)>14*1024**3)throw Error('Artifact name or disk limit exceeded');
 return refs;
}
export function authorizeArtifactRead(grant:ArtifactReadGrant|undefined,job:any,digest:string,now:number):boolean {
 return !!grant&&!!job&&job.kind==='compute'&&job.id===grant.jobId&&job.attempt===grant.attempt&&
  ['STARTING','RUNNING'].includes(job.status)&&!job.containerStopped&&!job.cancellationRequested&&
  now<grant.expiresAt&&now<job.deadline&&Array.isArray(job.largeArtifacts)&&job.largeArtifacts.some((r:LargeArtifactRef)=>r.sha256===digest);
}
