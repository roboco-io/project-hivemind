import {AutonomousService,type AutonomousStorage} from '../src/autonomous-service.ts';
import {handleAutonomousApi} from '../src/cloudflare/autonomous-api.ts';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,chmod,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const modulePath='../scripts/autonomous-acceptance.ts';
const api=await import(modulePath).catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const now=1_800_000_000_000;
const input={origin:'https://example.workers.dev',requestId:'acceptance-1',model:'claude-opus-5-5',subagentModel:'fable-5-2',credentialId:'claude-remote',endsAt:now+90_000_000,budgetMicros:1,maxIterations:100,maxRunMs:120000};
test('plan requires explicit concrete scope and binds a long-running snapshot',()=>{
 assert.equal(typeof api.createAcceptancePlan,'function','acceptance planning is missing');
 const m=api.createAcceptancePlan(input,now);
 assert.equal(m.spec.execution.mode,'long_running');assert.deepEqual(m.spec.tools,['Bash','Agent']);
 assert.equal(m.spec.subagentModel,input.subagentModel);assert.equal(m.spec.execution.snapshotId,m.snapshot.digest);
 for(const key of Object.keys(input))assert.throws(()=>api.createAcceptancePlan({...input,[key]:undefined},now));
 for(const model of ['opus','latest','inherit'])assert.throws(()=>api.createAcceptancePlan({...input,model},now));
 assert.throws(()=>api.createAcceptancePlan({...input,endsAt:now+1000},now));
});
test('private manifest survives reload and rejects permissions and symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-'));try{
 const file=join(dir,'state.json'),m=api.createAcceptancePlan(input,now);
 await api.saveManifest(file,m,true);assert.equal((await stat(file)).mode&0o777,0o600);
 assert.deepEqual(await api.loadManifest(file),m);await assert.rejects(api.saveManifest(file,m,true));
 await symlink(file,join(dir,'link'));await assert.rejects(api.loadManifest(join(dir,'link')));
 await chmod(file,0o644);await assert.rejects(api.loadManifest(file));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('lost registration reply reuses the exact request and never approves',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-'));try{
 const file=join(dir,'state'),m=api.createAcceptancePlan(input,now);await api.saveManifest(file,m,true);
 const posts:string[]=[],calls:string[]=[];let lost=true;
 const fetcher=async(url:string,options:any)=>{calls.push(options.method+' '+url);if(options.method==='PUT')return Response.json({});
 posts.push(options.body);if(lost){lost=false;throw Error('secret-token');}
 return Response.json({id:'task-1',revision:1,spec:m.spec});};
 await assert.rejects(api.registerAcceptance(file,'secret-token',fetcher),/Registration uncertain/);
 assert.equal((await api.loadManifest(file)).registration,'uncertain');
 const result=await api.registerAcceptance(file,'secret-token',fetcher);
 assert.equal(result.taskId,'task-1');assert.equal(result.revision,1);assert.equal(posts[0],posts[1]);
 await api.registerAcceptance(file,'secret-token',fetcher);assert.equal(posts.length,2);
 assert.ok(calls.every(v=>!v.includes('approve')));assert.ok(!(await readFile(file,'utf8')).includes('secret-token'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('observation paginates public history and projects cloud-result without secrets',async()=>{
 const m={...api.createAcceptancePlan(input,now),taskId:'task-1',revision:1,registration:'registered'};
 const paths:string[]=[];
 const fetcher=async(url:string,options:any)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'error');paths.push(url);
 if(url.endsWith('view=summary'))return Response.json({id:m.taskId,revision:1,spec:m.spec,status:'waiting',iteration:2,counts:{humanInterventions:1,helpRequests:0,toolCalls:0},token:'secret'});
 if(url.endsWith('cloud-result'))return Response.json({taskId:m.taskId,phase:'done',stopped:true,authSynced:true,token:'secret'});
 const u=new URL(url),kind=u.searchParams.get('kind');return Response.json({taskId:m.taskId,revision:1,kind,items:kind==='runs'?[{runId:u.searchParams.has('cursor')?'r2':'r1',startedAt:now,finishedAt:now+1,outcome:'continue',usage:{cacheReadTokens:0}}]:[],...(kind==='runs'&&!u.searchParams.has('cursor')?{nextCursor:'next'}:{})});};
 const result=await api.observeAcceptance(m,'secret',fetcher);
 assert.equal(result.history.runs.length,2);assert.ok(paths.some(p=>p.includes('cursor=next')));
 assert.ok(!JSON.stringify(result).includes('secret'));
});
test('report never turns elapsed wall time or requested tools into actual proof',()=>{
 const m=api.createAcceptancePlan(input,now);
 const o={planHash:m.planHash,observedAt:now+90_000_000,summary:{approvedAt:now,status:'completed',counts:{humanInterventions:1,helpRequests:0,toolCalls:0}},history:{runs:[{startedAt:now,finishedAt:now+1,outcome:'complete'}],actions:[],resources:[],interventions:[{kind:'approval'}]},cloud:{stopped:true,authSynced:true}};
 const r=api.reportAcceptance(m,o);
 assert.equal(r.actualElapsedMs,1);assert.equal(r.verified,false);
 for(const key of ['duration24h','sessionAfterRestart','bashAndAgent','waitWithoutModelCalls','costStopAndCleanup','cancellationCleanup'])assert.equal(r.criteria[key].met,false);
 assert.equal(r.counts.humanInterventions,1);assert.equal(r.counts.helpRequests,0);
 assert.equal(r.actualProof,'deferred_by_user');
});
test('CLI rejects implicit execution and missing concrete arguments',async()=>{
 assert.equal(typeof api.acceptanceMain,'function');
 for(const args of [[],['run'],['plan','--manifest','unused'],['register','--manifest','unused'],['observe','--manifest','unused','--approve','yes']])await assert.rejects(api.acceptanceMain(args));
});
test('observation refuses changed revision without reading more endpoints',async()=>{
 const m={...api.createAcceptancePlan(input,now),taskId:'task-1',revision:1,registration:'registered'};let calls=0;
 await assert.rejects(api.observeAcceptance(m,'token',async()=>{calls++;return Response.json({id:'task-1',revision:2,spec:m.spec});}),/scope changed/);
 assert.equal(calls,1);
});
test('report rejects a stored observation from another canonical plan',()=>{
 const m=api.createAcceptancePlan(input,now);
 assert.throws(()=>api.reportAcceptance(m,{planHash:'other',observedAt:now,summary:{},history:{},cloud:{}}),/Observation scope mismatch/);
});

class TransactionalMemory implements AutonomousStorage {
 data=new Map<string,unknown>();
 async get<T>(key:string):Promise<T|undefined>{return structuredClone(this.data.get(key)) as T|undefined;}
 async put<T>(key:string,value:T){this.data.set(key,structuredClone(value));}
 async delete(key:string){this.data.delete(key);}
 async transaction<T>(fn:(tx:AutonomousStorage)=>Promise<T>):Promise<T>{
 const tx=new TransactionalMemory();tx.data=structuredClone(this.data);const result=await fn(tx);this.data=tx.data;return result;
 }
}
function reverseKeys(value:any):any {
 if(Array.isArray(value))return value.map(reverseKeys);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reverseKeys(v)]));
 return value;
}
test('real API/service registers once after lost reply and observes canonical paginated history after restore',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-wire-'));try{
 const file=join(dir,'manifest'),plan=api.createAcceptancePlan(input,now),storage=new TransactionalMemory();await api.saveManifest(file,plan,true);
 let service=new AutonomousService(storage,()=>now),loseReply=true;
 const wire:{path:string;status:number;body:any}[]=[];
 const fetcher=async(url:string,options:RequestInit)=>{
 const path=new URL(url).pathname;
 if(path.startsWith('/v1/snapshots/')){assert.equal(options.method,'PUT');return Response.json({});}
 if(path.endsWith('/cloud-result'))return Response.json({taskId:path.split('/')[3],phase:'idle'});
 const response=await handleAutonomousApi(new Request(url,options),{operatorToken:'operator',workerToken:'worker',service});
 const body=await response.clone().json();wire.push({path,status:response.status,body});
 if(options.method==='POST'&&path==='/v1/autonomous-tasks'&&loseReply){loseReply=false;assert.equal(response.status,201);throw Error('reply lost after durable commit');}
 return response;
 };
 await assert.rejects(api.registerAcceptance(file,'operator',fetcher),/Registration uncertain/);
 service=new AutonomousService(storage,()=>now);
 const registered=await api.registerAcceptance(file,'operator',fetcher);
 const creates=wire.filter(w=>w.path==='/v1/autonomous-tasks');
 assert.equal(creates.length,2);assert.equal(creates[0]!.body.id,creates[1]!.body.id);
 assert.equal(registered.taskId,creates[0]!.body.id);assert.equal(registered.revision,creates[0]!.body.revision);
 assert.equal(creates[1]!.body.status,'awaiting_approval');assert.ok(!('runs' in creates[1]!.body),'long-running create returns summary');
 for(let i=0;i<101;i++)await service.execute('message',{id:registered.taskId,message:'local seam '+i});
 service=new AutonomousService(storage,()=>now);
 const observation=await api.observeAcceptance(await api.loadManifest(file),'operator',fetcher);
 assert.equal(observation.summary.id,registered.taskId);assert.equal(observation.summary.revision,1);
 assert.equal(observation.history.interventions.length,101);assert.equal(observation.summary.counts.humanInterventions,101);
 const pages=wire.filter(w=>w.path.endsWith('/history'));
 for(const page of pages){assert.equal(page.status,200);assert.equal(page.body.taskId,registered.taskId);assert.equal(page.body.revision,1);assert.ok(Array.isArray(page.body.items));}
 const interventions=pages.filter(p=>p.body.kind==='interventions');assert.deepEqual(interventions.map(p=>p.body.items.length),[100,1]);assert.equal(typeof interventions[0]!.body.nextCursor,'string');
 assert.equal(observation.cloud.phase,'idle');assert.equal(api.reportAcceptance(registered,observation).verified,false);
 const listing=await handleAutonomousApi(new Request(input.origin+'/v1/autonomous-tasks?limit=100',{headers:{authorization:'Bearer operator'}}),{operatorToken:'operator',workerToken:'worker',service});
 assert.equal(listing.status,200);assert.equal(((await listing.json()) as any).items.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('real API accepts wire specs with reordered nested object keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-order-'));try{
 const file=join(dir,'manifest'),plan=api.createAcceptancePlan(input,now);await api.saveManifest(file,plan,true);
 const service=new AutonomousService(new TransactionalMemory(),()=>now);
 const fetcher=async(url:string,options:RequestInit)=>{
 if(new URL(url).pathname.startsWith('/v1/snapshots/'))return Response.json({});
 if(new URL(url).pathname.endsWith('/cloud-result'))return Response.json({taskId:new URL(url).pathname.split('/')[3],phase:'idle'});
 const response=await handleAutonomousApi(new Request(url,options),{operatorToken:'operator',workerToken:'worker',service});
 const body=await response.json() as any;if(body.spec)body.spec=reverseKeys(body.spec);
 return Response.json(body,{status:response.status});
 };
 const registered=await api.registerAcceptance(file,'operator',fetcher);
 const observation=await api.observeAcceptance(registered,'operator',fetcher);
 assert.equal(observation.summary.id,registered.taskId);assert.equal(observation.summary.status,'awaiting_approval');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('private reads reject hardlinks for manifests and auth files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-links-'));try{
 const file=join(dir,'manifest');await api.saveManifest(file,api.createAcceptancePlan(input,now),true);
 await link(file,join(dir,'alias'));await assert.rejects(api.loadManifest(file),/Private/);
 await rm(join(dir,'alias'));
 const auth=join(dir,'auth');await writeFile(auth,JSON.stringify({controlToken:'operator'}),{mode:0o600});await link(auth,join(dir,'auth-alias'));
 await assert.rejects(api.acceptanceMain(['register','--manifest',file,'--auth-file',auth]),/Private/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('FIFO auth reads reject promptly instead of waiting for a writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'acceptance-fifo-'));try{
 const file=join(dir,'manifest'),fifo=join(dir,'auth');await api.saveManifest(file,api.createAcceptancePlan(input,now),true);
 execFileSync('mkfifo',['-m','600',fifo]);
 const script=`import {acceptanceMain} from ${JSON.stringify(new URL(modulePath,import.meta.url).href)};try{await acceptanceMain(${JSON.stringify(['register','--manifest',file,'--auth-file',fifo])});process.exitCode=2}catch{process.exitCode=0}`;
 assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{timeout:3000,stdio:'pipe'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
