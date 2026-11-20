import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/control-plane/src/app.js';
import type {AutonomousExternalService} from '../apps/control-plane/src/autonomous-external-api.js';
const projectRoot=new URL(import.meta.url.includes('/dist/tests/')?'../../':'../',import.meta.url);
const modulePath='../apps/control-plane/src/autonomous-cloud-proxy.js';
const auth={authorization:'Bearer operator'};
const prefix='/api/cloudflare/autonomous-tasks';
const spec={requestId:'r',goal:'goal',provider:'mock',model:'mock',endsAt:100000,budgetMicros:100,tools:['fetch'],systems:['test'],credentialIds:[],maxRunMs:1000,maxIterations:4};
function sidecar(overrides:Partial<AutonomousExternalService>={}):AutonomousExternalService{const service={async publishArtifact(){return {artifactDigest:"a".repeat(64)};},async assertApproval(_id:string,_revision:number,_hashes:Record<string,string>){},async profiles(_id:string){return [];},async execute(){return {revision:1,requestId:'r',phase:'intent' as const};},async approve(id:string){return {taskId:id,revision:1,profileId:'p'};},async list(){return [];},async reconcile(){return {revision:1,requestId:'r',phase:'intent' as const};},async cleanup(){return {revision:1,requestId:'r',phase:'cleaned' as const};},async attestBilling(){return {revision:1,requestId:'r',phase:'settled' as const};},async beforeCoreMutation(){},async recover(){},...overrides};return service;}
test('missing remote proxy returns 503 after operator authentication before JSON parsing',async()=>{
 const app=buildApp({operatorToken:'operator',workerToken:'worker'});try{
  const unauthorized=await app.inject({method:'POST',url:prefix,headers:{authorization:'Bearer worker','content-type':'application/json'},payload:'{'});assert.equal(unauthorized.statusCode,401);
  const missing=await app.inject({method:'GET',url:prefix,headers:auth});assert.equal(missing.statusCode,503);
 }finally{await app.close();}
});
test('proxy fixed target replaces auth and forwards one draft with strict pages',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const calls:{url:string;init:RequestInit}[]=[];
 const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example/',controlToken:'remote-secret'},{fetch:async(url:string,init:RequestInit)=>{calls.push({url:String(url),init});return Response.json({id:'remote-task',status:'awaiting_approval',spec},{status:201});}});
 const response=await port.forward(new Request('http://local'+prefix,{method:'POST',headers:auth,body:JSON.stringify(spec)}));assert.equal(response.status,201);assert.equal(calls.length,1);assert.equal(calls[0]?.url,'https://fixed.example/v1/autonomous-tasks');assert.equal(new Headers(calls[0]?.init.headers).get('authorization'),'Bearer remote-secret');assert.deepEqual(JSON.parse(String(calls[0]?.init.body)),spec);assert.equal(calls[0]?.init.redirect,'error');
 await port.forward(new Request('http://local'+prefix+'?limit=20&cursor=opaque.cursor'));assert.equal(calls[1]?.url,'https://fixed.example/v1/autonomous-tasks?limit=20&cursor=opaque.cursor');
 for(const path of ['/task/claim','/task/native-start','/task/finish','/task/external-action','?limit=0','?limit=20&limit=10','?url=https://bad.invalid']){const r=await port.forward(new Request('http://local'+prefix+path));assert.ok([400,404].includes(r.status));}assert.equal(calls.length,2);
});
test('injected port still cannot expose worker paths or bypass method/query validation',async()=>{
 let calls=0;const app=buildApp({operatorToken:'operator',workerToken:'worker',autonomousCloudProxy:{async forward(){calls++;return Response.json({id:'t',status:'ready'});}}});try{
  for(const [method,path] of [['POST','/task/claim'],['POST','/task/native-ready'],['POST','/task/external-action'],['PUT',''],['GET','?limit=0'],['GET','?limit=1&limit=2']] as const){const r=await app.inject({method,url:prefix+path,headers:auth,...(method==='GET'?{}:{payload:{}})});assert.ok([400,404].includes(r.statusCode),path+':'+r.statusCode);}assert.equal(calls,0);
 }finally{await app.close();}
});
test('remote task/page projection removes nested authority and known tokens without remote headers',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const privateTask={id:'t',status:'running',spec:{...spec,goal:'remote-secret operator worker',execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'c',argv:['node','remote-secret'],timeoutMs:1000}],authReturn:'hidden'}},lease:{expiresAt:30000,token:'lease-secret',runId:'private-run'},checkpoint:{sessionId:'s',objectKey:'private'},nativeRuntimeId:'runtime',nativeReceipt:{sessionId:'s'},session:{token:'secret'},ownershipToken:'owned',idempotencyKey:'idem',runs:[{runId:'run',message:'Bearer unknown-token',checkpoint:{sessionId:'s'},authReturn:'secret',usage:{inputTokens:2}}],unknown:{token:'remote-secret'}};
 const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{localTokens:['operator','worker'],fetch:async()=>Response.json({items:[privateTask],nextCursor:'cursor'},{headers:{'set-cookie':'secret','x-secret':'remote-secret'}})});const response=await port.forward(new Request('http://local'+prefix+'?limit=20'));const body=await response.json() as any;
 assert.equal(body.items[0].lease.expiresAt,30000);assert.deepEqual(Object.keys(body.items[0].lease),['expiresAt']);assert.equal(body.items[0].spec.execution.mode,'long_running');assert.equal(body.items[0].runs[0].usage.inputTokens,2);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-secret'),null);
 const raw=JSON.stringify(body);assert.doesNotMatch(raw,/remote-secret|operator|worker|lease-secret|session|checkpoint|authReturn|ownership|idempotency|nativeRuntime|nativeReceipt|unknown-token/);
});
test('app independently strips local authority from an injected port response',async()=>{
 const app=buildApp({operatorToken:'operator',workerToken:'worker',nativeReporterToken:'reporter',autonomousCloudProxy:{async forward(){return Response.json({id:'t',spec:{...spec,goal:'operator worker reporter'},checkpoint:{sessionId:'s'},ownershipToken:'owned',lease:{expiresAt:50,token:'worker'}});}}});try{const r=await app.inject({url:prefix+'/t',headers:auth});assert.equal(r.statusCode,200);assert.doesNotMatch(r.body,/operator|worker|reporter|checkpoint|session|ownershipToken|"token"/);}finally{await app.close();}
});
test('fixed C3 operator subroutes pass while worker external-action never does',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const calls:string[]=[];const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async(url:URL,init:RequestInit)=>{calls.push(url.pathname);return Response.json(init.method==='GET'?[]:{taskId:'task',revision:1,profileId:'p',ownershipToken:'no',idempotencyKey:'no'});}});
 for(const path of ['/task/external-approval','/task/external-cancel','/task/external-actions/request/reconcile','/task/external-actions/request/cleanup'])assert.equal((await port.forward(new Request('http://local'+prefix+path,{method:'POST',body:'{}'}))).status,200);
 assert.equal((await port.forward(new Request('http://local'+prefix+'/task/external-actions'))).status,200);assert.equal(calls.length,5);
});
test('local external-action authenticates worker before JSON parse and missing service returns 503',async()=>{
 const app=buildApp({operatorToken:'operator',workerToken:'worker'});try{
  const denied=await app.inject({method:'POST',url:'/v1/autonomous-tasks/t/external-action',headers:{...auth,'content-type':'application/json'},payload:'{'});assert.equal(denied.statusCode,401);
  const missing=await app.inject({url:'/v1/autonomous-tasks/t/external-actions',headers:auth});assert.equal(missing.statusCode,503);
 }finally{await app.close();}
});
test('local external routes dispatch before common handler with no automatic approval',async()=>{
 const events:string[]=[];const app=buildApp({operatorToken:'operator',workerToken:'worker',localExternalService:sidecar({async list(){events.push('list');return [{revision:1,requestId:'r',phase:'intent'}];},async approve(id){events.push('approve');return {taskId:id,revision:1,profileId:'p'};}})});try{
  assert.equal((await app.inject({url:'/v1/autonomous-tasks/t/external-actions',headers:auth})).statusCode,200);assert.deepEqual(events,['list']);
  assert.equal((await app.inject({method:'POST',url:'/v1/autonomous-tasks/t/external-approval',headers:auth,payload:{externalProfileHashes:{p:'a'.repeat(64)}}})).statusCode,200);assert.deepEqual(events,['list','approve']);
 }finally{await app.close();}
});
test('sidecar barrier runs before SQLite cancellation and failure prevents core mutation',async()=>{
 let id='',app:ReturnType<typeof buildApp>,fail=true;const events:string[]=[];
 app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000,localExternalService:sidecar({async beforeCoreMutation(taskId,operation){assert.equal(taskId,id);events.push(operation);const t=await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth});assert.equal(t.json().status,'awaiting_approval');if(fail)throw Error('private-credential');}})});
 try{
  const created=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:spec});assert.equal(created.statusCode,201);id=created.json().id;
  const denied=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/cancel`,headers:auth,payload:{reason:'stop'}});assert.equal(denied.statusCode,503);assert.ok(!denied.body.includes('private-credential'));
  assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().status,'awaiting_approval');fail=false;
  const cancelled=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/cancel`,headers:auth,payload:{reason:'stop'}});assert.equal(cancelled.json().status,'cancelled');assert.deepEqual(events,['cancel','cancel']);
 }finally{await app.close();}
});
test('C3 action pages retain bounded public action fields and all approved profile IDs',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async(url:URL)=>Response.json(url.pathname.endsWith('external-approval')?{taskId:'t',revision:1,profileId:'aws',profileIds:['aws','hf','gh']}:{items:[{requestId:'r',phase:'broker',actionId:'a',operation:'aws.spot.start',status:'ambiguous',ownershipToken:'private',idempotencyKey:'private'}],nextCursor:'opaque.cursor'})});
 const page=await port.forward(new Request('http://local'+prefix+'/t/external-actions?limit=20&cursor=opaque.cursor'));assert.equal(page.status,200);const json=await page.json() as any;assert.equal(json.items[0].requestId,'r');assert.equal(json.items[0].phase,'broker');assert.equal(json.items[0].ownershipToken,undefined);
 const approved=await port.forward(new Request('http://local'+prefix+'/t/external-approval',{method:'POST',body:'{}'}));assert.deepEqual((await approved.json() as any).profileIds,['aws','hf','gh']);
});
test('request and response limits fail closed without revealing remote error details',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let calls=0;const config={baseUrl:'https://fixed.example',controlToken:'remote-secret'};
 const port=createAutonomousCloudProxy(config,{fetch:async()=>{calls++;return Response.json({id:'t'});}});const tooLarge=await port.forward(new Request('http://local'+prefix,{method:'POST',body:JSON.stringify({goal:'x'.repeat(65536)})}));assert.equal(tooLarge.status,413);assert.equal(calls,0);
 for(const response of [()=>new Response('x'.repeat(2*1024*1024+1)),()=>new Response('remote-secret',{status:302,headers:{location:'https://attacker.invalid'}}),()=>new Response('remote-secret operator',{status:500}),()=>new Response('{broken remote-secret')]){
  const p=createAutonomousCloudProxy(config,{fetch:async()=>response()});const r=await p.forward(new Request('http://local'+prefix));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('remote-secret'));
 }
});
test('Fastify request bound applies after authentication and never invokes proxy for oversized JSON',async()=>{
 let calls=0;const app=buildApp({operatorToken:'operator',workerToken:'worker',autonomousCloudProxy:{async forward(){calls++;return Response.json({id:'t'});}}});try{
  for(const token of ['wrong','operator']){const r=await app.inject({method:'POST',url:prefix,headers:{authorization:'Bearer '+token,'content-type':'application/json'},payload:JSON.stringify({goal:'x'.repeat(65536)})});assert.equal(r.statusCode,token==='wrong'?401:413);}assert.equal(calls,0);
 }finally{await app.close();}
});
test('proxy HTTP deadline also covers a fetch that ignores AbortSignal',{timeout:7000},async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>new Promise<Response>(()=>{})});const r=await port.forward(new Request('http://local'+prefix));assert.equal(r.status,503);
});
test('missing sidecar blocks external task cancel and revise while ordinary cancellation remains compatible',async()=>{
 const app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000});try{
  const external={...spec,requestId:'external',provider:'claude',tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws']};const created=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:external});assert.equal(created.statusCode,201);const id=created.json().id;
  for(const [suffix,payload] of [['cancel',{reason:'stop'}],['revise',{spec:{...external,goal:'new'},reason:'change'}]] as const){const r=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/${suffix}`,headers:auth,payload});assert.equal(r.statusCode,503);}assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().status,'awaiting_approval');
  const ordinary=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:spec});const r=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${ordinary.json().id}/cancel`,headers:auth,payload:{reason:'stop'}});assert.equal(r.json().status,'cancelled');
 }finally{await app.close();}
});
test('revise barrier receives canonical revision before SQLite mutation and invalid payload never reaches it',async()=>{
 let calls=0,id='';let app:ReturnType<typeof buildApp>;app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000,localExternalService:sidecar({async beforeCoreMutation(taskId,op){calls++;assert.equal(taskId,id);assert.equal(op,'revise');assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().revision,1);}})});try{
  id=(await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:spec})).json().id;
  assert.equal((await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/revise`,headers:auth,payload:{spec:{},reason:'bad'}})).statusCode,400);assert.equal(calls,0);
  const revised=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/revise`,headers:auth,payload:{spec:{...spec,goal:'new'},reason:'change'}});assert.equal(revised.json().revision,2);assert.equal(calls,1);
 }finally{await app.close();}
});
test('private server bookkeeping functions cannot become operator proxy routes',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let calls=0;const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>{calls++;return Response.json({id:'t'});}});
 for(const suffix of ['acceptExternal','settleExternal','cleanedExternal','accept-external','settle-external','cleaned-external','reserve','settle','heartbeat','worker-state']){const r=await port.forward(new Request('http://local'+prefix+'/t/'+suffix,{method:'POST',body:'{}'}));assert.equal(r.status,404);}assert.equal(calls,0);
});
test('approve proxy forwards only revision reason and validated profile hash map; metadata retains hash',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let payload:any,calls=0;const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async(_url:URL,init:RequestInit)=>{calls++;if(init.method==='POST'){payload=JSON.parse(String(init.body));return Response.json({id:'t',status:'ready'});}return Response.json([{id:'aws',provider:'aws',profileHash:'a'.repeat(64),credentialRef:'private-ref',target:{accountId:'123456789012'}}]);}});
 const body={revision:1,reason:'explicit',externalProfileHashes:{aws:'a'.repeat(64)}};assert.equal((await port.forward(new Request('http://local'+prefix+'/t/approve',{method:'POST',body:JSON.stringify(body)}))).status,200);assert.deepEqual(payload,body);
 const profiles=await port.forward(new Request('http://local'+prefix+'/t/external-profiles'));assert.equal((await profiles.json() as any)[0].profileHash,'a'.repeat(64));
 const before=calls;for(const bad of [{...body,url:'https://bad.invalid'},{...body,externalProfileHashes:{aws:'bad'}},{...body,externalProfileHashes:{'../aws':'a'.repeat(64)}}])assert.equal((await port.forward(new Request('http://local'+prefix+'/t/approve',{method:'POST',body:JSON.stringify(bad)}))).status,400);assert.equal(calls,before);
});
test('profile-task canonical approval cannot bypass a missing external service',async()=>{
 const app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000});try{
  const external={...spec,provider:'claude',tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws']};const created=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:external});assert.equal(created.statusCode,201);const id=created.json().id;
  const approved=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/approve`,headers:auth,payload:{revision:1,reason:'explicit'}});assert.equal(approved.statusCode,503);assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().status,'awaiting_approval');
 }finally{await app.close();}
});
test('explicit profile approval asserts hashes before core mutation and approves broker afterwards',async()=>{
 let id='',stale=true;let app:ReturnType<typeof buildApp>;const events:string[]=[];
 app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000,localExternalService:sidecar({async assertApproval(taskId,revision,hashes){events.push('assert');assert.equal(taskId,id);assert.equal(revision,1);assert.deepEqual(hashes,{aws:'a'.repeat(64)});assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().status,'awaiting_approval');if(stale)throw Object.assign(new Error('private hash changed'),{statusCode:409});},async approve(taskId){events.push('broker');assert.equal((await app.inject({url:'/v1/autonomous-tasks/'+id,headers:auth})).json().status,'ready');return {taskId,revision:1,profileId:'aws',profileIds:['aws']};}})});
 try{
  const external={...spec,provider:'claude',tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws']};id=(await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:external})).json().id;
  const payload={revision:1,reason:'explicit',externalProfileHashes:{aws:'a'.repeat(64)}};
  const denied=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/approve`,headers:auth,payload});assert.equal(denied.statusCode,409);assert.doesNotMatch(denied.body,/private hash/);assert.deepEqual(events,['assert']);
  stale=false;const approved=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/approve`,headers:auth,payload});assert.equal(approved.statusCode,200);assert.deepEqual(events,['assert','assert','broker']);
 }finally{await app.close();}
});
test('configured sidecar cannot authorize profile tasks without explicit matching hash map',async()=>{
 let asserts=0;const app=buildApp({operatorToken:'operator',workerToken:'worker',now:()=>1000,localExternalService:sidecar({async assertApproval(){asserts++;}})});try{
  const external={...spec,provider:'claude',tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws']};const id=(await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:auth,payload:external})).json().id;
  for(const hashes of [undefined,{other:'a'.repeat(64)}]){const r=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${id}/approve`,headers:auth,payload:{revision:1,reason:'explicit',...(hashes===undefined?{}:{externalProfileHashes:hashes})}});assert.equal(r.statusCode,409);}assert.equal(asserts,0);
 }finally{await app.close();}
});
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AutonomousTask,AutonomousState} from '../packages/contracts/src/autonomous.js';
function longHistory():AutonomousTask{
 const task:AutonomousTask={id:'history-task',spec:{...spec,requestId:'long-history',provider:'claude',model:'pinned',tools:['Bash'],systems:[],credentialIds:['credential'],billingPolicy:{model:'subscription',budget:'external_actions'},execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:1000}]},endsAt:56*86400000,maxRunMs:120000,maxIterations:65536},revision:1,status:'ready',createdAt:0,approvedAt:1,iteration:3952,runs:[],actions:[],resources:[],interventions:[{kind:'approval',message:'approved',at:1,revision:1}],spentMicros:0,reservedMicros:0};
 task.runs=Array.from({length:3952},(_,n)=>({runId:'run-'+n,workerId:'worker',startedAt:2+n*2,finishedAt:3+n*2,outcome:'continue',usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},costMicros:null,billingEvidence:'subscription_runtime',message:'x'.repeat(600),checkpoint:{sessionId:'private-session',objectKey:'private/runtime/'+n,model:'pinned',sequence:n+1}}));task.checkpoint=task.runs.at(-1)!.checkpoint;return task;
}
test('more than 2MiB long history remains reviewable through bounded summary and all 3952 public runs',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');const {createAutonomousApiService,handleAutonomousApi}=await import('../apps/control-plane/src/autonomous-api.js');const {createAutonomousCloudProxy}=await import(modulePath);
 const dir=mkdtempSync(join(tmpdir(),'autonomous-history-')),path=join(dir,'history.sqlite'),task=longHistory();assert.ok(Buffer.byteLength(JSON.stringify(task))>2*1024*1024);const db=new DatabaseSync(path);db.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');db.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify({version:1,tasks:{[task.id]:task}} satisfies AutonomousState));db.close();const store=createAutonomousStore(path);
 const service=createAutonomousApiService(store,()=>10000),proxy=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async(url:URL,init:RequestInit)=>handleAutonomousApi(new Request(url,init),{operatorToken:'remote-secret',workerToken:'remote-worker',service})});
 try{
  const summary=await proxy.forward(new Request('http://local'+prefix+'/history-task?view=summary'));assert.equal(summary.status,200);const publicTask=await summary.json() as any;assert.equal(publicTask.iteration,3952);assert.equal(publicTask.runs,undefined);assert.equal(publicTask.checkpoint,undefined);assert.ok(Buffer.byteLength(JSON.stringify(publicTask))<32768);
  let cursor:string|undefined;const ids:string[]=[];let firstCursor='';do{const query=new URLSearchParams({kind:'runs',limit:'100',...(cursor?{cursor}:{})});const page=await proxy.forward(new Request('http://local'+prefix+'/history-task/history?'+query));assert.equal(page.status,200);const raw=await page.text();assert.ok(Buffer.byteLength(raw)<2*1024*1024);assert.doesNotMatch(raw,/checkpoint|session|objectKey|private\/runtime/);const result=JSON.parse(raw);assert.equal(result.kind,'runs');ids.push(...result.items.map((r:{runId:string})=>r.runId));cursor=result.nextCursor;if(!firstCursor&&cursor)firstCursor=cursor;}while(cursor);
  assert.equal(ids.length,3952);assert.equal(new Set(ids).size,3952);assert.equal(ids[0],'run-0');assert.equal(ids.at(-1),'run-3951');
  const mixed=await proxy.forward(new Request('http://local'+prefix+'/history-task/history?kind=interventions&cursor='+encodeURIComponent(firstCursor)));assert.ok([400,409].includes(mixed.status));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('history cursors bind task kind revision store and append highwater with a response byte budget',async()=>{
 const {pageAutonomousHistory}=await import('../packages/core/src/autonomous-repository.js');const task=longHistory();task.interventions=Array.from({length:100},(_,at)=>({kind:'message',message:'🙂'.repeat(8000),at,revision:1}));const secret='s'.repeat(64);
 let page=pageAutonomousHistory(task,'interventions',{limit:100},secret);assert.ok(page.items.length<100&&page.items.length>0);assert.ok(Buffer.byteLength(JSON.stringify(page))<2*1024*1024);const cursor=page.nextCursor!;assert.ok(cursor);let count=page.items.length;
 task.interventions.push({kind:'message',message:'appended',at:101,revision:1});while(page.nextCursor){page=pageAutonomousHistory(task,'interventions',{limit:100,cursor:page.nextCursor},secret);count+=page.items.length;}assert.equal(count,100);assert.equal(task.interventions.length,101);
 for(const [target,kind,key] of [[task,'runs',secret],[{...task,id:'other'},'interventions',secret],[task,'interventions','t'.repeat(64)]] as const)assert.throws(()=>pageAutonomousHistory(target,kind,{cursor},key),{statusCode:400});
 assert.throws(()=>pageAutonomousHistory({...task,revision:2},'interventions',{cursor},secret),{statusCode:409});assert.throws(()=>pageAutonomousHistory(task,'interventions',{cursor:cursor+'x'},secret),{statusCode:400});
 for(const query of [{limit:0},{limit:101},{limit:null},{cursor:''},{unknown:1}])assert.throws(()=>pageAutonomousHistory(task,'interventions',query as never,secret),{statusCode:400});
});
test('DO summary and history use the selected task and retain every public record across restart',async()=>{
 const {AutonomousService}=await import(new URL('cloudflare/backend/src/autonomous-service.ts',projectRoot).href);
 class Storage{
  data=new Map<string,unknown>();reads:string[]=[];
  async get<T>(key:string){this.reads.push(key);return structuredClone(this.data.get(key)) as T|undefined;}
  async put(key:string,value:unknown){this.data.set(key,structuredClone(value));}
  async delete(key:string){return this.data.delete(key);}
  async transaction<T>(fn:(tx:Storage)=>Promise<T>):Promise<T>{const before=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=before;throw e;}}
 }
 const storage=new Storage(),task=longHistory();await storage.put('autonomous-state',{version:1,tasks:{[task.id]:task}});let service=new AutonomousService(storage,()=>10000);
 const summary=await service.execute('getSummary',{id:task.id});assert.equal(summary.iteration,3952);assert.equal(summary.runs,undefined);const other=await service.execute('create',{spec:{...spec,requestId:'other'}});
 storage.reads=[];await service.execute('getSummary',{id:task.id});assert.equal(storage.reads.filter(k=>k.startsWith('autonomous:chunk:')).length,0);
 storage.reads=[];await assert.rejects(service.execute('list',{maxBytes:2*1024*1024}),{statusCode:413,code:'AUTONOMOUS_PAGE_REQUIRED'});assert.equal(storage.reads.filter(k=>k.startsWith('autonomous:chunk:')).length,0);
 let cursor:string|undefined,count=0;do{storage.reads=[];const page=await service.execute('historyPage',{id:task.id,kind:'runs',limit:100,...(cursor?{cursor}:{})});count+=page.items.length;assert.ok(!storage.reads.some(k=>k.startsWith('autonomous:chunk:'+other.id+':')));assert.ok(Buffer.byteLength(JSON.stringify(page))<2*1024*1024);assert.doesNotMatch(JSON.stringify(page),/checkpoint|private-session|objectKey/);cursor=page.nextCursor;service=new AutonomousService(storage,()=>10000);}while(cursor);assert.equal(count,3952);
 assert.equal((await service.execute('get',{id:task.id})).runs.length,3952);
});
test('disabled profile metadata retains its hash even when the provider target is unavailable',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>Response.json([{id:'missing',enabled:false,profileHash:'b'.repeat(64)}])});const r=await port.forward(new Request('http://local'+prefix+'/t/external-profiles'));assert.deepEqual(await r.json(),[{id:'missing',enabled:false,profileHash:'b'.repeat(64)}]);
});
for(const backend of ['sqlite','do'] as const)test(`${backend} paid external receipts use 32MiB recovery headroom for accept settle and cleanup`,async()=>{
 const {AutonomousEngine}=await import('../packages/core/src/autonomous.js');const task=longHistory();task.spec.tools=['Bash','mcp__hivemind__action'];task.spec.systems=['aws'];task.spec.externalProfiles=['aws'];delete task.checkpoint;task.iteration=1100;
 task.runs=Array.from({length:1100},(_,n)=>({runId:'run-'+n,workerId:'worker',startedAt:2+n,finishedAt:3+n,outcome:'failed',costMicros:0,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},message:'가'.repeat(9700)}));
 const engine=new AutonomousEngine({version:1,tasks:{[task.id]:task}}),lease=engine.claimCloud(task.id,'worker','private-lease','next',2000)!;const action=engine.reserve(lease,{requestId:'paid',tool:'mcp__hivemind__action',system:'aws',operation:'aws.spot.start',estimatedCostMicros:10},2001),state=engine.snapshot();const bytes=Buffer.byteLength(JSON.stringify(state));assert.ok(bytes>30*1024*1024&&bytes<32*1024*1024);
 let execute:(operation:any,input:Record<string,unknown>)=>Promise<any>,close=()=>{};
 if(backend==='sqlite'){
  const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js'),{createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js');const dir=mkdtempSync(join(tmpdir(),'external-recovery-')),path=join(dir,'state.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE autonomous_state(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');db.prepare('INSERT INTO autonomous_state VALUES(1,?)').run(JSON.stringify(state));db.close();const store=createAutonomousStore(path),service=createAutonomousApiService(store,()=>2002);execute=service.execute.bind(service);close=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
 }else{
  const {AutonomousService}=await import(new URL('cloudflare/backend/src/autonomous-service.ts',projectRoot).href);const data=new Map<string,unknown>([['autonomous-state',state]]);const storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put(key:string,value:unknown){data.set(key,structuredClone(value));},async delete(key:string){return data.delete(key);},async transaction<T>(fn:(tx:unknown)=>Promise<T>):Promise<T>{const before=structuredClone(data);try{return await fn(storage);}catch(e){data.clear();for(const [k,v] of before)data.set(k,v);throw e;}}};const service=new AutonomousService(storage,()=>2002);execute=service.execute.bind(service);close=()=>data.clear();
 }
 try{
  // Migrate with a bounded recovery read before testing private receipt admission.
  await execute('getSummary',{id:task.id});await assert.rejects(execute('message',{id:task.id,message:'normal growth'}),{statusCode:413});
  const accepted=await execute('acceptExternal',{id:task.id,lease,actionId:action.id,resource:{id:'owned-resource',system:'aws',cleanupOperation:'terminate'}});assert.equal(accepted.status,'accepted');
  const cleaned=await execute('cleanedExternal',{id:task.id,resourceId:'owned-resource'});assert.equal(cleaned.resources[0].status,'cleaned');assert.equal(cleaned.runs.length,1100);assert.equal(cleaned.reservedMicros,10);
  const settled=await execute('settleExternal',{id:task.id,actionId:action.id,actualCostMicros:5,success:true});assert.equal(settled.actualCostMicros,5);assert.equal((await execute('getSummary',{id:task.id})).reservedMicros,0);
 }finally{close();}
});
test('external action metadata preserves a bounded resource identifier without ownership authority',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let id='owned-instance';const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>Response.json({requestId:'request',phase:'broker',resourceId:id,ownershipToken:'private',idempotencyKey:'private'})});const r=await port.forward(new Request('http://local'+prefix+'/t/external-actions'));assert.equal((await r.json() as any).resourceId,'owned-instance');id='x'.repeat(241);assert.equal((await port.forward(new Request('http://local'+prefix+'/t/external-actions'))).status,503);
});
test('trusted page-required error code survives proxy projection without forwarding raw remote errors',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath),port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>Response.json({error:'remote-secret',code:'AUTONOMOUS_PAGE_REQUIRED',checkpoint:'private'},{status:413})});const r=await port.forward(new Request('http://local'+prefix+'/t'));assert.equal(r.status,413);const value=await r.json() as any;assert.equal(value.code,'AUTONOMOUS_PAGE_REQUIRED');assert.doesNotMatch(JSON.stringify(value),/remote-secret|checkpoint|private/);
});
test('fixed operator billing route forwards only explicit actual charge and preserves bounded public provenance',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);const calls:{url:string;body:any}[]=[];const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async(url:URL,init:RequestInit)=>{calls.push({url:url.href,body:JSON.parse(String(init.body))});return Response.json({revision:2,requestId:'aws/spot:1',phase:'settled',resourceId:'owned-resource',billingSource:'operator_attested',evidenceRef:'invoice-aws-2026-11',attestedAt:1000,verifiedCostMicros:23,billingFinal:true,ownershipToken:'private',parametersHash:'private'});}});
 const payload={actualCostMicros:23,evidenceRef:'invoice-aws-2026-11',reason:'Actual invoice charge',revision:2},path=prefix+'/t/external-actions/'+encodeURIComponent('aws/spot:1')+'/billing';const response=await port.forward(new Request('http://local'+path,{method:'POST',body:JSON.stringify(payload)}));assert.equal(response.status,200);const result=await response.json() as any;assert.equal(result.revision,2);assert.equal(result.billingSource,'operator_attested');assert.equal(result.evidenceRef,payload.evidenceRef);assert.equal(result.attestedAt,1000);assert.equal(result.verifiedCostMicros,23);assert.equal(result.ownershipToken,undefined);assert.equal(result.parametersHash,undefined);assert.deepEqual(calls[0]?.body,payload);assert.equal(calls[0]?.url,'https://fixed.example/v1/autonomous-tasks/t/external-actions/aws%2Fspot%3A1/billing');
 const before=calls.length;for(const body of [{...payload,actualCostMicros:-1},{...payload,actualCostMicros:1.5},{...payload,actualCostMicros:null},{...payload,evidenceRef:'https://invoice.example/?token=bad'},{...payload,url:'https://bad.invalid'},{evidenceRef:'invoice:1',reason:'Missing explicit amount'}])assert.equal((await port.forward(new Request('http://local'+prefix+'/t/external-actions/r/billing',{method:'POST',body:JSON.stringify(body)}))).status,400);assert.equal(calls.length,before);
});
test('action metadata pins the approved target and profile hash without exposing credentials or private hashes',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let target:unknown={accountId:'111111111111',region:'ap-northeast-2',workloadId:'old-workload'};const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>Response.json({revision:1,requestId:'r',phase:'settled',profileId:'old-profile',approvedTarget:target,approvedProfileHash:'a'.repeat(64),operatorBillingEvidence:{source:'operator_attested',evidenceRef:'invoice-1',reasonHash:'b'.repeat(64),at:1000,reason:'must not echo',token:'private'},credentialRef:'private',parametersHash:'private',ownershipToken:'private'})});
 const r=await port.forward(new Request('http://local'+prefix+'/t/external-actions'));assert.equal(r.status,200);const value=await r.json() as any;assert.equal(value.profileId,'old-profile');assert.deepEqual(value.approvedTarget,target);assert.equal(value.approvedProfileHash,'a'.repeat(64));assert.equal(value.operatorBillingEvidence.reasonHash,'b'.repeat(64));assert.equal(value.operatorBillingEvidence.reason,undefined);assert.equal(value.operatorBillingEvidence.token,undefined);assert.equal(value.credentialRef,undefined);assert.equal(value.parametersHash,undefined);
 target={repository:'old/repo',branch:'fixed-branch'};assert.deepEqual((await (await port.forward(new Request('http://local'+prefix+'/t/external-actions'))).json() as any).approvedTarget,target);
 target={repository:'https://host.invalid/repo',branch:'main',credentialId:'private'};assert.equal((await port.forward(new Request('http://local'+prefix+'/t/external-actions'))).status,503);
});
test('R9 action audit forwards only bounded immutable parameter and provider result identifiers',async()=>{
 const {createAutonomousCloudProxy}=await import(modulePath);let audit:Record<string,unknown>={parameterHash:'a'.repeat(64),parametersSubset:{lifetimeMs:60000,startActionId:'start-action-1',artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(40),message:'private free text',url:'https://untrusted.invalid',credentialId:'private'},providerResult:{kind:'aws_instance',id:'i-1234abcd',url:'https://untrusted.invalid',token:'private'}};
 const port=createAutonomousCloudProxy({baseUrl:'https://fixed.example',controlToken:'remote-secret'},{fetch:async()=>Response.json({revision:1,requestId:'r',phase:'settled',...audit})});const read=()=>port.forward(new Request('http://local'+prefix+'/t/external-actions'));
 const response=await read();assert.equal(response.status,200);const data=await response.json() as any;assert.equal(data.parameterHash,'a'.repeat(64));assert.deepEqual(data.parametersSubset,{lifetimeMs:60000,startActionId:'start-action-1',artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(40)});assert.deepEqual(data.providerResult,{kind:'aws_instance',id:'i-1234abcd'});assert.doesNotMatch(JSON.stringify(data),/private free text|untrusted.invalid|credentialId|"token"/);
 audit={parameterHash:'a'.repeat(64),parameters:{artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(64),message:'private free text'}};const canonical=await (await read()).json() as any;assert.deepEqual(canonical.parameters,{artifactDigest:'b'.repeat(64),expectedHead:'c'.repeat(64)});
 for(const [kind,length] of [['hf_commit',40],['github_commit',64]] as const){audit={providerResult:{kind,oid:'d'.repeat(length),message:'private'}};assert.deepEqual(await (await read()).json(),{revision:1,requestId:'r',phase:'settled',providerResult:{kind,oid:'d'.repeat(length)}});}
 for(const invalid of [{parameterHash:'bad'},{parametersSubset:{lifetimeMs:1.5}},{parametersSubset:{lifetimeMs:0}},{parametersSubset:{startActionId:'https://untrusted.invalid/id'}},{parametersSubset:{artifactDigest:'x'.repeat(64)}},{parametersSubset:{expectedHead:'f'.repeat(41)}},{providerResult:{kind:'aws_instance',id:'https://untrusted.invalid'}},{providerResult:{kind:'github_commit',oid:'f'.repeat(39)}},{providerResult:{kind:'unknown',oid:'f'.repeat(40)}}]){audit=invalid;assert.equal((await read()).status,503,JSON.stringify(invalid));}
});
