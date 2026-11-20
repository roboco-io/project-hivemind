import {constants} from 'node:fs';
import {lstat, mkdir, open, link, unlink} from 'node:fs/promises';
import {isAbsolute, join, parse, relative, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAX_PRIVATE_BLOB_BYTES, validatePrivateBlobKey} from './autonomous-session-store.js';
import type {PrivateBlobStore} from './autonomous-session-store.js';
const rejected = () => new Error('Private session rejected');
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export class FilePrivateBlobStore implements PrivateBlobStore {
 readonly durable = true;
 private readonly root: string;
 constructor(options: {root: string}) {
  if (!isAbsolute(options.root) || options.root.split('/').some(p=>p==='..') || resolve(options.root) === parse(options.root).root) throw rejected();
  this.root = resolve(options.root);
 }
 private async directory(): Promise<void> {
  const parts = relative(parse(this.root).root,this.root).split('/');let path = parse(this.root).root;
  for (let i=0;i<parts.length;i++) {
   path = join(path,parts[i]!);
   let info;
   try {info=await lstat(path);} catch(e) {
    if (!missing(e) || i!==parts.length-1) throw rejected();
    try {await mkdir(path,{mode:0o700});} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    info=await lstat(path);
   }
   if (!info.isDirectory() || info.isSymbolicLink() || (info.uid!==0 && info.uid!==process.getuid?.())) throw rejected();
   // A root-owned sticky directory (e.g. /tmp) protects children from other users.
   if ((info.mode&0o022)!==0 && !(info.uid===0 && (info.mode&0o1000)!==0)) throw rejected();
   if (i===parts.length-1 && ((info.mode&0o777)!==0o700 || info.uid!==process.getuid?.())) throw rejected();
  }
 }
 async get(key: string): Promise<Uint8Array | undefined> {
  try {
   validatePrivateBlobKey(key);await this.directory();
   let file;
   try {file=await open(join(this.root,key.slice(8)),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(missing(e))return undefined;throw e;}
   try {
    const info=await file.stat();
    if(!info.isFile() || info.nlink!==1 || (info.mode&0o777)!==0o600 || info.uid!==process.getuid?.() || info.size>MAX_PRIVATE_BLOB_BYTES)throw rejected();
    const bytes=new Uint8Array(info.size);let offset=0;
    while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw rejected();offset+=bytesRead;}
    const tail=new Uint8Array(1);if((await file.read(tail,0,1,offset)).bytesRead)throw rejected();
    const after=await file.stat();if(after.nlink!==1 || after.size!==info.size || after.mtimeMs!==info.mtimeMs)throw rejected();
    await this.directory();return bytes;
   }finally{await file.close();}
  }catch{throw rejected();}
 }
 async put(key: string, bytes: Uint8Array): Promise<void> {
  let temporary: string | undefined;
  try {
   validatePrivateBlobKey(key);if(!(bytes instanceof Uint8Array)||bytes.length>MAX_PRIVATE_BLOB_BYTES)throw rejected();
   const copy=new Uint8Array(bytes);await this.directory();
   temporary=join(this.root,`.pending-${randomUUID()}`);
   const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try {await file.writeFile(copy);await file.sync();}finally{await file.close();}
   await this.directory();
   // Atomic create-if-absent; a crash can leave only an unreferenced pending file.
   await link(temporary,join(this.root,key.slice(8)));await unlink(temporary);temporary=undefined;
   const directory=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
   try {await directory.sync();}finally{await directory.close();}
  }catch{throw rejected();}finally{if(temporary)await unlink(temporary).catch(()=>{});}
 }
}
