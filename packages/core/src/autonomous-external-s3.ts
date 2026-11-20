import {createHash} from 'node:crypto';
import type {ExternalS3InspectParameters,ExternalS3Parameters,ExternalS3Target} from '../../contracts/src/autonomous-external-s3.js';
import type {ExternalInvocation} from '../../contracts/src/autonomous-external.js';

/** Same 1 MiB limit as the external artifact body. */
export const EXTERNAL_S3_MAX_OBJECT_BYTES=1024*1024;
function reject():never {throw new Error('Invalid S3 parameters');}
function plain(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)reject();
  const descriptors=Object.getOwnPropertyDescriptors(value),allowed=new Set([...required,...optional]);
  if(Object.getOwnPropertySymbols(value).length||Object.entries(descriptors).some(([k,d])=>!allowed.has(k)||!('value' in d)||!d.enumerable)||required.some(k=>!Object.hasOwn(descriptors,k)))reject();
  return value as Record<string,unknown>;
}
function matches(value:unknown,pattern:RegExp):asserts value is string {if(typeof value!=='string'||!pattern.test(value))reject();}
function integer(value:unknown,min:number,max:number):asserts value is number {if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)reject();}
const SUFFIX=/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$/;
// A '.' segment (including a trailing '/.') is normalized away by URL parsing, so the signed path would differ from the requested one.
function cleanPath(value:string):boolean {return !value.includes('..')&&!value.includes('//')&&!value.split('/').includes('.');}
export function validateExternalS3Target(value:unknown):ExternalS3Target {
  const t=plain(value,['accountId','region','bucket','prefix','maxObjectBytes','retentionDays'],['kmsKeyId']);
  matches(t.accountId,/^\d{12}$/);matches(t.region,/^[a-z]{2}-[a-z]+-\d$/);
  // Dotted names break virtual-hosted TLS addressing and are rejected.
  matches(t.bucket,/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  matches(t.prefix,/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,126}\/$/);if(!cleanPath(t.prefix))reject();
  if(t.kmsKeyId!==undefined)matches(t.kmsKeyId,/^[A-Za-z0-9:/_-]{1,2048}$/);
  integer(t.maxObjectBytes,1,EXTERNAL_S3_MAX_OBJECT_BYTES);integer(t.retentionDays,1,3650);
  return {accountId:t.accountId,region:t.region,bucket:t.bucket,prefix:t.prefix,...(t.kmsKeyId!==undefined?{kmsKeyId:t.kmsKeyId as string}:{}),maxObjectBytes:t.maxObjectBytes,retentionDays:t.retentionDays};
}
function suffix(value:unknown):string {matches(value,SUFFIX);if(!cleanPath(value)||value.endsWith('/'))reject();return value;}
export function validateExternalS3Parameters(value:unknown):ExternalS3Parameters {
  const p=plain(value,['keySuffix','artifactDigest']);matches(p.artifactDigest,/^[a-f0-9]{64}$/);
  return {keySuffix:suffix(p.keySuffix),artifactDigest:p.artifactDigest};
}
export function validateExternalS3InspectParameters(value:unknown):ExternalS3InspectParameters {
  const p=plain(value,['putActionId']);matches(p.putActionId,/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
  return {putActionId:p.putActionId};
}
/** The put whose object an invocation addresses: itself for put, the owned put for inspect. */
export function externalS3PutOf(i:Pick<ExternalInvocation,'operation'|'parameters'|'ownedPut'|'ownershipToken'|'idempotencyKey'|'parametersHash'>):{ownershipToken:string;idempotencyKey:string;parametersHash:string;parameters:ExternalS3Parameters} {
  if(i.operation==='aws.s3.put')return {ownershipToken:i.ownershipToken,idempotencyKey:i.idempotencyKey,parametersHash:i.parametersHash,parameters:validateExternalS3Parameters(i.parameters)};
  if(i.operation!=='aws.s3.inspect'||!i.ownedPut)reject();
  const o=i.ownedPut!;
  if(validateExternalS3InspectParameters(i.parameters).putActionId!==o.actionId)reject();
  return {ownershipToken:o.ownershipToken,idempotencyKey:o.idempotencyKey,parametersHash:o.parametersHash,parameters:validateExternalS3Parameters(o.parameters)};
}
/** The only way to build an object key: server prefix plus a validated suffix. */
export function externalS3ObjectKey(target:Pick<ExternalS3Target,'prefix'>,keySuffix:string):string {
  matches(target.prefix,/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,126}\/$/);if(!cleanPath(target.prefix))reject();
  return target.prefix+suffix(keySuffix);
}
/** Binds a stored object to one action; written as object metadata and compared on 412 and inspect. */
export function externalS3Mark(i:Pick<ExternalInvocation,'ownershipToken'|'idempotencyKey'|'parametersHash'>):string {
  return createHash('sha256').update(JSON.stringify([i.ownershipToken,i.idempotencyKey,i.parametersHash])).digest('hex');
}
