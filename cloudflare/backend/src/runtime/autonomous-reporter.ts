import type {AutonomousLease,AutonomousNativeReceipt} from '../../../../packages/contracts/src/autonomous.ts';
export interface NativeReporter {
 /** Trusted server capability; off until receipt consumers support quota pauses. */
 quotaPauseEnabled?:boolean;
 ready(lease:AutonomousLease,runtimeId:string,signal:AbortSignal):Promise<void>;
 record(lease:AutonomousLease,receipt:AutonomousNativeReceipt,signal:AbortSignal):Promise<void>;
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(Error('Native report aborted'));
  signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
}
export function createNativeHttpReporter(options:{url:string;token:string;fetchImpl?:typeof fetch;quotaPauseEnabled?:boolean}):NativeReporter{
 let url:URL;try{url=new URL(options.url);}catch{throw Error('Native reporter configuration required');}
 if(!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!options.token||options.token.length>4096||/[\s\p{Cc}]/u.test(options.token))throw Error('Native reporter configuration required');
 const base=url.href.replace(/\/$/,''),fetcher=options.fetchImpl??fetch;
 async function post(lease:AutonomousLease,operation:string,body:unknown,signal:AbortSignal):Promise<void>{
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  try{await abortable(perform(lease,operation,body,bounded),bounded);}catch{throw Error('Native report refused or failed');}
 }
 async function perform(lease:AutonomousLease,operation:string,body:unknown,signal:AbortSignal):Promise<void>{
  try{
   signal.throwIfAborted();if(!/^[A-Za-z0-9_-]{1,128}$/.test(lease.taskId))throw Error();
   const response=await fetcher(`${base}/v1/autonomous-tasks/${encodeURIComponent(lease.taskId)}/${operation}`,{method:'POST',headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal});
   if(signal.aborted){void response.body?.cancel().catch(()=>{});signal.throwIfAborted();}
   if(!response.ok||!response.body){await response.body?.cancel();throw Error();}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
   try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024)throw Error();chunks.push(value);}}finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
   const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),key=operation==='native-ready'?'ready':'recorded';
   if(!result||Object.keys(result).length!==1||result[key]!==true)throw Error();signal.throwIfAborted();
  }catch{throw Error('Native report refused or failed');}
 }
 return {...(options.quotaPauseEnabled===true?{quotaPauseEnabled:true}:{}),ready:(lease,runtimeId,signal)=>post(lease,'native-ready',{lease,runtimeId},signal),record:(lease,receipt,signal)=>post(lease,'native-receipt',{lease,receipt},signal)};
}
export function nativeReporterFromEnvironment():NativeReporter{
 const url=process.env.HIVEMIND_CONTROL_API_URL,token=process.env.HIVEMIND_NATIVE_REPORTER_TOKEN;
 if(!url||!token||[process.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN,process.env.HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN,process.env.HIVEMIND_WORKER_TOKEN,process.env.HIVEMIND_OPERATOR_TOKEN].includes(token))throw Error('Native reporter configuration required');
 return createNativeHttpReporter({url,token});
}
