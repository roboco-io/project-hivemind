import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {parseProviderResult} from '../src/runtime/providers.ts';
import {executeRuntime} from '../src/runtime/run.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {ProcessResult,Provider} from '../src/contracts.ts';
const processResult=(event:unknown):ProcessResult=>({status:'failed',exitCode:1,stdout:JSON.stringify(event),stderr:'',durationMs:1,truncated:false});
test('native provider authentication failures require subscription reauthentication',()=>{
 const fixtures:[Provider,unknown][]=[['codex',{type:'error',status:401,message:'Unauthorized'}],['codex',{type:'turn.failed',error:{code:'invalid_grant',message:'Refresh token is no longer valid'}}],['claude',{type:'error',error:{type:'authentication_error',message:'Token rejected'}}],['claude',{type:'assistant',error:'authentication_failed',message:{content:[]}}],['claude',{type:'result',subtype:'error_during_execution',is_error:true,errors:['Invalid API key · Please run /login']}]];
 for(const [provider,event]of fixtures){const parsed=parseProviderResult(provider,processResult(event)) as {success:boolean;errorCode?:string};assert.equal(parsed.success,false);assert.equal(parsed.errorCode,'NEEDS_REAUTH',JSON.stringify(event));}
});
test('generic failures and model text about authentication do not quarantine credentials',()=>{
 for(const [provider,event]of [['codex',{type:'turn.failed',error:{code:'rate_limit_exceeded',message:'Try later'}}],['codex',{type:'error',status:403,message:'Permission denied'}],['claude',{type:'result',subtype:'error_during_execution',is_error:true,errors:['Tests failed: expected status401']}],['claude',{type:'result',subtype:'success',is_error:false,result:'Document authentication_error and /login'}]] as [Provider,unknown][]){assert.equal((parseProviderResult(provider,processResult(event)) as {errorCode?:string}).errorCode,undefined);}
 const stderr={...processResult({type:'error',message:'Network unavailable'}),stdout:'',stderr:'Tests failed while checking login_required field'};assert.equal((parseProviderResult('codex',stderr) as {errorCode?:string}).errorCode,undefined);
});
test('official CLI login-required stderr is recognized only on failed execution',()=>{
 const failed={...processResult(null),stdout:'',stderr:'Error: Not logged in. Please run codex login.'};assert.equal((parseProviderResult('codex',failed) as {errorCode?:string}).errorCode,'NEEDS_REAUTH');assert.equal((parseProviderResult('codex',{...failed,status:'passed',exitCode:0}) as {errorCode?:string}).errorCode,undefined);
});
test('runtime preserves native authentication classification alongside encrypted auth return',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-reauth-'));try{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),cli=join(dir,'fake.cjs');await writeFile(cli,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'turn.failed',error:{code:'invalid_grant',message:'Refresh rejected'}}));process.exitCode=1;`,{mode:0o755});
  const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh'}});
  const value=await executeRuntime({version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'codex',instructions:'Fixture',snapshot:createSnapshot([]),timeoutMs:5000,auth,authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()},{runtimeDir:join(dir,'runtime'),workspace:join(dir,'workspace'),home:join(dir,'home'),commands:{codex:cli}});
  assert.equal((value as {errorCode?:string}).errorCode,'NEEDS_REAUTH');assert.equal(value.process.status,'failed');assert.ok(value.authReturn);assert.ok(!JSON.stringify(value).includes('fixture-access'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
