import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import manifest from '../runtime-build.json' with {type:'json'};
import {createBootstrap} from '../src/runtime/bootstrap.ts';
registerHooks({resolve(specifier,context,nextResolve){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return nextResolve(specifier,context);}});
const {default:worker,RunnerDO,SchedulerDO}=await import('../src/cloudflare/worker.ts');
test('Worker publishes the runtime revision expected by the bundle',async()=>{
 const response=await worker.fetch(new Request('https://fixture/health'),{} as any),body=await response.json() as any;assert.equal(body.expectedRuntimeRevision,manifest.digest);
});
test('bootstrap publishes the image runtime revision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-revision-')),server=createBootstrap(dir);try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any;const body=await(await fetch(`http://127.0.0.1:${address.port}/health`)).json() as any;assert.equal(body.runtimeRevision,manifest.digest);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('Runner refuses missing or different image revisions before preparing any authentication',async()=>{
 for(const payload of [{ok:true},{ok:true,runtimeRevision:'f'.repeat(64)},{ok:true,runtimeRevision:manifest.digest}]){
  const state=new Map<string,unknown>(),pending:Promise<unknown>[]=[],requests:string[]=[];
  const ctx={exports:{CodexOutbound:{}},storage:{get:async(key:string)=>state.get(key),put:async(key:string,value:unknown)=>{state.set(key,value);}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;},container:{running:true,interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async(request:Request)=>{requests.push(new URL(request.url).pathname);return Response.json(new URL(request.url).pathname==='/health'?payload:{prepared:true});}})}};
  const runner=new RunnerDO(ctx as any,{} as any);await Promise.all(pending);const ready=await runner.ensure({id:'job',attempt:'attempt',kind:'agent',provider:'codex'} as any),matches='runtimeRevision'in payload&&payload.runtimeRevision===manifest.digest;
  assert.equal(ready.ready,matches);if(!matches){await assert.rejects(runner.prepare({jobId:'job',attempt:'attempt',auth:'PRIVATE_FIXTURE'} as any),/revision/i);assert.deepEqual(requests,['/health']);assert.equal((state.get('metadata') as any).runtimeRevision,undefined);}else{assert.equal((state.get('metadata') as any).runtimeRevision,manifest.digest);await runner.prepare({jobId:'job',attempt:'attempt',auth:'PRIVATE_FIXTURE'} as any);assert.deepEqual(requests,['/health','/prepare']);}
 }
});
test('pinned old attempts remain ready across a newer Worker revision',async()=>{
 const old='a'.repeat(64);assert.notEqual(old,manifest.digest);const state=new Map<string,unknown>([['metadata',{jobId:'job',attempt:'attempt',kind:'agent',provider:'codex',prepared:true,launchIssued:true,stopped:false,runtimeRevision:old}]]),pending:Promise<unknown>[]=[];
 const ctx={exports:{CodexOutbound:{}},storage:{get:async(key:string)=>structuredClone(state.get(key)),put:async(key:string,value:unknown)=>{state.set(key,structuredClone(value));}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;},container:{running:true,interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async()=>Response.json({ok:true,runtimeRevision:old})})}};
 const runner=new RunnerDO(ctx as any,{} as any);await Promise.all(pending);assert.equal((await runner.ensure({id:'job',attempt:'attempt',kind:'agent',provider:'codex'} as any)).ready,true);assert.equal((state.get('metadata') as any).runtimeRevision,old);await runner.launch();
});
test('revision pin survives a lost prepare response before the prepared flag is saved',async()=>{
 const state=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let prepares=0;
 const ctx={exports:{CodexOutbound:{}},storage:{get:async(key:string)=>structuredClone(state.get(key)),put:async(key:string,value:unknown)=>{state.set(key,structuredClone(value));}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;},container:{running:true,interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async(request:Request)=>{if(new URL(request.url).pathname==='/health')return Response.json({ok:true,runtimeRevision:manifest.digest});prepares++;assert.equal((state.get('metadata') as any).runtimeRevision,manifest.digest);throw new Error('Response lost after accepting input');}})}};
 const runner=new RunnerDO(ctx as any,{} as any);await Promise.all(pending);await runner.ensure({id:'job',attempt:'attempt',kind:'agent',provider:'codex'} as any);await assert.rejects(runner.prepare({jobId:'job',attempt:'attempt',auth:'PRIVATE_FIXTURE'} as any),/Response lost/);assert.equal(prepares,1);assert.equal((state.get('metadata') as any).prepared,false);assert.equal((state.get('metadata') as any).runtimeRevision,manifest.digest);
 const restored=new RunnerDO(ctx as any,{} as any);await pending.at(-1);assert.equal((await restored.ensure({id:'job',attempt:'attempt',kind:'agent',provider:'codex'} as any)).ready,true);
});
test('failed pin writes cannot enable preparation in memory, on retry or after reconstruction',async()=>{
 const original={jobId:'job',attempt:'attempt',kind:'agent',provider:'codex',prepared:false,launchIssued:false,stopped:false},state=new Map<string,unknown>([['metadata',original]]),pending:Promise<unknown>[]=[];let failPin=true,pinAttempts=0,prepares=0;
 const ctx={exports:{CodexOutbound:{}},storage:{get:async(key:string)=>structuredClone(state.get(key)),put:async(key:string,value:any)=>{if(value.runtimeRevision&&!(state.get('metadata') as any)?.runtimeRevision){pinAttempts++;if(failPin)throw new Error('Pin persistence failed');}state.set(key,structuredClone(value));}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;},container:{running:true,interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async(request:Request)=>{if(new URL(request.url).pathname==='/health')return Response.json({ok:true,runtimeRevision:manifest.digest});prepares++;assert.equal((state.get('metadata') as any).runtimeRevision,manifest.digest);return Response.json({prepared:true});}})}};
 const job={id:'job',attempt:'attempt',kind:'agent',provider:'codex'},input={jobId:'job',attempt:'attempt',auth:'PRIVATE_FIXTURE'};
 const runner=new RunnerDO(ctx as any,{} as any);await pending.at(-1);
 for(let i=0;i<2;i++){await assert.rejects(runner.ensure(job as any),/Pin persistence failed/);await assert.rejects(runner.prepare(input as any),/revision/i);assert.equal((state.get('metadata') as any).runtimeRevision,undefined);}assert.equal(pinAttempts,2);assert.equal(prepares,0);
 const restored=new RunnerDO(ctx as any,{} as any);await pending.at(-1);await assert.rejects(restored.ensure(job as any),/Pin persistence failed/);await assert.rejects(restored.prepare(input as any),/revision/i);assert.equal(pinAttempts,3);assert.equal(prepares,0);
 failPin=false;assert.equal((await runner.ensure(job as any)).ready,true);assert.equal(pinAttempts,4);await runner.prepare(input as any);assert.equal(prepares,1);
});
test('legacy running attempts can poll and clean up without new authentication or CLI replay',async()=>{
 const state=new Map<string,unknown>(),pending:Promise<unknown>[]=[];let prepares=0,launches=0,polls=0,credentialReads=0;
 const ctx={storage:{get:async(key:string)=>state.get(key),put:async(key:string,value:unknown)=>{state.set(key,structuredClone(value));}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;}};
 let active:any;const runner={ensure:async()=>({ready:true,lost:false,prepared:true,launchIssued:true,legacy:true}),prepare:async()=>{prepares++;},launch:async()=>{launches++;},poll:async()=>{polls++;return JSON.stringify({lost:false,state:{prepared:true,started:{jobId:active.id,attempt:active.attempt},resultReady:false}});}};
 const owner=new SchedulerDO(ctx as any,{RUNNER:{getByName:()=>runner},CREDENTIALS:{get:async()=>{credentialReads++;}}} as any) as any;await Promise.all(pending);owner.scheduler.registerCredential({id:'primary',provider:'codex',generation:0,objectKey:'credentials/primary/g0.json',quarantined:false});owner.scheduler.submit({provider:'codex',credentialId:'primary',snapshotId:'a'.repeat(64),instructions:'Fixture',checks:[{id:'test',argv:['node','--test'],timeoutMs:10000}],timeoutMs:60000,idempotencyKey:'legacy'},Date.now());active=owner.scheduler.dispatch(Date.now())[0];await owner.advance(active);assert.equal(owner.scheduler.get(active.id).status,'RUNNING');assert.equal(polls,1);assert.equal(prepares,0);assert.equal(launches,0);assert.equal(credentialReads,0);
});
test('legacy Runner health permits existing work but never permits new preparation',async()=>{
 const metadata={jobId:'job',attempt:'attempt',kind:'agent',provider:'codex',prepared:true,launchIssued:true,stopped:false},pending:Promise<unknown>[]=[];
 const ctx={exports:{CodexOutbound:{}},storage:{get:async()=>metadata,put:async()=>{}},blockConcurrencyWhile:(callback:()=>Promise<unknown>)=>{const value=callback();pending.push(value);return value;},container:{running:true,interceptAllOutboundHttp:async()=>{},interceptOutboundHttps:async()=>{},getTcpPort:()=>({fetch:async()=>Response.json({ok:true})})}};
 const runner=new RunnerDO(ctx as any,{} as any);await Promise.all(pending);const readiness=await runner.ensure({id:'job',attempt:'attempt',kind:'agent',provider:'codex'} as any);assert.equal(readiness.ready,true);assert.equal(readiness.legacy,true);await assert.rejects(runner.prepare({jobId:'job',attempt:'attempt',auth:'PRIVATE_FIXTURE'} as any),/revision/i);
});
