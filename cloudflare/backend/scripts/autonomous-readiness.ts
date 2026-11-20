import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const TARGET=Object.freeze({origin:'https://hivemind-cloudflare-backend.roboco.workers.dev',accountId:'f7f7c7474ced58ec160ab9a775bf2bfe',worker:'hivemind-cloudflare-backend',workerVersion:'43196043-8ad4-4a3e-96e0-60c074789a52',runtimeRevision:'911c443ed7d99f20e1af8391417474f347d3372a28fc465cbc01cca25464e4c7'});
export async function readPrivateConfig(path:string):Promise<{controlToken:string}>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await file.stat();if(!info.isFile()||info.nlink!==1||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.()||info.size>16384)throw new Error('Invalid private configuration');
  const buffer=Buffer.alloc(16385);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw new Error('Invalid private configuration');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid private configuration');
  const base=['CONTROL_TOKEN','AUTH_STORAGE_KEY','AUTH_RETURN_PUBLIC_KEY','AUTH_RETURN_PRIVATE_KEY'];
  const allowed=new Set([...base,'AUTONOMOUS_WORKER_TOKEN','AUTONOMOUS_REPORTER_TOKEN','AUTONOMOUS_SESSION_KEY']);
  const keys=Object.keys(value);
  const legacy=keys.length===1&&keys[0]==='controlToken';
  if(!legacy&&(keys.some(key=>!allowed.has(key))||base.some(key=>!Object.hasOwn(value,key))||keys.some(key=>typeof value[key]!=='string'||!value[key])))throw new Error('Invalid private configuration');
  const controlToken=legacy?value.controlToken:value.CONTROL_TOKEN;
  if(typeof controlToken!=='string'||!controlToken||/[\s\p{Cc}]/u.test(controlToken)||controlToken.length>4096)throw new Error('Invalid private configuration');
  return {controlToken};
 }catch{throw new Error('Invalid private configuration');}finally{await file.close();}
}
export type FetchReadiness=(url:string,options:RequestInit)=>Promise<Response>;
export interface ReadinessOptions {expectedRuntimeRevision?:string;expectedWorkerVersion?:string}
const revisionPattern=/^[a-f0-9]{64}$/;
const versionPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateReadinessOptions(options:ReadinessOptions):void{
 if(Object.keys(options).some(key=>!['expectedRuntimeRevision','expectedWorkerVersion'].includes(key))||options.expectedRuntimeRevision!==undefined&&!revisionPattern.test(options.expectedRuntimeRevision)||options.expectedWorkerVersion!==undefined&&!versionPattern.test(options.expectedWorkerVersion))throw new Error('Invalid expected revisions');
}
export async function readReadiness(controlToken:string,fetcher:FetchReadiness=fetch,options:ReadinessOptions={}){
 validateReadinessOptions(options);
 const desired={runtimeRevision:options.expectedRuntimeRevision??TARGET.runtimeRevision,workerVersion:options.expectedWorkerVersion??(options.expectedRuntimeRevision===undefined?TARGET.workerVersion:null)};
 const get=async(path:string)=>{
  try{
   const response=await fetcher(TARGET.origin+path,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${controlToken}`},signal:AbortSignal.timeout(10000)});
   if(!response.ok||!response.body)return null;
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
   try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>65536){await reader.cancel();return null;}chunks.push(value);}
   }finally{reader.releaseLock();}
   const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  }catch{return null;}
 };
 const health=await get('/health'),state=await get('/v1/autonomous-readiness');
 const versionMatches=desired.workerVersion===null?null:health?.workerVersion===desired.workerVersion;
 const runtimeMatches=(health?.expectedRuntimeRevision??health?.runtimeRevision)===desired.runtimeRevision;
 const observedWorkerVersion=typeof health?.workerVersion==='string'&&health.workerVersion!==controlToken&&versionPattern.test(health.workerVersion)?health.workerVersion:null;
 return {target:TARGET,baseline:TARGET,desired,observedWorkerVersion,readOnly:true,versionMatches,runtimeMatches,endpointAvailable:state!==null,ready:observedWorkerVersion!==null&&versionMatches!==false&&runtimeMatches&&state?.ready===true};
}
export function parseReadinessArgs(args:string[]):{configPath:string;options:ReadinessOptions}{
 const flags=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!['--config','--expected-runtime','--expected-version'].includes(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Invalid readiness arguments');flags.set(key,value);}
 const configPath=flags.get('--config');if(!configPath)throw new Error('Private configuration required');
 const options:ReadinessOptions={};
 if(flags.has('--expected-runtime'))options.expectedRuntimeRevision=flags.get('--expected-runtime')!;
 if(flags.has('--expected-version'))options.expectedWorkerVersion=flags.get('--expected-version')!;
 validateReadinessOptions(options);return {configPath,options};
}
export async function readinessMain(args=process.argv.slice(2)){
 const {configPath,options}=parseReadinessArgs(args);
 const config=await readPrivateConfig(configPath);return readReadiness(config.controlToken,fetch,options);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)readinessMain().then(v=>{console.log(JSON.stringify(v));if(!v.ready)process.exitCode=1;}).catch(()=>{console.error('Readiness failed');process.exitCode=1;});
