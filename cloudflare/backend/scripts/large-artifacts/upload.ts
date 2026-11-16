import {createHash} from 'node:crypto';
import {open,readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PART_BYTES,validateLargeArtifactRef,type LargeArtifactRef} from '../../src/large-artifact.ts';
export async function uploadLargeArtifact(file:string,selection:Pick<LargeArtifactRef,'name'|'format'|'expandedBytes'|'maxFiles'>,origin:string,secretsFile:string){
 const url=new URL(origin);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('Invalid backend origin');
 const info=await stat(secretsFile);if(!info.isFile()||info.mode&0o077)throw Error('Private control-secret file required');
 const {CONTROL_TOKEN}=JSON.parse(await readFile(secretsFile,'utf8'));if(typeof CONTROL_TOKEN!=='string'||!CONTROL_TOKEN||/[\r\n]/.test(CONTROL_TOKEN))throw Error('Invalid control token');
 const request=async(path:string,method='POST',body?:unknown,binary?:ArrayBuffer)=>{
  const response=await fetch(new URL(path,url),{method,headers:{authorization:'Bearer '+CONTROL_TOKEN,...(binary?{'content-type':'application/octet-stream','content-length':String(binary.byteLength)}:{'content-type':'application/json'})},body:binary??(body===undefined?undefined:JSON.stringify(body)),signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok)throw Error('Artifact request rejected '+response.status);return response.json() as Promise<any>;
 };
 const handle=await open(file,'r');let uploadId:string|undefined;
 try{
  const before=await handle.stat();if(!before.isFile())throw Error('Regular artifact file required');
  const hash=createHash('sha256'),buffer=Buffer.alloc(PART_BYTES);let offset=0;
  while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
  if(offset!==before.size)throw Error('Artifact changed during hashing');
  const ref=validateLargeArtifactRef({...selection,sizeBytes:before.size,sha256:hash.digest('hex')});
  const start=await request('/v1/large-artifact-uploads','POST',{ref});if(start.status==='complete')return {ref,status:'complete',reused:true,contentHashVerification:'runtime-required'};
  if(typeof start.id!=='string'||!/^[a-f0-9-]{36}$/.test(start.id))throw Error('Invalid upload identity');uploadId=start.id;
  const prior=new Map<number,any>((start.parts??[]).map((p:any)=>[p.partNumber,p]));
  const uploadedHash=createHash('sha256');offset=0;let number=1;
  while(offset<ref.sizeBytes){
   const size=Math.min(PART_BYTES,ref.sizeBytes-offset);let read=0;
   while(read<size){const next=await handle.read(buffer,read,size-read,offset+read);if(!next.bytesRead)throw Error('Artifact changed during upload');read+=next.bytesRead;}
   const bytes=buffer.subarray(0,size),partHash=createHash('sha256').update(bytes).digest('hex');uploadedHash.update(bytes);
   const existing=prior.get(number);if(existing){if(existing.sha256!==partHash||existing.size!==size)throw Error('Uploaded part differs from file');}
   else await request(`/v1/large-artifact-uploads/${uploadId}/parts/${number}`,'PUT',undefined,Uint8Array.from(bytes).buffer);
   offset+=size;number++;
  }
  const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||uploadedHash.digest('hex')!==ref.sha256)throw Error('Artifact changed during upload');
  await request(`/v1/large-artifact-uploads/${uploadId}/complete`);return {ref,status:'complete',reused:false,contentHashVerification:'runtime-required'};
 }catch(error){if(uploadId)await request(`/v1/large-artifact-uploads/${uploadId}/abort`).catch(()=>{});throw error;}finally{await handle.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [file,name,format,expanded,maxFiles,origin,secrets]=process.argv.slice(2);
 if(!file||!origin||!secrets)throw Error('Usage: upload.ts FILE source|data tar.gz|file EXPANDED_BYTES MAX_FILES ORIGIN PRIVATE_CONTROL_JSON');
 uploadLargeArtifact(file,{name:name as LargeArtifactRef['name'],format:format as LargeArtifactRef['format'],expandedBytes:Number(expanded),maxFiles:Number(maxFiles)},origin,secrets).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('Large artifact upload failed; secret and raw response are withheld.');process.exitCode=1;});
}
