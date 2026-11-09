import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {sealCredential,openCredential,openAuthReturn,validateAuth} from '../src/crypto.ts';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';
test('credentials are authenticated ciphertext bound to id and generation',async()=>{
 const key=randomBytes(32).toString('base64');const a=await sealCredential('fixture-secret','cred',1,key);const b=await sealCredential('fixture-secret','cred',1,key);
 assert.ok(!JSON.stringify(a).includes('fixture-secret'));assert.notEqual(a.iv,b.iv);assert.equal(await openCredential(a,'cred',1,key),'fixture-secret');
 await assert.rejects(openCredential(a,'other',1,key));await assert.rejects(openCredential(a,'cred',2,key));await assert.rejects(openCredential({...a,ciphertext:'AAAA'},'cred',1,key));
});
test('Worker-compatible decrypt recovers only a matching RSA auth envelope',async()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048});const pub=pair.publicKey.export({type:'spki',format:'pem'}).toString();const priv=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 assert.equal(await openAuthReturn(sealAuth('fixture-auth',pub),priv),'fixture-auth');
});
test('subscription imports cannot select API billing',()=>{
 assert.throws(()=>validateAuth('codex',JSON.stringify({auth_mode:'api_key',OPENAI_API_KEY:'fixture-key'})));
 assert.throws(()=>validateAuth('claude','sk-ant-api03-fixture'));
 assert.throws(()=>validateAuth('claude','fixture-token'));
 assert.equal(validateAuth('claude','sk-ant-oat01-fixture'),'sk-ant-oat01-fixture');
});
