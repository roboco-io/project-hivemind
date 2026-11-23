import {mkdir,lstat,open,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {canonicalDelegatedJson} from '../../packages/core/src/delegated.js';
import type {DelegatedTokenEnvelope,DelegatedInstanceBinding} from '../../packages/adapters/src/delegated-instance-auth.js';
export interface DelegatedTokenFileInput {envelope:DelegatedTokenEnvelope;privateKey:CryptoKey;expected:{binding:DelegatedInstanceBinding;nonce:string;audience:string;keyThumbprint:string};directory?:string;now?:()=>number}
export async function withPrivateHfTokenFile<T>(input:DelegatedTokenFileInput,consume:(path:string)=>Promise<T>):Promise<T>{
 const now=input.now??Date.now,e=input.envelope;const fail=()=>new Error('HF private token unavailable');
 if(e.algorithm!=='RSA-OAEP-256'||e.context.length>4096||e.ciphertext.length>1024||!/^[A-Za-z0-9_-]+$/.test(e.ciphertext)||e.keyThumbprint!==input.expected.keyThumbprint||!Number.isSafeInteger(e.expiresAt)||e.expiresAt<=now()||e.expiresAt>now()+60000)throw fail();
 const context=JSON.parse(e.context);
 if(canonicalDelegatedJson(context)!==canonicalDelegatedJson({version:1,...input.expected,purpose:'hf-token',expiresAt:e.expiresAt}))throw fail();
 let token:Uint8Array;
 try{token=new Uint8Array(await crypto.subtle.decrypt({name:'RSA-OAEP',label:new TextEncoder().encode(e.context)},input.privateKey,Buffer.from(e.ciphertext,'base64url')));}catch{throw fail();}
 let created=false;const directory=input.directory??'/run/hivemind',path=join(directory,'hf-token');let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!/^hf_[A-Za-z0-9_]{5,125}$/.test(new TextDecoder().decode(token)))throw fail();
  await mkdir(directory,{recursive:true,mode:0o700});const dir=await lstat(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||(typeof process.getuid==='function'&&dir.uid!==process.getuid()))throw fail();
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
  try{await file.chmod(0o600);await file.writeFile(token);}finally{await file.close();}
  token.fill(0);if(e.expiresAt<=now())throw fail();
  timer=setTimeout(()=>{void unlink(path).catch(()=>{});},e.expiresAt-now());timer.unref();
  return await consume(path);
 }finally{token.fill(0);clearTimeout(timer);if(created)await unlink(path).catch(()=>{});}
}
