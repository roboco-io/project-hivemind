import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, readdir, chmod, rename, rm, rmdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import type { Snapshot, SourceFile } from './contracts.ts';
import { createSnapshot, validateSnapshot, canonicalSourcePath, excludedSourcePath, MAX_SOURCE_BYTES, MAX_SOURCE_FILES, sha256 } from './snapshot.ts';

async function rootDirectory(root:string,create=false):Promise<string> {
  const absolute=resolve(root);
  if(create)await mkdir(absolute,{recursive:true});
  const info=await lstat(absolute);
  if(info.isSymbolicLink())throw new Error('Symlink source root is not allowed');
  if(!info.isDirectory())throw new Error('Source root is not a directory');
  return realpath(absolute);
}
function contains(root:string,path:string):boolean {const rel=relative(root,path);return !rel.startsWith('..'+sep)&&rel!=='..'&&!rel.startsWith(sep);}
async function exists(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function checkedParents(root:string,path:string,create=false):Promise<void> {
  const parent=dirname(path);
  if(!contains(root,parent))throw new Error('Source path escapes root');
  const parts=relative(root,parent).split(sep).filter(Boolean);let current=root;
  for(const part of parts){current=join(current,part);let info=await exists(current);if(!info&&create){await mkdir(current);info=await lstat(current);}if(!info)throw new Error('Source parent directory is missing');if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Symlink or non-directory source parent');}
  if(!contains(root,await realpath(parent)))throw new Error('Source parent escapes root');
}
async function sourceFile(root:string,path:string,limit:number):Promise<SourceFile> {
  const full=join(root,...path.split('/'));await checkedParents(root,full);
  const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat({bigint:true});if(!before.isFile())throw new Error('Only regular source files are allowed');
    if(before.size>BigInt(limit))throw new Error('Source byte size limit exceeded');
    const chunks:Buffer[]=[];let size=0;
    while(true){const b=Buffer.alloc(Math.min(65536,limit-size+1));const {bytesRead}=await handle.read(b,0,b.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)throw new Error('Source byte size limit exceeded');chunks.push(b.subarray(0,bytesRead));}
    const after=await handle.stat({bigint:true});
    if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Source changed while reading');
    await checkedParents(root,full);
    const current=await lstat(full,{bigint:true});if(current.isSymbolicLink()||current.ino!==after.ino||current.dev!==after.dev)throw new Error('Source changed while reading');
    const content=Buffer.concat(chunks);return {path,content:content.toString('base64'),sha256:sha256(content),executable:Boolean(after.mode&0o111n)};
  }finally{await handle.close();}
}
export async function readSnapshot(root:string):Promise<Snapshot> {
  const base=await rootDirectory(root),files:SourceFile[]=[];let bytes=0;
  const walk=async(directory:string,prefix:string):Promise<void>=>{
    for(const entry of (await readdir(directory)).sort()){
      const raw=prefix?prefix+'/'+entry:entry,full=join(directory,entry),info=await lstat(full);
      if(info.isSymbolicLink())throw new Error('Symlink source entries are not allowed');
      if(excludedSourcePath(raw))continue;
      const path=canonicalSourcePath(raw);
      if(info.isDirectory()){if(!contains(base,await realpath(full)))throw new Error('Source directory escapes root');await walk(full,raw);}
      else if(info.isFile()){if(files.length>=MAX_SOURCE_FILES)throw new Error('Source file count limit exceeded');const f=await sourceFile(base,raw,MAX_SOURCE_BYTES-bytes);f.path=path;bytes+=Buffer.from(f.content,'base64').length;files.push(f);}
      else throw new Error('Only regular source files are allowed');
    }
  };
  await walk(base,'');return createSnapshot(files);
}
async function writeExclusive(root:string,file:SourceFile):Promise<void>{const full=join(root,...file.path.split('/'));await checkedParents(root,full,true);const h=await open(full,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,file.executable?0o755:0o644);try{await h.writeFile(Buffer.from(file.content,'base64'));await h.chmod(file.executable?0o755:0o644);}finally{await h.close();}}
export async function restoreSnapshot(root:string,value:Snapshot):Promise<void>{
  const snapshot=validateSnapshot(value),base=await rootDirectory(root,true);
  if((await readdir(base)).length)throw new Error('Restore root must be empty; existing files are not overwritten');
  const written:string[]=[];
  try{for(const f of snapshot.files){await writeExclusive(base,f);written.push(f.path);}}
  catch(error){for(const path of written.reverse())await rm(join(base,...path.split('/')),{force:true}).catch(()=>{});throw error;}
}
const same=(a:SourceFile|undefined,b:SourceFile|undefined)=>a?.sha256===b?.sha256&&a?.executable===b?.executable;
async function assertCurrent(root:string,path:string,expected:SourceFile|undefined):Promise<void>{
 const full=join(root,...path.split('/'));const info=await exists(full);
 if(!expected){if(info)throw new Error('User file collision during apply');return;}
 if(!info||info.isSymbolicLink()||!info.isFile())throw new Error('Source changed during apply');
 const f=await sourceFile(root,path,MAX_SOURCE_BYTES);if(!same(f,expected))throw new Error('Source changed during apply');
}
async function prune(root:string,path:string):Promise<void>{let parent=dirname(path);while(parent!==root&&contains(root,parent)){try{await rmdir(parent);}catch{return;}parent=dirname(parent);}}
export async function applySnapshot(root:string,baseValue:Snapshot,outputValue:Snapshot):Promise<void>{
 const input=validateSnapshot(baseValue),output=validateSnapshot(outputValue),base=await rootDirectory(root);
 const current=await readSnapshot(base);if(current.digest!==input.digest)throw new Error('Apply conflict: current source does not match the base snapshot');
 const old=new Map(input.files.map(f=>[f.path,f])),next=new Map(output.files.map(f=>[f.path,f]));
 // Reject an existing directory at a newly-created file path before any source mutation.
 for(const f of output.files){const info=await exists(join(base,...f.path.split('/')));if(!old.has(f.path)&&info)throw new Error('Apply conflict: new path collides with an existing entry');}
 const removed=input.files.filter(f=>!next.has(f.path));
 const changed=output.files.filter(f=>!same(old.get(f.path),f));
 const internal=join(base,'.hivemind');let internalInfo=await exists(internal);if(!internalInfo){await mkdir(internal,{mode:0o700});internalInfo=await lstat(internal);}if(internalInfo.isSymbolicLink()||!internalInfo.isDirectory())throw new Error('Unsafe apply backup directory');
 const lock=await open(join(internal,'apply.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600).catch(()=>{throw new Error('Another apply operation is already active');});
 let staging='';const committed:Array<{path:string;after?:SourceFile}>=[];let keepBackup=false;
 try{
  staging=await mkdtemp(join(internal,'apply-'));
  await writeFile(join(staging,'base.json'),JSON.stringify(input),{mode:0o600});
  for(let i=0;i<changed.length;i++){const f=changed[i]!;await writeFile(join(staging,String(i)),Buffer.from(f.content,'base64'),{mode:f.executable?0o755:0o644});await chmod(join(staging,String(i)),f.executable?0o755:0o644);}
  // Re-read after staging to detect edits that happened during preflight.
  if((await readSnapshot(base)).digest!==input.digest)throw new Error('Apply conflict: source changed after preflight');
  for(const f of removed){await assertCurrent(base,f.path,f);const full=join(base,...f.path.split('/'));await checkedParents(base,full);await rm(full);committed.push({path:f.path});await prune(base,full);}
  for(let i=0;i<changed.length;i++){
   const f=changed[i]!,full=join(base,...f.path.split('/'));await checkedParents(base,full,true);await assertCurrent(base,f.path,old.get(f.path));
   // Rename is atomic on this filesystem; the preceding check protects known user edits.
   await rename(join(staging,String(i)),full);committed.push({path:f.path,after:f});
  }
 }catch(error){
  const failures:string[]=[];
  for(const entry of committed.reverse()){
   try{await assertCurrent(base,entry.path,entry.after);const full=join(base,...entry.path.split('/'));await checkedParents(base,full,true);const before=old.get(entry.path);if(before){const rollback=join(staging,'rollback');await writeFile(rollback,Buffer.from(before.content,'base64'),{mode:before.executable?0o755:0o644});await chmod(rollback,before.executable?0o755:0o644);await rename(rollback,full);}else{await rm(full,{force:true});await prune(base,full);}}
   catch{failures.push(entry.path);}
  }
  if(failures.length){keepBackup=true;throw new Error(`Apply failed; rollback conflicts preserved in the private backup directory (${failures.length} paths)`);}
  throw new Error(`Apply failed and prior writes were rolled back: ${error instanceof Error?error.message:'filesystem error'}`);
 }finally{await lock.close();await rm(join(internal,'apply.lock'),{force:true});if(staging&&!keepBackup)await rm(staging,{recursive:true,force:true});}
}
