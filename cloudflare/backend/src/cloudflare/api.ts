import type {JobSpec,Provider,Snapshot} from '../contracts.ts';
import {validateJobSpec} from '../scheduler.ts';
import {validateSnapshot} from '../snapshot.ts';
import {validateAuth} from '../crypto.ts';

export const MAX_BODY_BYTES=8*1024*1024;
export class ApiError extends Error {statusCode:number;constructor(statusCode:number){super('Request failed');this.statusCode=statusCode;}}
export interface ApiService {
 putSnapshot(snapshot:Snapshot):Promise<unknown>;
 registerCredential(id:string,provider:Provider,auth:string):Promise<unknown>;
 credentials():Promise<unknown>;
 submit(spec:JobSpec):Promise<unknown>;
 jobs():Promise<unknown>;
 job(id:string):Promise<unknown>;
 cancel(id:string):Promise<unknown>;
 result(id:string):Promise<unknown>;
}
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export function authorize(request:Request,token:string|undefined):Response|null {
 if(!token)return json({error:'Service is not configured'},503);
 const expected=`Bearer ${token}`,actual=request.headers.get('authorization')??'';
 let difference=actual.length^expected.length;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^(actual.charCodeAt(i)||0);
 return difference?json({error:'Unauthorized'},401):null;
}
async function body(request:Request):Promise<unknown>{
 const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY_BYTES))throw new ApiError(413);
 if(!request.body)throw new ApiError(400);
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>MAX_BODY_BYTES){await reader.cancel();throw new ApiError(413);}chunks.push(next.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ApiError(400);}
}
export async function handleApi(request:Request,token:string|undefined,service:ApiService):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path==='/health'&&request.method==='GET')return json({ok:true,service:'hivemind-cloudflare'});
 if(!path.startsWith('/v1/'))return json({error:'Not found'},404);
 const denied=authorize(request,token);if(denied)return denied;
 try{
  let match:RegExpExecArray|null;
  if(request.method==='PUT'&&(match=/^\/v1\/snapshots\/([a-f0-9]{64})$/.exec(path))){let snapshot:Snapshot;try{snapshot=validateSnapshot(await body(request));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400);}if(snapshot.digest!==match[1])throw new ApiError(400);return json(await service.putSnapshot(snapshot),201);}
  if(request.method==='POST'&&(match=/^\/v1\/credentials\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path))){const value=await body(request);if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400);const data=value as Record<string,unknown>;if(Object.keys(data).some(k=>!['provider','auth'].includes(k))||(data.provider!=='codex'&&data.provider!=='claude'))throw new ApiError(400);let auth:string;try{auth=validateAuth(data.provider,data.auth);}catch{throw new ApiError(400);}return json(await service.registerCredential(match[1]!,data.provider,auth),201);}
  if(request.method==='GET'&&path==='/v1/credentials')return json(await service.credentials());
  if(request.method==='POST'&&path==='/v1/jobs'){let spec:JobSpec;try{spec=validateJobSpec(await body(request));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400);}return json(await service.submit(spec),202);}
  if(request.method==='GET'&&path==='/v1/jobs')return json(await service.jobs());
  if((match=/^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(\/cancel|\/result)?$/.exec(path))){if(request.method==='GET'&&!match[2])return json(await service.job(match[1]!));if(request.method==='GET'&&match[2]==='/result')return json(await service.result(match[1]!));if(request.method==='POST'&&match[2]==='/cancel')return json(await service.cancel(match[1]!),202);}
  return json({error:'Not found'},404);
 }catch(error){const status=error instanceof ApiError?error.statusCode:typeof error==='object'&&error!==null&&'statusCode'in error&&[400,404,409,413,422,503].includes(Number(error.statusCode))?Number(error.statusCode):500;return json({error:status===500?'Service is unavailable':status===413?'Request body is too large':'Request could not be accepted'},status);}
}
