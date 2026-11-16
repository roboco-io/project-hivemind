import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {npmCacheMaxBytes,npmCacheOrigin,npmCachePath} from '../npm-cache-object.ts';

const magic=Buffer.from('HVNC1');
const maxEntries=4096;
const pathPattern=/^(?:content-v2\/(sha1|sha256|sha512)\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]+)|index-v5\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60})$/;

function validateEntry(path:string,data:Uint8Array) {
  const match=pathPattern.exec(path);
  if(!match)throw Error('Unexpected npm cache path');
  if(match[1]&&createHash(match[1]).update(data).digest('hex')!==match.slice(2,5).join(''))
    throw Error('npm cache content integrity mismatch');
}

export async function archiveNpmCache(cache:string) {
  const root=join(cache,'_cacache');
  const parts:Uint8Array[]=[magic];
  let bytes=magic.length,entries=0;
  async function visit(path:string,depth:number){
    if(depth>4)throw Error('Unexpected npm cache directory depth');
    for(const entry of await readdir(join(root,path),{withFileTypes:true})){
      const child=path+'/'+entry.name;
      if(entry.isDirectory()){await visit(child,depth+1);continue;}
      if(!entry.isFile()||++entries>maxEntries)throw Error('Unexpected npm cache entry');
      const file=join(root,child),info=await lstat(file),name=Buffer.from(child);
      if(!info.isFile()||bytes+6+name.length+info.size>npmCacheMaxBytes)throw Error('npm cache archive limit exceeded');
      const data=await readFile(file);
      validateEntry(child,data);
      const header=Buffer.alloc(6);
      header.writeUInt16BE(name.length);header.writeUInt32BE(data.length,2);
      parts.push(header,name,data);bytes+=header.length+name.length+data.length;
    }
  }
  await visit('content-v2',1);
  await visit('index-v5',1);
  return Buffer.concat(parts,bytes);
}

export async function restoreNpmCache(cache:string,archive:Buffer){
  if(archive.length>npmCacheMaxBytes||!archive.subarray(0,magic.length).equals(magic))throw Error('Invalid npm cache archive');
  const files=new Map<string,Buffer>();
  for(let offset=magic.length;offset<archive.length;){
    if(offset+6>archive.length||files.size>=maxEntries)throw Error('Invalid npm cache framing');
    const pathLength=archive.readUInt16BE(offset),length=archive.readUInt32BE(offset+2);
    offset+=6;
    if(pathLength>200||offset+pathLength+length>archive.length)throw Error('Invalid npm cache entry size');
    const path=archive.toString('utf8',offset,offset+pathLength);
    offset+=pathLength;
    const data=archive.subarray(offset,offset+length);offset+=length;
    if(files.has(path))throw Error('Duplicate npm cache entry');
    validateEntry(path,data);
    files.set(path,data);
  }
  if(!files.size)throw Error('Empty npm cache archive');
  await mkdir(join(cache,'_cacache'),{recursive:true});
  for(const [path,data] of files){
    const destination=join(cache,'_cacache',path);
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,data,{flag:'wx',mode:0o600});
  }
}

const endpoint=npmCacheOrigin+npmCachePath;
export async function downloadNpmCache(cache:string,capability:string,signal:AbortSignal) {
  const started=performance.now();
  const response=await fetch(endpoint,{headers:{authorization:'Bearer '+capability},signal,redirect:'error'});
  if(response.status===404)return undefined;
  const bytes=Number(response.headers.get('x-hivemind-cache-length')),digest=response.headers.get('x-hivemind-cache-sha256');
  if(!response.ok||!Number.isSafeInteger(bytes)||bytes<=0||bytes>npmCacheMaxBytes||!digest||!/^[a-f0-9]{64}$/.test(digest))
    throw Error('Invalid R2 npm cache response');
  const archive=Buffer.from(await response.arrayBuffer());
  if(archive.length!==bytes||createHash('sha256').update(archive).digest('hex')!==digest)throw Error('R2 npm cache checksum mismatch');
  await restoreNpmCache(cache,archive);
  return {bytes,ms:Math.round(performance.now()-started),sha256:digest};
}

export async function uploadNpmCache(cache:string,capability:string,signal:AbortSignal) {
  const started=performance.now();
  const archive=await archiveNpmCache(cache);
  const sha256=createHash('sha256').update(archive).digest('hex');
  const response=await fetch(endpoint,{method:'PUT',headers:{authorization:'Bearer '+capability,
    'content-type':'application/octet-stream','content-length':String(archive.length),'x-hivemind-cache-length':String(archive.length),'x-hivemind-cache-sha256':sha256},
    body:new Uint8Array(archive),signal,redirect:'error'});
  if(!response.ok)throw Error('R2 npm cache publication failed: HTTP '+response.status);
  return {bytes:archive.length,ms:Math.round(performance.now()-started),sha256};
}
