import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AutonomousEngine,AutonomousError} from '../packages/core/src/autonomous.js';
const projectRoot=new URL(import.meta.url.includes('/dist/tests/')?'../../':'../',import.meta.url);
const spec={requestId:'memory',goal:'work',provider:'mock' as const,model:'mock',endsAt:100000,budgetMicros:100,tools:['fetch'],systems:['test'],credentialIds:[],maxRunMs:1000,maxIterations:10};
function seed(){const e=new AutonomousEngine();e.create(spec,0,'t');e.approve('t',1,'approved',1);return e.snapshot();}
function pinnedCloudSpec(){return {...spec,provider:'claude' as const,model:'model-fixed',tools:['Bash'],systems:[],credentialIds:['credential'],billingPolicy:{model:'subscription' as const,budget:'external_actions' as const},maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare' as const,snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};}
const atomic=<T>(e:AutonomousEngine,fn:()=>T):T=>Reflect.get(e,'atomic').call(e,fn);
test('exclusive hydration validates fresh state without a whole-state clone; default remains defensive',()=>{
 const state=seed(),defaultState=seed(),native=globalThis.structuredClone;let stateClones=0;
 globalThis.structuredClone=((value:unknown)=>{if(value===state||value===defaultState)stateClones++;return native(value);}) as typeof structuredClone;
 let owned:AutonomousEngine;
 try{owned=Reflect.construct(AutonomousEngine,[state,{ownership:'exclusive'}]);assert.equal(stateClones,0);const copy=new AutonomousEngine(defaultState);assert.equal(stateClones,1);defaultState.tasks.t!.spec.goal='outside';assert.equal(copy.get('t').spec.goal,'work');}finally{globalThis.structuredClone=native;}
 assert.equal(owned!.get('t').id,'t');const invalid=seed();invalid.tasks.t!.spentMicros=-1;assert.throws(()=>Reflect.construct(AutonomousEngine,[invalid,{ownership:'exclusive'}]));
});
test('trusted persistence records expose strings and detached summary/owner metadata only',()=>{
 const e=new AutonomousEngine(seed()),records=Reflect.get(e,'persistenceRecords');assert.equal(typeof records,'function');const [record]=[...records.call(e)];assert.ok(record);
 assert.equal(typeof record.json,'string');assert.equal(record.id,'t');assert.deepEqual(JSON.parse(record.json),e.snapshot().tasks.t);assert.equal('runs' in record.summary,false);assert.deepEqual(record.credentialOwner,{credentialIds:[] as string[],blocked:false});record.summary.spec.goal='outside';record.credentialOwner.credentialIds.push('outside');assert.equal(e.get('t').spec.goal,'work');assert.deepEqual(e.get('t').spec.credentialIds,[]);
});
test('nested successful mutation is rolled back with an ordinary outer failure',()=>{
 const e=new AutonomousEngine(seed()),before=e.snapshot();assert.throws(()=>atomic(e,()=>{e.message('t','inner committed',2);throw Error('outer rollback');}));assert.deepEqual(e.snapshot(),before);
});
test('inner rollback preserves the parent draft and parent local task identity',()=>{
 const e=new AutonomousEngine(seed());atomic(e,()=>{
  const parent=Reflect.get(e,'task').call(e,'t');e.message('t','inner success',2);assert.equal(parent.interventions.at(-1)?.message,'inner success');
  assert.throws(()=>atomic(e,()=>{e.message('t','inner failure',3);throw Error('rollback child');}));assert.equal(parent.interventions.at(-1)?.message,'inner success');e.message('t','outer success',4);
 });assert.deepEqual(e.get('t').interventions.map(i=>i.message),['approved','inner success','outer success']);
});
test('intentional nested policy suspension survives committed failure but outer ordinary failure rolls it back',()=>{
 const e=new AutonomousEngine(seed()),lease=e.claim('t','worker','token','run',2)!;const before=e.snapshot();
 assert.throws(()=>atomic(e,()=>{e.reserve(lease,{requestId:'bad',tool:'forbidden',system:'test',operation:'read',estimatedCostMicros:1},3);}),AutonomousError);assert.equal(e.get('t').status,'awaiting_input');
 const other=new AutonomousEngine(before);assert.throws(()=>atomic(other,()=>{try{other.reserve(lease,{requestId:'bad',tool:'forbidden',system:'test',operation:'read',estimatedCostMicros:1},3);}catch{}throw Error('outer ordinary');}));assert.deepEqual(other.snapshot(),before);
});
test('rollback isolates existing actions resources lease and historical reconciliation records',()=>{
 const e=new AutonomousEngine(seed()),lease=e.claim('t','worker','token','run',2)!,a=e.reserve(lease,{requestId:'a',tool:'fetch',system:'test',operation:'create',estimatedCostMicros:2},3);const before=e.snapshot();
 assert.throws(()=>atomic(e,()=>{e.heartbeat(lease,4);e.settle(lease,a.id,1,true,{id:'resource',system:'test',cleanupOperation:'delete'},5);throw Error('rollback ledger');}));assert.deepEqual(e.snapshot(),before);
 e.finish(lease,{outcome:'continue',costMicros:null,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}},6);const unknown=e.snapshot(),published=e.get('t');assert.throws(()=>atomic(e,()=>{e.reconcileRun('t','run',3,'verified',7);throw Error('rollback reconciliation');}));assert.deepEqual(e.snapshot(),unknown);e.reconcileRun('t','run',3,'verified',7);assert.equal(published.runs[0]?.reconciledCostMicros,undefined);assert.equal(unknown.tasks.t!.runs[0]?.reconciledCostMicros,undefined);
});
test('serialized JSON codec matches existing canonical bytes at Unicode chunk boundaries',async()=>{
 const repository=await import('../packages/core/src/autonomous-repository.js'),encodeJson=Reflect.get(repository,'encodeAutonomousRecordJson');assert.equal(typeof encodeJson,'function');
 const value={message:'한글🙂'.repeat(50000)},json=JSON.stringify(value),record=encodeJson(json);assert.deepEqual(record,repository.encodeAutonomousRecord(value));assert.deepEqual(repository.decodeAutonomousRecord(record),value);assert.ok(record.chunks.every((c:string)=>Buffer.byteLength(c)<=128*1024));
 assert.throws(()=>encodeJson('x'.repeat(32*1024*1024+1)),{statusCode:413});
});

test('streamed JSON codec rejects canonical-base64 invalid UTF8 even with a correct hash',async()=>{
 const repository=await import('../packages/core/src/autonomous-repository.js'),raw=Buffer.from([0xc3,0x28]);assert.throws(()=>repository.decodeAutonomousRecord({chunks:[raw.toString('base64')],digest:createHash('sha256').update(raw).digest('hex'),bytes:raw.length}),{statusCode:400});
});
test('SQLite persistence and bounded review do not call legacy whole-state snapshot/get',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');const snapshot=AutonomousEngine.prototype.snapshot,get=AutonomousEngine.prototype.get;const store=createAutonomousStore(':memory:');
 AutonomousEngine.prototype.snapshot=()=>{throw Error('unexpected persistence snapshot');};AutonomousEngine.prototype.get=()=>{throw Error('unexpected persistence full get');};
 try{store.create(spec,0,'t');store.approve('t',1,'approved',1);store.message('t','note',2);assert.equal(store.getSummary('t').status,'ready');assert.equal(store.historyPage({id:'t',kind:'interventions'}).items.length,2);}finally{AutonomousEngine.prototype.snapshot=snapshot;AutonomousEngine.prototype.get=get;store.close();}
});
test('exclusive COW operates on a frozen historical graph without mutating borrowed records',()=>{
 const e=new AutonomousEngine(seed()),lease=e.claim('t','worker','token','run',2)!,a=e.reserve(lease,{requestId:'resource',tool:'fetch',system:'test',operation:'create',estimatedCostMicros:1},3);e.settle(lease,a.id,1,true,{id:'resource',system:'test',cleanupOperation:'delete'},4);e.finish(lease,{outcome:'continue',costMicros:0,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}},5);const input=e.snapshot();
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}};freeze(input);
 const owned=new AutonomousEngine(input,{ownership:'exclusive'});assert.equal(owned.cancel('t','stop',6).status,'stopping');assert.equal(owned.cleaned('t','resource',7).status,'cancelled');assert.equal(input.tasks.t!.status,'ready');assert.equal(input.tasks.t!.resources[0]?.status,'active');assert.equal(input.tasks.t!.runs.length,1);
});
test('transactional DO persistence and bounded reads never call legacy snapshot/full get',async()=>{
 const {AutonomousService}=await import(new URL('cloudflare/backend/src/autonomous-service.ts',projectRoot).href),source=await import(new URL('packages/core/src/autonomous.ts',projectRoot).href),Engine=source.AutonomousEngine;const snapshot=Engine.prototype.snapshot,get=Engine.prototype.get;
 const data=new Map<string,unknown>(),storage={async get<T>(key:string){return structuredClone(data.get(key)) as T|undefined;},async put(key:string,value:unknown){data.set(key,structuredClone(value));},async delete(key:string){data.delete(key);},async transaction<T>(fn:(tx:unknown)=>Promise<T>){return fn(storage);}};
 Engine.prototype.snapshot=()=>{throw Error('unexpected DO snapshot');};Engine.prototype.get=()=>{throw Error('unexpected DO full get');};
 try{const service=new AutonomousService(storage,()=>1000),created=await service.execute('create',{spec});await service.execute('approve',{id:created.id,revision:1,reason:'approved'});await service.execute('message',{id:created.id,message:'note'});assert.equal((await service.execute('getSummary',{id:created.id})).status,'ready');assert.equal((await service.execute('historyPage',{id:created.id,kind:'interventions'})).items.length,2);}finally{Engine.prototype.snapshot=snapshot;Engine.prototype.get=get;}
});
test('record stream emits exact canonical 96KiB bytes and decoder accepts incremental chunks',async()=>{
 const repository=await import('../packages/core/src/autonomous-repository.js'),iterate=Reflect.get(repository,'iterateAutonomousRecordJson'),decoderFactory=Reflect.get(repository,'createAutonomousRecordDecoder');assert.equal(typeof iterate,'function');assert.equal(typeof decoderFactory,'function');
 const value={message:'🙂한글'.repeat(70000)},json=JSON.stringify(value),bytes=Buffer.from(json),expected=[];for(let i=0;i<bytes.length;i+=96*1024)expected.push(bytes.subarray(i,i+96*1024).toString('base64'));
 const iterator=iterate(json),chunks:string[]=[];let item=iterator.next();while(!item.done){chunks.push(item.value);item=iterator.next();}assert.deepEqual(chunks,expected);assert.deepEqual(item.value,{digest:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,chunks:expected.length});
 const decoder=decoderFactory(item.value);for(const chunk of chunks)decoder.push(chunk);assert.deepEqual(decoder.finish(),value);assert.throws(()=>decoder.finish());
 const damaged=decoderFactory(item.value);assert.throws(()=>{for(const [i,chunk] of chunks.entries())damaged.push(i===chunks.length-1?Buffer.from('x'.repeat(Buffer.from(chunk,'base64').length)).toString('base64'):chunk);damaged.finish();},{statusCode:400});
 assert.throws(()=>decoderFactory({...item.value,chunks:item.value.chunks+1}),{statusCode:400});
});
test('public full-get byte ceiling rejects a valid large task while private get stays defensive',()=>{
 const state=seed();state.tasks.t!.interventions.push(...Array.from({length:200},()=>({kind:'message' as const,message:'x'.repeat(16000),at:2,revision:1})));const e=new AutonomousEngine(state);assert.ok(Buffer.byteLength(JSON.stringify(state))>2*1024*1024);
 assert.throws(()=>Reflect.apply(e.get,e,['t',2*1024*1024]),(error:unknown)=>(error as {statusCode:number;code:string}).statusCode===413&&(error as {code:string}).code==='AUTONOMOUS_PAGE_REQUIRED');
 const full=e.get('t');full.spec.goal='outside';assert.equal(e.getSummary('t').spec.goal,'work');assert.equal(full.interventions.length,201);
});
test('private external task view is explicitly typed bounded-ledger data without history copies',()=>{
 const e=new AutonomousEngine(seed()),lease=e.claim('t','worker','private-token','run',2)!,a=e.reserve(lease,{requestId:'a',tool:'fetch',system:'test',operation:'create',estimatedCostMicros:1},3);e.settle(lease,a.id,1,true,{id:'resource',system:'test',cleanupOperation:'delete'},4);
 const getView=Reflect.get(e,'getExternalTask');assert.equal(typeof getView,'function');const view=getView.call(e,'t');assert.equal('runs' in view,false);assert.equal('interventions' in view,false);assert.equal('checkpoint' in view,false);assert.equal(view.actions.length,1);assert.equal(view.resources.length,1);assert.equal(view.lease?'token' in view.lease:false,false);view.actions[0]!.status='failed';view.spec.goal='outside';assert.equal(e.get('t').actions[0]?.status,'succeeded');assert.equal(e.get('t').spec.goal,'work');
});
function acceptedInvoice(resource=true){
 const e=new AutonomousEngine();e.create({...spec,provider:'claude',tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws']},0,'t');e.approve('t',1,'approved',1);const lease=e.claim('t','worker','token','run',2)!,action=e.reserve(lease,{requestId:'external',tool:'mcp__hivemind__action',system:'aws',operation:'aws.spot.start',estimatedCostMicros:10},3);e.acceptExternal(lease,action.id,resource?{id:'resource',system:'aws',cleanupOperation:'terminate'}:undefined,4);return {e,action,absent(){if(resource)e.cleanedExternal('t','resource',5);}};
}
test('operator invoice settles atomically with exactly one human event and immutable attested provenance',()=>{
 const f=acceptedInvoice();f.absent();const before=f.e.getSummary('t').counts!.humanInterventions,review={evidenceRef:'invoice:aws:2026-11',reason:'Actual invoice amount confirmed'};
 const action=Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,4,true,6,review]);assert.equal(f.e.getSummary('t').counts!.humanInterventions,before+1);assert.equal(action.actualCostMicros,4);assert.equal(Reflect.get(action,'operatorBillingEvidence')!.source,'operator_attested');review.reason='outside mutation';assert.equal(Reflect.get(f.e.get('t').actions[0]!,'operatorBillingEvidence')!.reason,'Actual invoice amount confirmed');
 const stable={evidenceRef:'invoice:aws:2026-11',reason:'Actual invoice amount confirmed'};Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,4,true,7,stable]);assert.equal(f.e.getSummary('t').counts!.humanInterventions,before+1);
 for(const [cost,evidenceRef,reason] of [[5,stable.evidenceRef,stable.reason],[4,'other-invoice',stable.reason],[4,stable.evidenceRef,'Changed reason']] as const)assert.throws(()=>Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,cost,true,8,{evidenceRef,reason}]),{statusCode:409});
 new AutonomousEngine(f.e.snapshot());
});
test('automated external settlement adds no human event and operator invoice cannot bypass absence',()=>{
 const auto=acceptedInvoice();auto.absent();const before=auto.e.getSummary('t').counts!.humanInterventions;auto.e.settleExternal('t',auto.action.id,3,true,6);assert.equal(auto.e.getSummary('t').counts!.humanInterventions,before);assert.equal(Reflect.get(auto.e.get('t').actions[0]!,'operatorBillingEvidence'),undefined);
 const active=acceptedInvoice(),snapshot=active.e.snapshot();assert.throws(()=>Reflect.apply(active.e.settleExternal,active.e,['t',active.action.id,3,true,6,{evidenceRef:'invoice:1',reason:'Actual charge'}]),{statusCode:409});assert.deepEqual(active.e.snapshot(),snapshot);
});
test('operator invoice rollback includes money proof and human event; evidence/ref bounds are strict',()=>{
 for(const review of [{evidenceRef:'https://invoice.example/?token=bad',reason:'invoice'},{evidenceRef:'invoice:1',reason:'x'.repeat(1001)},{evidenceRef:'invoice:1',reason:' '}]){
  const f=acceptedInvoice();f.absent();const before=f.e.snapshot();assert.throws(()=>Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,3,true,6,review]));assert.deepEqual(f.e.snapshot(),before);
 }
 const f=acceptedInvoice();f.absent();const before=f.e.snapshot();assert.throws(()=>atomic(f.e,()=>{Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,3,true,6,{evidenceRef:'invoice:1',reason:'verified'}]);throw Error('outer rollback');}));assert.deepEqual(f.e.snapshot(),before);
});
test('restore rejects operator invoice proof without its unique reconciliation event',()=>{
 const f=acceptedInvoice();f.absent();Reflect.apply(f.e.settleExternal,f.e,['t',f.action.id,3,true,6,{evidenceRef:'invoice:1',reason:'verified'}]);const state=f.e.snapshot();assert.ok(Reflect.get(state.tasks.t!.actions[0]!,'operatorBillingEvidence'));new AutonomousEngine(state);
 const missing=structuredClone(state);missing.tasks.t!.interventions=missing.tasks.t!.interventions.filter(i=>i.kind!=='reconciliation');assert.throws(()=>new AutonomousEngine(missing));
 const duplicate=structuredClone(state),note=duplicate.tasks.t!.interventions.find(i=>i.kind==='reconciliation')!;duplicate.tasks.t!.interventions.push({...note});assert.throws(()=>new AutonomousEngine(duplicate));
});
test('accepted operator invoice reserves its reconciliation slot through saturated recovery history',()=>{
 const f=acceptedInvoice();f.absent();const state=f.e.snapshot(),task=state.tasks.t!;task.spec={...task.spec,model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},credentialIds:['credential'],maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};
 const limit=4*65536+2;task.interventions=[...task.interventions,...Array.from({length:limit-4},()=>({kind:'reconciliation' as const,message:'prior review',at:5,revision:1}))];assert.equal(task.interventions.length,limit-3);
 const denied={version:1 as const,tasks:{t:{...task,interventions:[...task.interventions,{kind:'reconciliation' as const,message:'overflow',at:5,revision:1}]}}};assert.throws(()=>new AutonomousEngine(denied));
 const e=new AutonomousEngine(state,{ownership:'exclusive'}),before=e.getSummary('t').counts!.humanInterventions;Reflect.apply(e.settleExternal,e,['t',f.action.id,3,true,6,{evidenceRef:'invoice:1',reason:'Actual charge'}]);assert.equal(e.getSummary('t').counts!.humanInterventions,before+1);const record=e.persistenceRecords().next().value;assert.ok(record);new AutonomousEngine({version:1,tasks:{t:JSON.parse(record.json)}},{ownership:'exclusive'});
});
test('Claude known model aliases fail central preflight while concrete synthetic pins and Mock stay allowed',async()=>{
 const contract=await import('../packages/contracts/src/autonomous.js'),validatePin=Reflect.get(contract,'validateAutonomousModelPin');assert.equal(typeof validatePin,'function');
 const aliases=['default','inherit','latest','best','opus','sonnet','haiku','opusplan'];for(const alias of aliases)for(const value of [alias,alias.toUpperCase()]){
  assert.throws(()=>validatePin(value));assert.throws(()=>new AutonomousEngine().create({...pinnedCloudSpec(),model:value},0,'t'));assert.throws(()=>new AutonomousEngine().create({...pinnedCloudSpec(),subagentModel:value},0,'t'));
 }
 for(const value of ['model-fixed','claude-opus-4-6','Fable-actual-id-unverified']){assert.doesNotThrow(()=>validatePin(value));assert.doesNotThrow(()=>new AutonomousEngine().create({...pinnedCloudSpec(),model:value},0,'t'));}
 assert.doesNotThrow(()=>new AutonomousEngine().create({...spec,model:'default'},0,'mock'));for(const value of [' fixed','x'.repeat(101),'https://model.invalid'])assert.throws(()=>validatePin(value));
});
test('legacy structured Claude alias records remain readable but never gain cloud execution',()=>{
 const e=new AutonomousEngine();e.create(pinnedCloudSpec(),0,'legacy');const draft=e.snapshot();draft.tasks.legacy!.spec.model='OpUs';const readable=new AutonomousEngine(draft);assert.equal(readable.getSummary('legacy').spec.model,'OpUs');assert.throws(()=>readable.approve('legacy',1,'new approval',1),{statusCode:422});assert.equal(readable.get('legacy').status,'awaiting_approval');
 e.approve('legacy',1,'approved',1);const ready=e.snapshot();ready.tasks.legacy!.spec.model='opus';const oldReady=new AutonomousEngine(ready);assert.equal(oldReady.claimCloud('legacy','worker','token','run',2),null);assert.ok(['cancelled','awaiting_input','stopping'].includes(oldReady.get('legacy').status));assert.match(oldReady.get('legacy').stopReason??'',/model pin/i);
 const lease=e.claimCloud('legacy','worker','token','run',2)!,usage={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},checkpoint={sessionId:'session',model:'model-fixed',sequence:1,objectKey:'private'};e.nativeStart(lease,'runtime',3);e.recordNativeReceipt(lease,{runId:'run',runtimeId:'runtime',sessionId:'session',model:'model-fixed',sequence:1,usage,stopped:true,outcome:'complete'},4);e.finishCloud(lease,{outcome:'complete',costMicros:null,usage,checkpoint},true,5);
 const terminal=e.snapshot();terminal.tasks.legacy!.spec.model='opus';terminal.tasks.legacy!.checkpoint!.model='opus';terminal.tasks.legacy!.runs[0]!.checkpoint!.model='opus';const restored=new AutonomousEngine(terminal);assert.equal(restored.get('legacy').status,'completed');assert.equal(restored.get('legacy').spec.model,'opus');new AutonomousEngine(restored.snapshot());
});
test('generic non-cloud Claude ledgers preserve broad legacy descriptions while cloud admission remains strict',()=>{
 const cloud=pinnedCloudSpec(),{execution:_execution,...generic}=cloud;const legacy={...generic,model:'legacy model',subagentModel:'legacy model',tools:[],credentialIds:['legacy id'],maxRunMs:1};const e=new AutonomousEngine();assert.equal(e.create(legacy,0,'generic').status,'awaiting_approval');assert.equal(e.approve('generic',1,'ledger approval',1).status,'ready');assert.ok(e.claim('generic','worker','token','run',2));new AutonomousEngine(e.snapshot());
 assert.throws(()=>new AutonomousEngine().create({...cloud,model:'OPUS'},0,'cloud'));assert.throws(()=>new AutonomousEngine().create({...cloud,subagentModel:'inherit'},0,'cloud'));
});
test('first trusted quota receipt arriving after reset remains runtime-bound and preserves the original reset',()=>{
 const e=new AutonomousEngine();e.create({...spec,provider:'claude',model:'model-fixed',tools:['Bash'],systems:[],credentialIds:['credential'],billingPolicy:{model:'subscription',budget:'external_actions'},maxRunMs:60000},0,'t');e.approve('t',1,'approved',1);const lease=e.claim('t','worker','token','run',2)!;e.nativeStart(lease,'runtime',3);
 const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},quota={kind:'rejected' as const,resetsAt:100,evidence:'claude_rate_limit_event' as const},receipt={runId:'run',runtimeId:'runtime',sessionId:'session',model:'model-fixed',sequence:1,usage:zero,stopped:true as const,outcome:'wait' as const,wakeAt:100,quota,usageUnavailable:true as const};
 assert.throws(()=>e.recordNativeReceipt(lease,{...receipt,runtimeId:'forged'},101));assert.throws(()=>e.recordNativeReceipt(lease,{...receipt,quota:{...quota,resetsAt:2},wakeAt:2},101));
 e.recordNativeReceipt(lease,receipt,101);const done=e.finish(lease,{outcome:'wait',wakeAt:100,quota,usageUnavailable:true,costMicros:null,checkpoint:{sessionId:'session',objectKey:'private',model:'model-fixed',sequence:1},usage:zero},102);assert.equal(done.runs[0]?.wakeAt,100);assert.equal(done.runs[0]?.usageUnavailable,true);new AutonomousEngine(e.snapshot());
 const ordinary=new AutonomousEngine(seed()),other=ordinary.claim('t','worker','token','run',2)!;assert.throws(()=>ordinary.finish(other,{outcome:'wait',wakeAt:100,costMicros:0,usage:zero},101));
});
test('public list byte ceiling rejects before cloning while private list remains defensive',()=>{
 const state=seed();state.tasks.t!.interventions.push(...Array.from({length:200},()=>({kind:'message' as const,message:'가'.repeat(10000),at:2,revision:1})));const e=new AutonomousEngine(state),original=globalThis.structuredClone;let clones=0;globalThis.structuredClone=((value:unknown)=>{clones++;return original(value);}) as typeof structuredClone;
 try{assert.throws(()=>Reflect.apply(e.list,e,[2*1024*1024]),(error:unknown)=>(error as {statusCode:number;code:string}).statusCode===413&&(error as {code:string}).code==='AUTONOMOUS_PAGE_REQUIRED');assert.equal(clones,0);}finally{globalThis.structuredClone=original;}
 const full=e.list();assert.equal(full[0]?.interventions.length,201);full[0]!.spec.goal='outside';assert.equal(e.getSummary('t').spec.goal,'work');
});
test('large Korean metadata and history pages stay below 2MiB and traverse all rows without loss',async()=>{
 const {pageAutonomousTasks,pageAutonomousHistory}=await import('../packages/core/src/autonomous-repository.js'),base=seed().tasks.t!,goal='가'.repeat(16000),secret='s'.repeat(64),entries=Array.from({length:100},(_,i)=>({sequence:i+1,task:{...base,id:'task-'+i,spec:{...base.spec,requestId:'request-'+i,goal}}}));let cursor:string|undefined;const ids:string[]=[];
 do{const page=pageAutonomousTasks(entries,{limit:100,...(cursor?{cursor}:{})},secret);assert.ok(Buffer.byteLength(JSON.stringify(page))<2*1024*1024);assert.ok(page.items.length>0);if(!cursor)assert.ok(page.items.length<100);ids.push(...page.items.map(item=>item.id));cursor=page.nextCursor;}while(cursor);assert.equal(ids.length,100);assert.equal(new Set(ids).size,100);assert.deepEqual(ids,entries.map(e=>e.task.id));
 const task={...base,interventions:Array.from({length:100},(_,i)=>({kind:'message' as const,message:goal,at:i+1,revision:1}))};let reviewed=0;const times:number[]=[];cursor=undefined;
 do{const page=pageAutonomousHistory(task,'interventions',{limit:100,...(cursor?{cursor}:{})},secret);assert.ok(Buffer.byteLength(JSON.stringify(page))<2*1024*1024);assert.ok(page.items.length>0);reviewed+=page.items.length;times.push(...page.items.map(row=>row.at as number));cursor=page.nextCursor;}while(cursor);assert.equal(reviewed,100);assert.deepEqual(times,Array.from({length:100},(_,i)=>i+1));
});
