import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import manifest from '../runtime-build.json' with {type:'json'};
registerHooks({resolve(s,c,next){if(s==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(s,c);}});
const {default:worker,RunnerDO}=await import('../src/cloudflare/worker.ts');
const path='https://fixture/v1/boundary-diagnostics';
function fixture(report:unknown={passed:true,namespaceGuardActive:true,workspaceWrite:true,outsideWriteDenied:true,runtimeReadDenied:true,claudeReadDenied:true,parentProcDenied:true,authEnvironmentAbsent:true,cleanup:true,errorCategory:'none'},revision=manifest.digest){
 const state=new Map<string,any>(),pending:Promise<unknown>[]=[],calls:any[]=[];
 const container={running:false,images:{runtime:'fixed'},start(options:any){calls.push(['start',options]);this.running=true;},async destroy(){calls.push(['destroy']);this.running=false;},async interceptAllOutboundHttp(){},async interceptOutboundHttps(){},getTcpPort(){return {fetch:async(r:Request)=>{calls.push(['http',new URL(r.url).pathname]);return Response.json({ok:true,runtimeRevision:revision});}};},async exec(argv:any,options:any){calls.push(['exec',argv,options]);return {output:async()=>({exitCode:0,stdout:new TextEncoder().encode(JSON.stringify(report)),stderr:new Uint8Array()})};}};
 const ctx={container,exports:{NativeClaudeOutbound:{}},storage:{get:async(k:string)=>state.get(k),put:async(k:string,v:any)=>{state.set(k,v);},setAlarm:async(n:number)=>{state.set('alarm',n);},deleteAlarm:async()=>{state.delete('alarm');}},blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};
 const runner=new RunnerDO(ctx as any,{AUTONOMOUS_CLOUD_ENABLED:'false'} as any);
 return {runner,state,calls,container,ready:()=>Promise.all(pending),reconstruct:()=>new RunnerDO(ctx as any,{AUTONOMOUS_CLOUD_ENABLED:'false'} as any)};
}
test('control route works while cloud execution is disabled and rejects unscoped inputs',async()=>{
 const names:string[]=[];const env={CONTROL_TOKEN:'control',AUTONOMOUS_WORKER_TOKEN:'worker',RUNNER:{getByName(n:string){names.push(n);return {boundaryDiagnostic:async()=>({status:'passed'})};}}};
 for(const token of ['', 'worker'])assert.equal((await worker.fetch(new Request(path,{method:'POST',headers:{authorization:`Bearer ${token}`,'idempotency-key':'request-1'}}),env as any)).status,401);
 assert.equal((await worker.fetch(new Request(path,{method:'POST',headers:{authorization:'Bearer control','idempotency-key':'request-1'}}),env as any)).status,200);
 assert.equal((await worker.fetch(new Request(path,{method:'POST',headers:{authorization:'Bearer control','idempotency-key':'request-1'},body:'{"exec":"anything"}'}),env as any)).status,400);
 assert.equal(names.length,1);
});
test('diagnostic uses real ensure gate once, destroys, and replays without relaunch',async()=>{
 const f=fixture();await f.ready();const [a,b]=await Promise.all([f.runner.boundaryDiagnostic(),f.runner.boundaryDiagnostic()]);assert.equal(a.status,'passed');assert.deepEqual(a,b);assert.deepEqual(await f.runner.boundaryDiagnostic(),a);
 assert.equal(f.calls.filter(x=>x[0]==='exec').length,1);assert.equal(f.container.running,false);assert.deepEqual(f.calls.filter(x=>x[0]==='http'),[['http','/health']]);assert.equal(f.calls.find(x=>x[0]==='exec')[1].at(-1),'/opt/hivemind/backend/src/runtime/autonomous-boundary-probe.ts');
 assert.equal(f.state.get('metadata').prepared,false);assert.equal(f.state.get('metadata').launchIssued,false);
});
test('failed gate or stale image is closed and cleaned without exposing report',async()=>{
 for(const f of [fixture({passed:true,secret:'PRIVATE'}),fixture(undefined,'f'.repeat(64))]){await f.ready();const r=await f.runner.boundaryDiagnostic();assert.equal(r.status,'failed');assert.equal(f.container.running,false);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);}
});
test('ordinary autonomous ensure remains disabled regardless of diagnostic metadata',async()=>{
 const f=fixture();await f.ready();await assert.rejects(f.runner.ensure({id:'x',attempt:'a',autonomous:{},diagnostic:true} as any),/disabled/);
});
test('uncertain persisted attempt never reexecutes and alarm retries failed destruction',async()=>{
 const f=fixture();await f.ready();f.state.set('boundaryDiagnosticStarted',true);f.container.running=true;
 const destroy=f.container.destroy.bind(f.container);f.container.destroy=async()=>{throw Error('private failure');};
 const result=await f.runner.boundaryDiagnostic();assert.equal(result.status,'failed');assert.equal(result.stopped,false);assert.equal(f.calls.filter(x=>x[0]==='exec').length,0);assert.ok(f.state.has('alarm'));
 f.container.destroy=destroy;await f.runner.alarm();assert.equal(f.container.running,false);assert.equal(f.state.has('alarm'),false);
});
test('request identities select distinct runners and same identity selects same runner',async()=>{
 const names:string[]=[];const env={CONTROL_TOKEN:'control',RUNNER:{getByName(n:string){names.push(n);return {boundaryDiagnostic:async()=>({status:'passed'})};}}};
 for(const id of ['request-1','request-2','request-1'])await worker.fetch(new Request(path,{method:'POST',headers:{authorization:'Bearer control','idempotency-key':id}}),env as any);
 assert.equal(names[0],names[2]);assert.notEqual(names[0],names[1]);assert.ok(names[0]!.includes(manifest.digest));
});
test('late health after diagnostic timeout cannot execute or verify a stopped runner',async(t)=>{
 const f=fixture();await f.ready();
 let timeout:(()=>void)|undefined,releaseHealth:((response:Response)=>void)|undefined;
 const realSetTimeout=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',((callback:()=>void,ms?:number,...args:unknown[])=>{
  if(ms===30000){timeout=callback;return realSetTimeout(()=>{},0);}
  return realSetTimeout(callback,ms,...args);
 }) as typeof setTimeout);
 f.container.getTcpPort=()=>({fetch:async()=>new Promise<Response>(resolve=>{releaseHealth=resolve;})});
 const diagnostic=f.runner.boundaryDiagnostic();
 // Drain promise continuations until ensure is deterministically suspended in health.
 for(let i=0;i<100&&!releaseHealth;i++)await Promise.resolve();
 assert.ok(releaseHealth);assert.ok(timeout);timeout();
 const result=await diagnostic;assert.equal(result.status,'failed');assert.equal(result.stopped,true);assert.ok(f.state.has('alarm'));
 releaseHealth(Response.json({ok:true,runtimeRevision:manifest.digest}));
 for(let i=0;i<100;i++)await Promise.resolve();
 assert.equal(f.calls.filter(x=>x[0]==='exec').length,0,'expired ensure must not issue a late exec');
 assert.equal(f.state.get('metadata').nativeBoundaryVerified,undefined);
 assert.equal(f.container.running,false);
});

test('late exec completion after timeout is fenced and cleanup alarm survives until settlement',async(t)=>{
 const f=fixture();await f.ready();let timeout:(()=>void)|undefined,release:(()=>void)|undefined;
 const realSetTimeout=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',((cb:()=>void,ms?:number,...args:unknown[])=>{if(ms===30000){timeout=cb;return realSetTimeout(()=>{},0);}return realSetTimeout(cb,ms,...args);}) as typeof setTimeout);
 const exec=f.container.exec.bind(f.container);
 f.container.exec=async(argv:any,options:any)=>{await new Promise<void>(resolve=>{release=resolve;});f.container.running=true;return exec(argv,options);};
 const diagnostic=f.runner.boundaryDiagnostic();for(let i=0;i<100&&!release;i++)await Promise.resolve();
 assert.ok(release);assert.ok(timeout);timeout();const result=await diagnostic;assert.equal(result.status,'failed');assert.ok(f.state.has('alarm'));
 await f.runner.alarm();assert.ok(f.state.has('alarm'),'pending exec retains cleanup alarm');
 release();for(let i=0;i<100;i++)await Promise.resolve();
 assert.equal(f.container.running,false);assert.equal(f.state.get('metadata').nativeBoundaryVerified,undefined);
 assert.deepEqual(await f.runner.boundaryDiagnostic(),result);assert.equal(f.state.has('alarm'),false);
});

test('reconstructed alarm destroys an uncertain running diagnostic without replay or trusting metadata',async()=>{
 const f=fixture();await f.ready();f.state.set('boundaryDiagnosticStarted',true);f.state.set('alarm',1);
 f.state.set('boundaryDiagnosticResult',{status:'failed',runtimeRevision:manifest.digest,stopped:false});
 f.state.set('metadata',{jobId:'boundary-diagnostic',attempt:manifest.digest,native:true,nativeBoundaryVerified:manifest.digest,stopped:false,prepared:false,launchIssued:false});
 f.container.running=true;const restored=f.reconstruct();await f.ready();await restored.alarm();
 assert.equal(f.container.running,false);assert.equal(f.state.get('metadata').nativeBoundaryVerified,undefined);assert.equal(f.state.has('alarm'),false);
 assert.equal((await restored.boundaryDiagnostic()).status,'failed');assert.equal(f.calls.filter(x=>x[0]==='exec'||x[0]==='start').length,0);
});
test('Workers runtime gives bodiless POST an empty non-null body: accepted; one byte is rejected',async()=>{
 const names:string[]=[];const env={CONTROL_TOKEN:'control',RUNNER:{getByName(n:string){names.push(n);return {boundaryDiagnostic:async()=>({status:'passed'})};}}};
 const headers={authorization:'Bearer control','idempotency-key':'request-9','content-type':'application/octet-stream'};
 const empty=()=>new ReadableStream<Uint8Array>({start(c){c.close();}});
 const ok=await worker.fetch(new Request(path,{method:'POST',headers,body:empty(),duplex:'half'} as RequestInit),env as any);
 assert.equal(ok.status,200);assert.equal(names.length,1);
 const one=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1]));c.close();}});
 const bad=await worker.fetch(new Request(path,{method:'POST',headers,body:one,duplex:'half'} as RequestInit),env as any);
 assert.equal(bad.status,400);assert.equal(names.length,1);
 const query=await worker.fetch(new Request(path+'?x=1',{method:'POST',headers,body:empty(),duplex:'half'} as RequestInit),env as any);
 assert.equal(query.status,400);
});
