import { Buffer } from 'node:buffer';
import type { Provider, SealedAuth } from './contracts.ts';
export interface StoredCredential {version:1;id:string;generation:number;iv:string;ciphertext:string}
const bytes=(value:string)=>new Uint8Array(Buffer.from(value,'base64'));
const b64=(value:ArrayBuffer|Uint8Array)=>Buffer.from(value instanceof Uint8Array?value:new Uint8Array(value)).toString('base64');
const utf8=new TextEncoder();
export function validateAuth(provider:Provider,auth:unknown):string {
 if(typeof auth!=='string'||!auth.trim()||auth.length>64000)throw new Error('Invalid subscription authentication');
 if(provider==='claude'){if(!/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(auth))throw new Error('Invalid Claude subscription token');return auth;}
 let value:unknown;try{value=JSON.parse(auth);}catch{throw new Error('Invalid subscription authentication');}
 const x=value as Record<string,unknown>;const t=x?.tokens as Record<string,unknown>;
 if(x?.auth_mode!=='chatgpt'||x.OPENAI_API_KEY||!t||typeof t.access_token!=='string'||!t.access_token||typeof t.refresh_token!=='string'||!t.refresh_token)throw new Error('Only ChatGPT subscription authentication is supported');
 return auth;
}
async function key(raw:string){const value=bytes(raw);if(value.length!==32)throw new Error('Credential storage key is not configured');return crypto.subtle.importKey('raw',value,'AES-GCM',false,['encrypt','decrypt']);}
const aad=(id:string,generation:number)=>utf8.encode(`hivemind-credential-v1:${id}:${generation}`);
export async function sealCredential(auth:string,id:string,generation:number,raw:string):Promise<StoredCredential>{
 const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,generation)},await key(raw),utf8.encode(auth));
 return {version:1,id,generation,iv:b64(iv),ciphertext:b64(ciphertext)};
}
export async function openCredential(value:StoredCredential,id:string,generation:number,raw:string):Promise<string>{
 if(value.version!==1||value.id!==id||value.generation!==generation)throw new Error('Credential generation mismatch');
 const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(value.iv),additionalData:aad(id,generation)},await key(raw),bytes(value.ciphertext));return new TextDecoder().decode(plain);
}
export async function openAuthReturn(value:SealedAuth,pem:string):Promise<string>{
 if(!value||value.version!==1||typeof value.ciphertext!=='string'||value.ciphertext.length>100000)throw new Error('Missing encrypted authentication return');
 const der=bytes(pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,''));
 const privateKey=await crypto.subtle.importKey('pkcs8',der,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
 const raw=await crypto.subtle.decrypt('RSA-OAEP',privateKey,bytes(value.wrappedKey));
 const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
 const payload=Buffer.concat([Buffer.from(value.ciphertext,'base64'),Buffer.from(value.tag,'base64')]);
 const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(value.iv),additionalData:utf8.encode('hivemind-phase0-auth-return-v1')},aes,payload);
 return new TextDecoder().decode(plain);
}
