import type {AutonomousLease} from '../../../packages/contracts/src/autonomous.ts';
import type {DelegatedInstanceBinding,DelegatedInstancePurpose,DelegatedSignedRequest,DelegatedAuthenticatedInstance} from '../../../packages/adapters/src/delegated-instance-auth.ts';
export interface DelegatedSelector {actionId?:string;instanceId?:string;revision?:number}
export interface DelegatedApiService {
 admit(taskId:string,input:{lease:AutonomousLease;runtimeId:string;profileId:string;launchRequestId:string;inputManifest:unknown}):Promise<unknown>;
 challenge(taskId:string,instanceId:string,purpose:DelegatedInstancePurpose,thumbprint?:string):Promise<unknown>;
 authenticate(taskId:string,instanceId:string,purpose:DelegatedInstancePurpose,proof:{challengeId:string;request:DelegatedSignedRequest;publicKeyJwk?:JsonWebKey}):Promise<DelegatedAuthenticatedInstance>;
 bootstrap(identity:DelegatedAuthenticatedInstance):Promise<unknown>;
 token(identity:DelegatedAuthenticatedInstance):Promise<unknown>;
 report(identity:DelegatedAuthenticatedInstance,receipt:unknown):Promise<unknown>;
 operation(taskId:string,selector:DelegatedSelector,operation:'register'|'verify'|'publish'|'recover-publication'|'cleanup',receiptId?:string):Promise<unknown>;
 page(taskId:string,selector:DelegatedSelector,query:{after?:number;limit?:number}):Promise<unknown>;
}
export type DelegatedIdentity=DelegatedInstanceBinding;
export interface DelegatedApiOptions {operatorToken:string;workerToken:string;service:DelegatedApiService}
export function isDelegatedPath(path:string):boolean{return /^\/v1\/autonomous-tasks\/[^/]+\/delegated(?:\/|$)/.test(path);}
function fail(statusCode=400):never{throw Object.assign(Error('Delegated request unavailable'),{statusCode});}
function object(v:unknown,required:string[],optional:string[]=[]):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))fail();return v as Record<string,any>;}
function id(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))fail();}
async function readBody(request:Request){
 const reader=request.body?.getReader();if(!reader)fail();const chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)fail(413);chunks.push(value);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail();}})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(),{statusCode:408})),5000);})]);}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
const equal=(a:string,b:string)=>{let d=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)d|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return d===0;};
export async function handleDelegatedApi(request:Request,options?:DelegatedApiOptions):Promise<Response>{
 const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
 try{
  const url=new URL(request.url),match=/^\/v1\/autonomous-tasks\/([^/]+)\/delegated(?:\/(.*))?$/.exec(url.pathname);if(!match)return json({error:'Not found'},404);
  if(!options?.operatorToken||!options.workerToken||options.operatorToken===options.workerToken)return json({error:'Delegated unavailable'},503);
  const service=options.service,taskId=decodeURIComponent(match[1]!);id(taskId);const path=match[2]??'';
  const instance=/^instances\/(i-[a-f0-9]{17})\/(?:challenge\/(bootstrap|report|hf-token)|(bootstrap|report|hf-token))$/.exec(path);
  if(instance){
   if(url.search)fail();const instanceId=instance[1]!,purpose=(instance[2]??instance[3]) as DelegatedInstancePurpose;
   if(instance[2]&&request.method==='GET')return json(await service.challenge(taskId,instanceId,purpose,request.headers.get('x-hivemind-key-thumbprint')??undefined));
   if(instance[3]&&request.method==='POST'){
    // Authentication proof is carried in a bounded header, before receipt/body decoding.
    const raw=request.headers.get('x-hivemind-instance-proof');if(!raw||raw.length>49152||!/^[A-Za-z0-9_-]+$/.test(raw))fail(401);
    let proof:ReturnType<typeof object>;try{proof=object(JSON.parse(Buffer.from(raw,'base64url').toString('utf8')),['challengeId','request'],['publicKeyJwk']);}catch{fail(401);}
    let identity:DelegatedAuthenticatedInstance;try{identity=await service.authenticate(taskId,instanceId,purpose,proof as any);}catch{fail(401);}
    if(purpose==='report')return json(await service.report(identity,await readBody(request)));
    if(request.body){const data=await readBody(request);object(data,[]);}
    return json(await (purpose==='bootstrap'?service.bootstrap(identity):service.token(identity)));
   }
   return json({error:'Not found'},404);
  }
  const worker=path==='admit',expected=worker?options.workerToken:options.operatorToken;
  if(!equal(request.headers.get('authorization')??'','Bearer '+expected))fail(401);
  if(worker&&request.method==='POST'){
   if(url.search)fail();const b=object(await readBody(request),['lease','runtimeId','profileId','launchRequestId','inputManifest']);id(b.profileId);id(b.runtimeId);id(b.launchRequestId);return json(await service.admit(taskId,b as any));
  }
  const selector:DelegatedSelector={};const page:{after?:number;limit?:number}={};
  for(const key of url.searchParams.keys())if(!['actionId','instanceId','revision',...(path===''?['after','limit']:[])].includes(key)||url.searchParams.getAll(key).length!==1)fail();
  for(const key of ['actionId','instanceId'] as const)if(url.searchParams.has(key)){const value=url.searchParams.get(key)!;id(value);selector[key]=value;}
  for(const key of ['revision','after','limit'] as const)if(url.searchParams.has(key)){const value=url.searchParams.get(key)!;if(!/^(0|[1-9][0-9]{0,8})$/.test(value)||key==='limit'&&(Number(value)<1||Number(value)>100)||key==='revision'&&Number(value)<1)fail();if(key==='revision')selector.revision=Number(value);else page[key]=Number(value);}
  if(path===''&&request.method==='GET')return json(await service.page(taskId,selector,page));
  if(['register','verify','publish','recover-publication','cleanup'].includes(path)&&request.method==='POST'){
   const body=object(await readBody(request),['register','recover-publication'].includes(path)?[]:['receiptId']);if(body.receiptId!==undefined)id(body.receiptId);
   return json(await service.operation(taskId,selector,path as Parameters<DelegatedApiService['operation']>[2],body.receiptId));
  }
  return json({error:'Not found'},404);
 }catch(error){const code=(error as {statusCode?:number})?.statusCode;return json({error:'Delegated request unavailable'},code&&[400,401,403,404,408,409,413,422,503].includes(code)?code:503);}
}
