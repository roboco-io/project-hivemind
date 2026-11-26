import {createHash} from 'node:crypto';
import type {ExternalLargeFile,ExternalLargeLimits,ExternalLargeManifest} from '../../contracts/src/autonomous-external-large.js';

export const LARGE_PART_BYTES=8*1024*1024;
const HEX=/^[a-f0-9]{64}$/;
function reject():never{throw new Error('Invalid external large artifact manifest');}
function requireThat(condition:unknown):asserts condition{if(!condition)reject();}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export const largeOwnerKey=(taskId:string,revision:number,profileId:string)=>sha('hivemind-large-owner-v1\n'+JSON.stringify([taskId,revision,profileId]));
export const largeStorageRef=(ownerKey:string,sha256:string)=>`external-large/${ownerKey}/${sha256}`;
/** Same path rules as inline artifacts: relative, no traversal, no credential-looking names. */
export function validateLargePath(path:unknown):string{
 requireThat(typeof path==='string'&&path.length>=1&&path.length<=240);
 requireThat(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path)&&!path.includes('..')&&!path.includes('//')&&!path.endsWith('/'));
 requireThat(!/(^|\/)(?:\.?(?:env|git|ssh|aws|codex|claude|hivemind)|runtime|private|secrets?|credentials?|auth(?:entication)?|tokens?|sessions?)(?:[./_-]|$)/i.test(path)&&!/(?:\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i.test(path));
 return path;
}
export function validateLargeSha256(value:unknown):string{requireThat(typeof value==='string'&&HEX.test(value));return value;}
export function validateLargeSize(value:unknown,max:number):number{requireThat(typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=max);return value;}
function exact(value:unknown,keys:string[]):Record<string,unknown>{
 requireThat(value!==null&&typeof value==='object'&&!Array.isArray(value));
 const record=value as Record<string,unknown>,actual=Object.keys(record);
 requireThat(actual.length===keys.length&&keys.every(k=>Object.hasOwn(record,k)));return record;
}
export function validateExternalLargeManifest(value:unknown,limits:ExternalLargeLimits):ExternalLargeManifest{
 const m=exact(value,['version','taskId','revision','profileId','files']);
 requireThat(m.version===1&&typeof m.taskId==='string'&&m.taskId.length>=1&&m.taskId.length<=240&&typeof m.profileId==='string'&&m.profileId.length>=1&&m.profileId.length<=240);
 requireThat(typeof m.revision==='number'&&Number.isSafeInteger(m.revision)&&m.revision>=1);
 requireThat(Array.isArray(m.files)&&m.files.length>=1&&m.files.length<=limits.maxFiles);
 const owner=largeOwnerKey(m.taskId as string,m.revision as number,m.profileId as string),seen=new Set<string>();let total=0;
 const files=(m.files as unknown[]).map((raw):ExternalLargeFile=>{
  const f=exact(raw,['path','size','sha256','storageRef']);
  const path=validateLargePath(f.path),size=validateLargeSize(f.size,limits.maxFileBytes),digest=validateLargeSha256(f.sha256);
  requireThat(f.storageRef===largeStorageRef(owner,digest));requireThat(!seen.has(path));seen.add(path);
  total+=size;requireThat(total<=limits.maxTotalBytes);
  return {path,size,sha256:digest,storageRef:f.storageRef as string};
 });
 return {version:1,taskId:m.taskId as string,revision:m.revision as number,profileId:m.profileId as string,files};
}
/** Digest of the canonical manifest. File order does not matter; paths are unique. */
export function externalLargeManifestDigest(m:ExternalLargeManifest):string{
 const files=[...m.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(f=>({path:f.path,size:f.size,sha256:f.sha256,storageRef:f.storageRef}));
 return sha('hivemind-large-v1\n'+JSON.stringify({version:m.version,taskId:m.taskId,revision:m.revision,profileId:m.profileId,files}));
}
export function largePartPlan(size:number,partBytes=LARGE_PART_BYTES):{partBytes:number;count:number;lastBytes:number}{
 requireThat(Number.isSafeInteger(size)&&size>=1&&Number.isSafeInteger(partBytes)&&partBytes>=1);
 const count=Math.ceil(size/partBytes);return {partBytes,count,lastBytes:size-(count-1)*partBytes};
}
