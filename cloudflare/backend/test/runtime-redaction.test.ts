import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const token='FAKE-ONLY-ACCESS-SECRET-0123456789abcdef',refreshed='REFRESHED-FAKE-SECRET-0123456789abcdef';
const authentication=(access=token)=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:access,refresh_token:'FAKE-ONLY-REFRESH-SECRET-0123456789abcdef'}});
async function fixture(script:string){
 const dir=await mkdtemp(join(tmpdir(),'hive-redaction-'));try{
  const cli=join(dir,'fake.cjs');await writeFile(cli,`#!${process.execPath}\n${script}`,{mode:0o755});
  return await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'codex',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:5000,auth:authentication(),authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli}});
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('refreshed authentication is redacted before the summary display boundary cuts it',async()=>{
 const result=await fixture(`require('fs').writeFileSync(require('path').join(process.env.HOME,'.codex','auth.json'),${JSON.stringify(authentication(refreshed))});console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(11990)+${JSON.stringify(refreshed)}}}));console.log(JSON.stringify({type:'turn.completed'}));`);
 assert.equal(result.process.status,'passed');assert.ok(!JSON.stringify(result).includes(refreshed.slice(0,10)));assert.ok(result.summary.includes('[REDACTED]'));assert.ok(result.summary.length<=12000);
});
test('authentication is redacted before the stderr display boundary cuts it',async()=>{
 const result=await fixture(`process.stderr.write('x'.repeat(15990)+${JSON.stringify(token)});console.log(JSON.stringify({type:'turn.completed'}));`);
 assert.equal(result.process.status,'passed');assert.ok(!JSON.stringify(result).includes(token.slice(0,10)));assert.ok(result.process.stderr.includes('[REDACTED]'));assert.ok(result.process.stderr.length<=16000);
});
test('truncated native capture withholds token fragments and all raw agent output',async()=>{
 const result=await fixture(`process.stdout.write('x'.repeat(1024*1024-10));setTimeout(()=>process.stderr.write(${JSON.stringify(token)}),50);`);
 assert.equal(result.process.truncated,true);assert.equal(result.process.status,'error');assert.ok(!JSON.stringify(result).includes(token.slice(0,10)));assert.equal(result.process.stdout,'');assert.match(result.process.stderr,/capture limit/i);assert.match(result.summary,/capture limit/i);
});
