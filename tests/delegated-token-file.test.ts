import assert from 'node:assert/strict';import test from 'node:test';import {mkdtemp,readFile,stat,access,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {withPrivateHfTokenFile} from '../scripts/delegated/token-file.js';
test('encrypted HF token exists only as 0600 uploader file and is removed after callback failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'delegated-token-'));const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
 const binding={taskId:'t',workloadId:'w',revision:1,instanceId:'i-0123456789abcdef0',descriptorHash:'a'.repeat(64),accountId:'123456789012',region:'us-east-2'};
 const expected={binding,nonce:'n'.repeat(43),audience:'central',keyThumbprint:'k'.repeat(43)};const context=JSON.stringify({version:1,...expected,purpose:'hf-token',expiresAt:2000});
 const ciphertext=Buffer.from(await crypto.subtle.encrypt({name:'RSA-OAEP',label:new TextEncoder().encode(context)},keys.publicKey,new TextEncoder().encode('hf_scoped_private'))).toString('base64url');
 const input={directory:dir,privateKey:keys.privateKey,expected,now:()=>1000,envelope:{algorithm:'RSA-OAEP-256' as const,ciphertext,keyThumbprint:expected.keyThumbprint,context,expiresAt:2000}};
 let path='';try{await assert.rejects(withPrivateHfTokenFile(input,async p=>{path=p;assert.equal((await stat(p)).mode&0o777,0o600);assert.equal(await readFile(p,'utf8'),'hf_scoped_private');throw new Error('uploader failure');}),/uploader failure/);await assert.rejects(access(path));
 await assert.rejects(withPrivateHfTokenFile({...input,expected:{...expected,nonce:'x'.repeat(43)}},async()=>assert.fail('wrong nonce must not decrypt')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
