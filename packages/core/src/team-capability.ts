import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {TeamActor} from '../../contracts/src/team.js';
export interface TeamCapabilityBinding {workflowId:string;actor:TeamActor;expiresAt:number}
export interface TeamCapabilityOptions {
 signingKey:string;now?:()=>number;
 /** Trusted scheduler check: active attempt, bound member, no cancellation, stop or team block. */
 authorizeCurrent:(binding:TeamCapabilityBinding)=>Promise<boolean>;
}
export interface TeamCapabilityAuthority {
 issue(binding:TeamCapabilityBinding):Promise<string>;
 verify(token:string,workflowId:string):Promise<TeamActor>;
 revoke(token:string):void;
}
/** Private process-local issuer. No HTTP endpoint or serializable key/token record. */
export function createTeamCapabilityAuthority(options:TeamCapabilityOptions):TeamCapabilityAuthority {
 if(typeof options.signingKey!=='string'||Buffer.byteLength(options.signingKey)<32||typeof options.authorizeCurrent!=='function')throw new Error('Team capability unavailable');
 const now=options.now??Date.now;
 const records=new Map<string,TeamCapabilityBinding>();
 let pendingIssues=0;
 const mac=(nonce:string)=>createHmac('sha256',options.signingKey).update(nonce).digest('base64url');
 function deny():never{throw new Error('Team capability denied');}
 const prune=()=>{for(const [key,b] of records)if(b.expiresAt<=now())records.delete(key);};
 return {
  async issue(binding){
   prune();if(records.size+pendingIssues>=4096)deny();
   const b=structuredClone(binding);const a=b.actor;
   if(!b.workflowId||!a||![a.teamId,a.memberId,a.jobId].every(x=>typeof x==='string'&&x.length>0&&x.length<=128)||typeof a.attempt!=='string'||!a.attempt||a.attempt.length>128||!Number.isSafeInteger(b.expiresAt)||b.expiresAt<=now())deny();
   pendingIssues++;
   try{
    let allowed=false;try{allowed=await options.authorizeCurrent(structuredClone(b));}catch{deny();}
    prune();if(!allowed||b.expiresAt<=now()||records.size>=4096)deny();
    const nonce=randomBytes(32).toString('base64url');const token=nonce+'.'+mac(nonce);records.set(token,b);return token;
   }finally{pendingIssues--;}
  },
  async verify(token,workflowId){
   prune();if(typeof token!=='string'||!/^[-\w]{43}\.[-\w]{43}$/.test(token))deny();
   const [nonce,signature]=token.split('.');const expected=mac(nonce!);
   if(!timingSafeEqual(Buffer.from(signature!),Buffer.from(expected)))deny();
   const b=records.get(token);if(!b||b.workflowId!==workflowId||b.expiresAt<=now())deny();
   let allowed=false;try{allowed=await options.authorizeCurrent(structuredClone(b));}catch{deny();}
   if(!allowed||records.get(token)!==b||b.expiresAt<=now())deny();return structuredClone(b.actor);
  },
  revoke(token){records.delete(token);},
 };
}
