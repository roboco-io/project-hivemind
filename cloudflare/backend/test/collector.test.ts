import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {createSnapshot} from '../src/snapshot.ts';
import {sealAuth} from '../../scripts/phase0/auth-envelope.ts';
import {openCredential} from '../src/crypto.ts';

// Cloudflare classes are unavailable in Node; keep the actual collector and scheduler.
registerHooks({resolve(specifier,context,nextResolve){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return nextResolve(specifier,context);}});
const {SchedulerDO}=await import('../src/cloudflare/worker.ts');
class Bucket {
 objects=new Map<string,string>();
 heads:string[]=[];
 async get(key:string){const value=this.objects.get(key);return value===undefined?null:{json:async()=>JSON.parse(value)};}
 async head(key:string){this.heads.push(key);return this.objects.has(key)?{}:null;}
 async put(key:string,value:string){this.objects.set(key,value);return {};}
}
test('authentication failure remains owned until durable auth writeback and confirmed stop, then requires reauthentication',async()=>{
 const storage=new Map<string,unknown>(),pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(key:string)=>storage.get(key),put:async(key:string,value:unknown)=>{storage.set(key,structuredClone(value));},delete:async(key:string)=>storage.delete(key)},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const result=callback();pending.push(result);return result;}};
 const artifacts=new Bucket(),credentials=new Bucket(),keys=generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();let stopped=false;
 const env={CODEX_SANDBOX_APPROVED:'true',ARTIFACTS:artifacts,CREDENTIALS:credentials,AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTH_RETURN_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),AUTH_RETURN_PUBLIC_KEY:publicKey,RUNNER:{getByName:()=>({stop:async()=>stopped})}};
 const owner=new SchedulerDO(ctx as any,env as any) as any;await Promise.all(pending);
 const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh'}}),snapshot=createSnapshot([]);
 await owner.putSnapshot(snapshot);await owner.registerCredential('primary','codex',auth);
 const job=await owner.submit({provider:'codex',credentialId:'primary',snapshotId:snapshot.digest,instructions:'Fixture',checks:[{id:'test',argv:['node','--test'],timeoutMs:10000}],timeoutMs:60000,idempotencyKey:'fixture'});owner.scheduler.dispatch(Date.now());
 const active=owner.scheduler.get(job.id),receipt={callId:'item_7',nonce:'0123456789abcdef0123456789abcdef',marker:'hivemind-phase0-mcp-v1'},audit={sessionId:'session-root',agentId:'agent-child',toolUseId:'toolu_1',commandHash:'a'.repeat(64),timestamp:'2026-11-10T00:00:00.000Z'};
 await owner.complete(active,{version:1,jobId:job.id,attempt:job.attempt,inputSnapshotId:snapshot.digest,snapshot,provider:'codex',errorCode:'NEEDS_REAUTH',process:{status:'failed',exitCode:1,stdout:'',stderr:'Authentication rejected',durationMs:1,truncated:false},summary:'Authentication rejected',mcpReceipts:[{...receipt,private:'never export'}],sandboxReceipts:[{...audit,command:'never export'}],sourceUnchanged:true,sandboxPolicy:'codex-workspace',boundary:{platform:'linux',checkedAt:new Date().toISOString(),verified:true,noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>[name,'0000000000000000']))},authReturn:{...sealAuth(auth,publicKey),version:1}});
 assert.equal(owner.scheduler.get(job.id).status,'STARTING');assert.equal(owner.scheduler.state.credentials.primary.activeJobId,job.id);assert.equal(owner.scheduler.state.credentials.primary.generation,0);assert.ok(credentials.objects.has('credentials/primary/g1.json'));
 stopped=true;await owner.finish(active,storage.get(`completion:${job.id}`));
 assert.equal(owner.scheduler.get(job.id).status,'NEEDS_REAUTH');assert.equal(owner.scheduler.get(job.id).containerStopped,true);assert.equal(owner.scheduler.state.credentials.primary.generation,1);assert.equal(owner.scheduler.state.credentials.primary.quarantined,true);assert.equal(owner.scheduler.dispatch(Date.now()).length,0);assert.equal(storage.has(`completion:${job.id}`),false);
 const normal=JSON.stringify([...artifacts.objects.values()]);assert.ok(!normal.includes('fixture-access'));assert.ok(!normal.includes('authReturn'));assert.ok(!normal.includes('never export'));const savedResult=JSON.parse(artifacts.objects.get(`results/${job.id}/${job.attempt}.json`)!);assert.deepEqual(savedResult.mcpReceipts,[receipt]);assert.deepEqual(savedResult.sandboxReceipts,[audit]);
});
test('explicit stopped-owner recovery skips a partially saved immutable credential generation',async()=>{
 const storage=new Map<string,unknown>(),pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(key:string)=>storage.get(key),put:async(key:string,value:unknown)=>{storage.set(key,structuredClone(value));},delete:async(key:string)=>storage.delete(key)},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const result=callback();pending.push(result);return result;}};
 const artifacts=new Bucket(),credentials=new Bucket(),keys=generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
 const env={CODEX_SANDBOX_APPROVED:'true',ARTIFACTS:artifacts,CREDENTIALS:credentials,AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTH_RETURN_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),AUTH_RETURN_PUBLIC_KEY:publicKey,RUNNER:{getByName:()=>({stop:async()=>false})}};
 const owner=new SchedulerDO(ctx as any,env as any) as any;await Promise.all(pending);
 const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-before',refresh_token:'fixture-refresh-before'}}),replacement=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-after',refresh_token:'fixture-refresh-after'}}),snapshot=createSnapshot([]);
 await owner.putSnapshot(snapshot);await owner.registerCredential('primary','codex',auth);
 const job=await owner.submit({provider:'codex',credentialId:'primary',snapshotId:snapshot.digest,instructions:'Fixture',checks:[{id:'test',argv:['node','--test'],timeoutMs:10000}],timeoutMs:60000,idempotencyKey:'recovery'});owner.scheduler.dispatch(Date.now());
 await owner.complete(owner.scheduler.get(job.id),{version:1,jobId:job.id,attempt:job.attempt,inputSnapshotId:snapshot.digest,snapshot,provider:'codex',process:{status:'passed',exitCode:0,stdout:'',stderr:'',durationMs:1,truncated:false},summary:'Fixture',sourceUnchanged:true,sandboxPolicy:'codex-workspace',boundary:{platform:'linux',checkedAt:new Date().toISOString(),verified:true,noNewPrivs:1,capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>[name,'0000000000000000']))},authReturn:{...sealAuth(auth,publicKey),version:1}});
 owner.scheduler.quarantine(job.id,job.attempt,'AUTH_WRITEBACK_UNCONFIRMED',Date.now(),false);
 const saved=[...credentials.objects],heads=credentials.heads.length;
 await assert.rejects(owner.registerCredential('primary','codex',replacement),/active|stop/i);assert.equal(credentials.heads.length,heads);assert.deepEqual([...credentials.objects],saved);assert.equal(owner.scheduler.state.credentials.primary.activeJobId,job.id);
 owner.scheduler.quarantine(job.id,job.attempt,'AUTH_WRITEBACK_UNCONFIRMED',Date.now(),true);
 await assert.rejects(owner.registerCredential('primary','claude','sk-ant-oat01-fixture'),/provider/i);assert.equal(credentials.heads.length,heads);assert.deepEqual([...credentials.objects],saved);
 const recovered=await owner.registerCredential('primary','codex',replacement);
 assert.equal(recovered.generation,2);assert.equal(recovered.objectKey,'credentials/primary/g2.json');assert.equal(recovered.quarantined,false);assert.equal(recovered.activeJobId,undefined);
 for(const [key,value]of saved)assert.equal(credentials.objects.get(key),value);
 assert.equal(await openCredential(JSON.parse(credentials.objects.get(recovered.objectKey)!), 'primary',2,env.AUTH_STORAGE_KEY),replacement);assert.equal(owner.scheduler.get(job.id).status,'AUTH_SYNC_FAILED');assert.equal(owner.scheduler.get(job.id).containerStopped,true);
});
test('prepare response loss retries the identical runtime input after time advances',async()=>{
 const storage=new Map<string,unknown>(),pending:Promise<unknown>[]=[];
 const ctx={storage:{get:async(key:string)=>storage.get(key),put:async(key:string,value:unknown)=>{storage.set(key,structuredClone(value));},delete:async(key:string)=>storage.delete(key)},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const result=callback();pending.push(result);return result;}};
 const originalNow=Date.now;let clock=originalNow(),prepared:string|undefined,launches=0,prepareAttempts=0;
 Date.now=()=>clock;
 try{
  const artifacts=new Bucket(),credentials=new Bucket(),snapshot=createSnapshot([]),auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture-retry-private',refresh_token:'fixture-refresh-private'}});
  const runner={ensure:async()=>({ready:true,lost:false,prepared:false,launchIssued:false}),prepare:async(input:unknown)=>{prepareAttempts++;const value=JSON.stringify(input);if(prepared===undefined){prepared=value;throw new Error('Prepare succeeded but response was lost');}if(value!==prepared)throw new Error('Bootstrap409: immutable input differs');},launch:async()=>{launches++;},poll:async()=>JSON.stringify({lost:false,state:{prepared:true,started:null,resultReady:false,cancelRequested:false}})};
  const env={CODEX_SANDBOX_APPROVED:'true',ARTIFACTS:artifacts,CREDENTIALS:credentials,AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTH_RETURN_PUBLIC_KEY:'fixture-public-key',RUNNER:{getByName:()=>runner}};
  const owner=new SchedulerDO(ctx as any,env as any) as any;await Promise.all(pending);await owner.putSnapshot(snapshot);await owner.registerCredential('primary','codex',auth);
  const job=await owner.submit({provider:'codex',credentialId:'primary',snapshotId:snapshot.digest,instructions:'Fixture',checks:[{id:'test',argv:['node','--test'],timeoutMs:10000}],timeoutMs:60000,idempotencyKey:'retry'});owner.scheduler.dispatch(clock);const active=owner.scheduler.get(job.id);
  await assert.rejects(owner.advance(active),/response was lost/);assert.equal(launches,0);clock+=2000;
  await owner.advance(active);assert.equal(prepareAttempts,2);assert.equal(launches,1);assert.equal(owner.scheduler.state.credentials.primary.activeJobId,job.id);
  assert.ok(!JSON.stringify([...storage.values()]).includes('fixture-retry-private'));assert.ok([...storage.values()].some(value=>value===60000));
 }finally{Date.now=originalNow;}
});
