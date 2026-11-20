import {isDeepStrictEqual} from 'node:util';
import {validateAutonomousCapabilities} from '../runtime-shared/autonomous.ts';
import type {NativeClaudeRequest} from '../../../../packages/contracts/src/autonomous-native.ts';
import type {AutonomousSpec,AutonomousCheckpoint,AutonomousLease} from '../../../../packages/contracts/src/autonomous.ts';
export interface NativeAuthorization {taskId:string;spec:AutonomousSpec;checkpoint?:AutonomousCheckpoint;deadline:number}
export interface NativeAuthorizer {
 start(request:NativeClaudeRequest,runtimeId:string,signal:AbortSignal):Promise<NativeAuthorization>;
 heartbeat(lease:AutonomousLease,signal:AbortSignal):Promise<AutonomousLease>;
}
export function nativeExecutionLease(request:NativeClaudeRequest):AutonomousLease{
 const lease=(request as NativeClaudeRequest&{executionLease:AutonomousLease}).executionLease;
 if(!lease||Object.keys(lease).sort().join(',')!=='expiresAt,runId,taskId,token,workerId'||lease.taskId!==request.taskId||!['taskId','runId','workerId','token'].every(k=>typeof lease[k as keyof AutonomousLease]==='string'&&String(lease[k as keyof AutonomousLease]).length>0&&String(lease[k as keyof AutonomousLease]).length<=4096)||!Number.isSafeInteger(lease.expiresAt))throw Error('Native authority unavailable');return {...lease};
}
export function guardCanonicalNativePolicy(request:NativeClaudeRequest,approved:NativeAuthorization):NativeAuthorization{
 const s=approved?.spec,c=approved?.checkpoint;
 if(s)validateAutonomousCapabilities(s);
 if(!isDeepStrictEqual(s?.web,request.web)||!isDeepStrictEqual(s?.externalProfiles,request.externalProfiles))throw Error('Native capability scope does not match approval');
 if(!s||approved.taskId!==request.taskId||s.provider!=='claude'||s.goal!==request.goal||s.model!==request.model||(s.subagentModel??s.model)!==request.subagentModel||s.maxRunMs!==request.maxRunMs||!Array.isArray(s.systems)||!Array.isArray(s.credentialIds)||s.credentialIds.length!==1||typeof s.credentialIds[0]!=='string'||!s.credentialIds[0]||!Array.isArray(s.tools)||s.tools.some(t=>typeof t!=='string')||new Set(s.tools).size!==s.tools.length||JSON.stringify([...s.tools].sort())!==JSON.stringify([...request.tools].sort())||!Number.isSafeInteger(s.endsAt)||s.endsAt<=Date.now()||!Number.isSafeInteger(approved.deadline)||approved.deadline<=Date.now()||approved.deadline>s.endsAt)throw Error('Native policy does not match approval');
 if(c?(c.sessionId!==request.session.sessionId||c.model!==request.session.model||c.sequence!==request.session.sequence):request.session.sequence!==0)throw Error('Native checkpoint does not match approval');
 return approved;
}
export function createNativeHttpAuthorizer(options:{url:string;token:string;fetchImpl?:typeof fetch}):NativeAuthorizer{
 const url=new URL(options.url);if(!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!options.token||options.token.length>4096||/[\r\n\0]/.test(options.token))throw Error('Private control configuration required');
 const base=url.href.replace(/\/$/,''),fetcher=options.fetchImpl??fetch;
 async function post(taskId:string,operation:string,body:unknown,signal:AbortSignal):Promise<unknown>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(taskId))throw Error('Invalid task');
  try{const response=await fetcher(`${base}/v1/autonomous-tasks/${encodeURIComponent(taskId)}/${operation}`,{method:'POST',headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
   if(!response.ok||!response.body)throw Error();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
   try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>65536)throw Error();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch{throw Error('Native control authorization refused');}
 }
 return {
  async start(request,runtimeId,signal){if(!/^[a-f0-9-]{36}$/.test(runtimeId))throw Error('Invalid runtime identity');const approved=await post(request.taskId,'native-start',{lease:nativeExecutionLease(request),runtimeId},signal) as NativeAuthorization;return guardCanonicalNativePolicy(request,approved);},
  async heartbeat(lease,signal){const next=await post(lease.taskId,'heartbeat',{lease},signal) as AutonomousLease;
   if(!next||Object.keys(next).sort().join(',')!=='expiresAt,runId,taskId,token,workerId'||['taskId','runId','workerId','token'].some(k=>next[k as keyof AutonomousLease]!==lease[k as keyof AutonomousLease])||!Number.isSafeInteger(next.expiresAt)||next.expiresAt<=Date.now())throw Error('Native heartbeat refused');return next;
  }
 };
}
export function nativeAuthorizerFromEnvironment():NativeAuthorizer{
 const url=process.env.HIVEMIND_CONTROL_API_URL,token=process.env.HIVEMIND_AUTONOMOUS_WORKER_TOKEN;if(!url||!token)throw Error('Native control configuration required');return createNativeHttpAuthorizer({url,token});
}
