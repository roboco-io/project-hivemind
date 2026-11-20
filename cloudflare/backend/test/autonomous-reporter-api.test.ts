import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAutonomousRoute} from '../src/cloudflare/api.ts';
test('Cloudflare selectors isolate reporter and worker state',()=>{
 for(const suffix of ['native-ready','native-receipt','worker-state']){
 for(const token of ['operator','worker','reporter']){
 const request=new Request('http://local/v1/autonomous-tasks/task/'+suffix,{method:suffix==='worker-state'?'GET':'POST',headers:{authorization:'Bearer '+token}});
 const r=authorizeAutonomousRoute(request,'operator','worker','reporter');
 assert.equal(r?.status??200,token===(suffix==='worker-state'?'worker':'reporter')?200:401);
 if(suffix!=='worker-state')for(const reporter of [undefined,'',' ','operator','worker',' worker','operator ','report\tkey','report\u007fkey'])assert.equal(authorizeAutonomousRoute(request,'operator','worker',reporter)?.status,503);
 }
 }
});
test('reporter receipts persist privately, failed writes roll back, restored state matches',async()=>{
 const {AutonomousService}=await import('../src/autonomous-service.ts');
 const {handleAutonomousApi}=await import('../src/cloudflare/autonomous-api.ts');
 const data=new Map<string,unknown>();let fail=false;
 const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put<T>(key:string,value:T){if(fail)throw new Error('storage secret');data.set(key,structuredClone(value));}};
 let service=new AutonomousService(storage,()=>100);
 const spec={requestId:'reporter',goal:'private goal',provider:'claude',model:'model',endsAt:100000,maxRunMs:1000,maxIterations:3,budgetMicros:100,tools:[],systems:[],credentialIds:['private-credential'],billingPolicy:{model:'subscription',budget:'external_actions'}};
 const task=await service.execute('create',{spec}) as {id:string;revision:number};
 await service.execute('approve',{id:task.id,revision:task.revision,reason:'approved'});
 const {lease}=await service.execute('claim',{id:task.id,workerId:'worker'}) as {lease:unknown};
 await service.execute('nativeStart',{lease,runtimeId:'runtime'});
 const receipt={runId:(lease as {runId:string}).runId,runtimeId:'runtime',sessionId:'session',model:'model',sequence:1,outcome:'wait',wakeAt:2000,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},stopped:true};
 const post=(suffix:string,body:unknown)=>new Request('http://local/v1/autonomous-tasks/'+task.id+'/'+suffix,{method:'POST',headers:{authorization:'Bearer reporter'},body:JSON.stringify(body)});
 const options=()=>({operatorToken:'operator',workerToken:'worker',reporterToken:'reporter',service});
 assert.equal((await handleAutonomousApi(post('native-ready',{lease,runtimeId:'runtime'}),options())).status,200);
 fail=true;
 assert.equal((await handleAutonomousApi(post('native-receipt',{lease,receipt}),options())).status,500);
 fail=false;
 service=new AutonomousService(storage,()=>100);
 assert.equal((await handleAutonomousApi(post('native-ready',{lease,runtimeId:'runtime'}),options())).status,200);
 assert.equal((await handleAutonomousApi(post('native-receipt',{lease,receipt}),options())).status,200);
 service=new AutonomousService(storage,()=>100);
 assert.equal((await handleAutonomousApi(post('native-receipt',{lease,receipt}),options())).status,200);
 const get=(suffix:string,token:string)=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks/'+task.id+suffix,{headers:{authorization:'Bearer '+token}}),options());
 assert.doesNotMatch(await (await get('','operator')).text(),/nativeReceipt|runtime/);
 assert.deepEqual(await (await get('/worker-state','worker')).json(),{taskId:task.id,status:'running',endsAt:100000,iteration:1});
 assert.equal((await handleAutonomousApi(post('native-ready',{lease,runtimeId:'runtime'}),options())).status,409);
});
test('receipt reporting uses recovery headroom beyond soft storage capacity',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts');
 const {AutonomousService,AUTONOMOUS_STATE_MAX_BYTES}=await import('../src/autonomous-service.ts');
 const engine=new AutonomousEngine();
 const spec={requestId:'capacity',goal:'goal',provider:'claude' as const,model:'model',endsAt:100000,maxRunMs:1000,maxIterations:3,budgetMicros:100,tools:[],systems:[],credentialIds:[],billingPolicy:{model:'subscription' as const,budget:'external_actions' as const}};
 const task=engine.create(spec,100,'target');engine.approve(task.id,task.revision,'approved',100);
 const lease=engine.claim(task.id,'worker','token','run',100)!;engine.nativeStart(lease,'runtime',100);
 const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));let state=engine.snapshot();let i=0;
 while(bytes(state)<AUTONOMOUS_STATE_MAX_BYTES-5500){engine.create({...spec,requestId:'pad'+i,goal:'x'.repeat(5000)},100,'pad'+i++);state=engine.snapshot();}
 state.tasks['pad'+(i-1)]!.spec.goal+='x'.repeat(AUTONOMOUS_STATE_MAX_BYTES+1-bytes(state));
 let saved=state;
 const storage={async get<T>(key:string){return key==='autonomous-state'?structuredClone(saved) as T:undefined;},async put<T>(_key:string,value:T){saved=structuredClone(value) as typeof saved;}};
 const service=new AutonomousService(storage,()=>100);
 await assert.rejects(service.execute('create',{spec:{...spec,requestId:'denied'}}),{statusCode:413});
 assert.deepEqual(await service.execute('nativeReady',{lease,runtimeId:'runtime'}),{ready:true});
 assert.deepEqual(await service.execute('recordNativeReceipt',{lease,receipt:{runId:'run',runtimeId:'runtime',sessionId:'session',model:'model',sequence:1,outcome:'continue',usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},stopped:true}}),{recorded:true});
 assert.ok(saved.tasks.target!.nativeReceipt);
});
