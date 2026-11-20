import {isIP} from 'node:net';
export interface AutonomousWebPolicy {allowedHosts:string[]}
export interface AutonomousWebEnv {AUTONOMOUS_WEB_ENABLED?:string;AUTONOMOUS_WEB_ALLOWED_HOSTS?:string}
export interface AutonomousWebTransport {
 resolve(hostname:string):Promise<{addresses:string[];aliases?:string[]}>;
 /** Must connect only to these verified addresses, without a second DNS lookup. */
 fetch(request:Request,route:{hostname:string;addresses:readonly string[]}):Promise<Response>;
}
const reserved=['localhost','local','localdomain','private','corp','internal','lan','home','arpa','invalid','test','onion','nip.io','sslip.io','localtest.me','lvh.me','anthropic.com','claude.ai','claude.com','openai.com','chatgpt.com'];
function invalid():never {throw Object.assign(new Error('Web policy denied'),{statusCode:422});}
export function validateWebHosts(hosts:unknown,control:string):string[]{
 if(!Array.isArray(hosts)||hosts.length<1||hosts.length>32)invalid();
 const controlHost=new URL(control).hostname;
 const blocked=[...reserved,controlHost];
 const result=hosts.map(value=>{
  if(typeof value!=='string'||value.length>253||!/^[a-zA-Z0-9.-]+$/.test(value))invalid();
  const host=value.toLowerCase(),labels=host.split('.');
  if(labels.length<2||labels.some(label=>!label.length||label.length>63||! /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||!/[a-z]/.test(labels.at(-1)!))invalid();
  if(isIP(host)||new URL('https://'+host).hostname!==host||blocked.some(name=>host===name||host.endsWith('.'+name)))invalid();
  return host;
 });
 if(new Set(result).size!==result.length)invalid();return result.sort();
}
export function approveAutonomousWeb(web:unknown,env:AutonomousWebEnv,control:string):AutonomousWebPolicy|undefined{
 if(web===undefined)return undefined;
 if(!web||typeof web!=='object'||Array.isArray(web)||Object.keys(web).some(key=>key!=='allowedHosts')||env.AUTONOMOUS_WEB_ENABLED!=='true'||!env.AUTONOMOUS_WEB_ALLOWED_HOSTS)invalid();
 const upper=validateWebHosts(env.AUTONOMOUS_WEB_ALLOWED_HOSTS.split(',').map(host=>host.trim()),control);
 const hosts=validateWebHosts(Reflect.get(web,'allowedHosts'),control);
 if(hosts.some(host=>!upper.includes(host)))invalid();return {allowedHosts:hosts};
}
function publicAddress(value:string):boolean{
 const family=isIP(value);
 if(family===4){
  const [a,b,c]=value.split('.').map(Number) as [number,number,number,number];
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||(b===0&&(c===0||c===2))))&&!(a===198&&(b===18||b===19||(b===51&&c===100)))&&!(a===203&&b===0&&c===113);
 }
 // Conservative global-unicast subset. Transition, mapped and special ranges stay closed.
 return family===6&&/^[23]/i.test(value)&&! /^(2001:|2002:|3fff:)/i.test(value);
}
export async function dispatchAutonomousWeb(request:Request,policy:AutonomousWebPolicy,control:string,transport?:AutonomousWebTransport):Promise<Response>{
 const denied=()=>new Response('Denied',{status:403});
 try{
  if(!transport||!['GET','HEAD'].includes(request.method))return denied();
  const hosts=validateWebHosts(policy.allowedHosts,control),url=new URL(request.url);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!hosts.includes(url.hostname))return denied();
  const resolved=await transport.resolve(url.hostname);
  if(!Array.isArray(resolved.addresses)||resolved.addresses.length<1||resolved.addresses.length>16||resolved.addresses.some(address=>typeof address!=='string'||!publicAddress(address)))return denied();
  if(resolved.aliases!==undefined){
   if(!Array.isArray(resolved.aliases)||resolved.aliases.length>16)return denied();
   if(resolved.aliases.length&&validateWebHosts(resolved.aliases,control).some(alias=>!hosts.includes(alias)))return denied();
  }
  const headers=new Headers();for(const key of ['accept','accept-language']){const value=request.headers.get(key);if(value)headers.set(key,value);}
  const response=await transport.fetch(new Request(url,{method:request.method,headers,redirect:'manual',signal:request.signal}),{hostname:url.hostname,addresses:[...resolved.addresses]});
  if(response.status>=300&&response.status<400){await response.body?.cancel();return denied();}
  return response;
 }catch{return denied();}
}
export interface AutonomousWebGrant extends AutonomousWebPolicy {taskId:string;jobId:string;attempt:string;expiresAt:number}
export function validateAutonomousWebGrant(grant:AutonomousWebGrant,job:{id:string;attempt:string;autonomous?:{taskId:string};deadline?:number},env:AutonomousWebEnv,control:string,now:number):AutonomousWebGrant{
 if(!grant||Object.keys(grant).some(key=>!['taskId','jobId','attempt','expiresAt','allowedHosts'].includes(key))||!job.autonomous||grant.taskId!==job.autonomous.taskId||grant.jobId!==job.id||grant.attempt!==job.attempt||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now||(job.deadline!==undefined&&job.deadline>0&&grant.expiresAt>job.deadline))invalid();
 for(const id of [grant.taskId,grant.jobId,grant.attempt])if(typeof id!=='string'||!id.length||id.length>256||/[\s\p{Cc}]/u.test(id))invalid();
 const policy=approveAutonomousWeb({allowedHosts:grant.allowedHosts},env,control)!;
 return {...grant,allowedHosts:policy.allowedHosts};
}
