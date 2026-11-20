import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExternalBroker,validateExternalState} from '../packages/core/src/autonomous-external.ts';
import {createExternalStore} from '../packages/core/src/autonomous-external-store.ts';
import {createExternalProviderTransport,createExternalR2ArtifactLoader,externalArtifactDigest} from '../packages/adapters/src/autonomous-external.ts';
import type {ExternalInvocation,ExternalProfile} from '../packages/contracts/src/autonomous-external.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const oid=(n:number)=>n.toString(16).padStart(40,'0');
const profile:ExternalProfile={id:'gh',enabled:true,provider:'github',credentialRef:'fixture',target:{repository:'fixture/repo',branch:'main'},operations:['github.branch.push'],maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:2};
const artifact={files:[{path:'empty.txt',contentBase64:''}]};
function loader(a=artifact){const bytes=Buffer.from(JSON.stringify(a));return createExternalR2ArtifactLoader({async get(){return {size:bytes.length,async arrayBuffer(){return Uint8Array.from(bytes).buffer;}};}});}
function fixture(){
 let captured:ExternalInvocation;let changed=false;let badLink=false;let match=true;const calls:string[]=[];
 const transport=createExternalProviderTransport({enabled:true,github:{enabled:true,repository:'fixture/repo',branch:'main'},artifacts:{async load(){return artifact;}},now:()=>1000,fetch:async(url,init)=>{
  assert.equal(init?.method,'GET');const u=new URL(String(url));calls.push(u.pathname+u.search);
  if(u.pathname.includes('/git/ref/'))return Response.json({object:{sha:changed?oid(999):oid(200)}});
  if(u.pathname.endsWith('/commits')){
   assert.equal(u.searchParams.get('sha'),oid(200));
   if(u.searchParams.get('page')!=='2')return Response.json(Array.from({length:100},(_,n)=>({sha:oid(n+300),commit:{message:'later'}})),{headers:{link:`<${badLink?'https://evil.example/steal':`https://api.github.com/repos/fixture/repo/commits?sha=${oid(200)}&per_page=100&page=2`}>; rel="next"`}});
   return Response.json(match?[{sha:oid(2),commit:{message:'hivemind:'+sha(JSON.stringify([captured.ownershipToken,captured.idempotencyKey,captured.parametersHash]))}}]:[]);
  }
  if(u.pathname.includes('/git/trees/'))return Response.json({sha:oid(3),truncated:false,tree:[{path:'empty.txt',type:'blob',mode:'100644',sha:createHash('sha1').update('blob 0\0').digest('hex')}]});
  return Response.json({sha:u.pathname.endsWith(oid(2))?oid(2):oid(1),message:'hivemind:'+sha(JSON.stringify([captured.ownershipToken,captured.idempotencyKey,captured.parametersHash])),parents:[{sha:oid(1)}],tree:{sha:oid(3)}});
 }});
 const dir=mkdtempSync(join(tmpdir(),'provider-recovery-')),path=join(dir,'state.sqlite');let store=createExternalStore(path);
 const options=()=>({store,registry:{get:()=>profile},now:()=>1000,resolver:{async withCredential<T>(_r:unknown,_s:unknown,consume:(c:any)=>Promise<T>){return consume({provider:'github',token:'fixture-token'});}},transport:{...transport,async execute(i:ExternalInvocation){captured=i;throw Error('lost reply');}}});
 let broker=new ExternalBroker(options());broker.serverApprove({taskId:'task',revision:1,profileId:'gh',endsAt:100000,budgetMicros:100});
 return {get broker(){return broker;},get store(){return store;},transport,calls,get invocation(){return captured;},changeHead(){changed=true;},noMatch(){match=false;},badLink(){badLink=true;},reopen(){store.close();store=createExternalStore(path);broker=new ExternalBroker(options());broker.recover();},async start(requestId='request'){return broker.execute({taskId:'task',revision:1,profileId:'gh',requestId,operation:'github.branch.push',parameters:{artifactDigest:externalArtifactDigest(artifact),expectedHead:oid(1)}});},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('R2 accepts canonical empty file and preserves digest and path guards',async()=>{
 assert.deepEqual(await loader().load(externalArtifactDigest(artifact)),artifact);
 await assert.rejects(loader().load('0'.repeat(64)));
});
test('GitHub page two recovers across broker reopen with pinned head and bounded reads',async()=>{
 const f=fixture();try{const a=await f.start();const first=await f.broker.reconcile(a.id);assert.equal(first.status,'ambiguous');assert.equal(typeof (first as any).providerRecoveryCursor,'string');assert.equal(f.calls.filter(c=>c.includes('/commits?')).length,1);
 f.changeHead();f.reopen();const recovered=await f.broker.reconcile(a.id);assert.equal(recovered.status,'succeeded');assert.equal((recovered as any).providerRecoveryCursor,undefined);assert.equal(f.calls.filter(c=>c.includes('/git/ref/')).length,1);assert.equal(f.calls.filter(c=>c.includes('/commits?')).length,2);assert.equal(f.calls.length,7);
 }finally{f.close();}
});
test('malformed and cross-action cursors are rejected before provider requests',async()=>{
 const f=fixture();try{const a=await f.start();await f.broker.reconcile(a.id);const saved=f.store.transaction(s=>s);const cursor=(saved.actions[a.id] as any).providerRecoveryCursor;assert.equal(typeof cursor,'string');
 for(const value of ['x','x'.repeat(513),JSON.stringify({...JSON.parse(cursor),page:0}),JSON.stringify({...JSON.parse(cursor),extra:true})]){const state=structuredClone(saved);(state.actions[a.id] as any).providerRecoveryCursor=value;assert.throws(()=>validateExternalState(state));}
 const b=await f.start('second');const state=f.store.transaction(s=>s);(state.actions[b.id] as any).providerRecoveryCursor=cursor;assert.throws(()=>validateExternalState(state));
 const before=f.calls.length;assert.equal(await f.transport.inspect({...f.invocation,providerRecoveryCursor:cursor} as any,{provider:'github',token:'fixture-token'}),null);assert.equal(f.calls.length,before);
 }finally{f.close();}
});
test('untrusted next link cannot cause HTTP or durable cursor progress',async()=>{
 const f=fixture();try{f.badLink();const a=await f.start();const result=await f.broker.reconcile(a.id);assert.equal(result.status,'ambiguous');assert.equal((result as any).providerRecoveryCursor,undefined);assert.equal(f.calls.length,2);}finally{f.close();}
});

test('end without match clears cursor and next tick starts a fresh anchored scan',async()=>{
 const f=fixture();try{f.noMatch();const a=await f.start();await f.broker.reconcile(a.id);assert.equal(typeof (f.broker.getAction(a.id) as any).providerRecoveryCursor,'string');
 await f.broker.reconcile(a.id);assert.equal((f.broker.getAction(a.id) as any).providerRecoveryCursor,undefined);assert.equal(f.broker.getAction(a.id).reservedMicros,10);
 await f.broker.reconcile(a.id);assert.equal(f.calls.filter(c=>c.includes('/git/ref/')).length,2);assert.equal(f.calls.filter(c=>c.includes('/commits?')).length,3);
 }finally{f.close();}
});
test('canonical empty R2 file reaches GitHub and HF write payloads',async()=>{
 for(const provider of ['github','hf'] as const){
  const file=await loader().load(externalArtifactDigest(artifact));const base=oid(1),commit=oid(2),tree=oid(3);let invocation:ExternalInvocation;let payload:any;let posted=false;
  const transport=createExternalProviderTransport({enabled:true,github:{enabled:true,repository:'fixture/repo',branch:'main'},hf:{enabled:true,repository:'fixture/repo',revision:'main'},artifacts:loader(),now:()=>1000,fetch:async(url,init)=>{
   const path=new URL(String(url)).pathname;const marker='hivemind:'+sha(JSON.stringify([invocation.ownershipToken,invocation.idempotencyKey,invocation.parametersHash]));
   if(init?.method==='POST'){posted=true;payload=provider==='github'?JSON.parse(String(init.body)):String(init.body).trim().split('\n').map(line=>JSON.parse(line));return Response.json(provider==='github'?{data:{createCommitOnBranch:{commit:{oid:commit}}}}:{commitOid:commit});}
   if(provider==='hf'){if(path.includes('/commits/'))return Response.json(posted?[{id:commit,title:marker}]:[]);return Response.json({private:true,sha:posted?commit:base,siblings:[{rfilename:'empty.txt',blobId:createHash('sha1').update('blob 0\0').digest('hex')}]});}
   if(path.includes('/git/ref/'))return Response.json({object:{sha:base}});
   if(path.includes('/git/trees/'))return Response.json({sha:tree,truncated:false,tree:[{path:'empty.txt',type:'blob',mode:'100644',sha:createHash('sha1').update('blob 0\0').digest('hex')}]});
   return Response.json({sha:path.endsWith(commit)?commit:base,message:marker,parents:[{sha:base}],tree:{sha:tree}});
  }});
  const p:ExternalProfile=provider==='github'?profile:{...profile,provider:'hf',target:{repository:'fixture/repo',revision:'main'},operations:['hf.model.commit']};
  const store=createExternalStore(':memory:');try{
   const broker:ExternalBroker<import('../packages/adapters/src/autonomous-external.ts').ExternalProviderCredential>=new ExternalBroker({store,registry:{get:():ExternalProfile=>p},now:()=>1000,resolver:{async withCredential<T>(_r:unknown,_s:unknown,consume:(c:any)=>Promise<T>){return consume({provider,token:'fixture-token'});}},transport:{...transport,async execute(i:ExternalInvocation,c:any,authority?:import('../packages/core/src/autonomous-external.ts').ExternalDispatchAuthority){invocation=i;return transport.execute(i,c,authority);}}});
   broker.serverApprove({taskId:'task',revision:1,profileId:p.id,endsAt:100000,budgetMicros:100});
   const result=await broker.execute({taskId:'task',revision:1,profileId:p.id,requestId:'empty',...(provider==='github'?{operation:'github.branch.push',parameters:{artifactDigest:externalArtifactDigest(file),expectedHead:base}}:{operation:'hf.model.commit',parameters:{artifactDigest:externalArtifactDigest(file),message:'empty file'}})} as any);
   assert.equal(result.status,'succeeded');assert.equal(result.billingFinal,false);
   assert.equal(provider==='github'?payload.variables.input.fileChanges.additions[0].contents:payload[1].value.content,'');
  }finally{store.close();}
 }
});
test('empty file change retains provider path and canonical base64 guards before writes',async()=>{
 for(const files of [[{path:'credentials.txt',contentBase64:''}],[{path:'okay.txt',contentBase64:'Zg'}],[{path:'../outside',contentBase64:''}]]){
  const a={files};let calls=0;const p:ExternalProfile={...profile,provider:'hf',target:{repository:'fixture/repo',revision:'main'},operations:['hf.model.commit']};
  const transport=createExternalProviderTransport({enabled:true,hf:{enabled:true,repository:'fixture/repo',revision:'main'},artifacts:loader(a),now:()=>1000,fetch:async()=>{calls++;throw Error('no HTTP');}});
  const store=createExternalStore(':memory:');try{const broker:ExternalBroker<import('../packages/adapters/src/autonomous-external.ts').ExternalProviderCredential>=new ExternalBroker({store,registry:{get:():ExternalProfile=>p},now:()=>1000,resolver:{async withCredential<T>(_r:unknown,_s:unknown,consume:(c:any)=>Promise<T>){return consume({provider:'hf',token:'fixture-token'});}},transport});
   broker.serverApprove({taskId:'task',revision:1,profileId:p.id,endsAt:100000,budgetMicros:100});await broker.execute({taskId:'task',revision:1,profileId:p.id,requestId:'bad',operation:'hf.model.commit',parameters:{artifactDigest:externalArtifactDigest(a),message:'test'}});assert.equal(calls,0);
  }finally{store.close();}
 }
});
