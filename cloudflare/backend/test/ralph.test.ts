import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {executeRuntime} from '../src/runtime/run.ts';
import {createBootstrap} from '../src/runtime/bootstrap.ts';
import {createSnapshot,sha256} from '../src/snapshot.ts';

for(const resumeFails of [false,true])test(resumeFails?'Ralph preserves the accepted session identity and auth envelope when a resume has no result':'Ralph retries the same Codex session after independent verification rejects a checkpoint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hivemind-ralph-'));
 const runtimeDir=join(root,'runtime'),workspace=join(root,'workspace'),home=join(root,'home');
 const script=join(root,'codex');
 const session='11111111-1111-4111-8111-111111111111';
 const token='f'.repeat(64);
 await writeFile(script,`#!${process.execPath}
 const fs=require('node:fs');
 const resume=process.argv.includes('resume')&&process.argv.includes('${session}');
 if(resume&&${resumeFails})process.exit(1);
 fs.writeFileSync('add.mjs',resume?'export const add=(a,b)=>a+b;':'export const add=()=>0;');
 console.log(JSON.stringify({type:'thread.started',thread_id:'${session}'}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));
 `,{mode:0o700});
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});
 const value='export const add=()=>null;';
 const input={version:1,jobId:'job',attempt:'attempt',mode:'agent',provider:'codex',instructions:'Fix add',
  snapshot:createSnapshot([{path:'add.mjs',content:Buffer.from(value).toString('base64'),sha256:sha256(value),executable:false}]),
  auth:JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-access-token',refresh_token:'test-refresh-token'}}),
  authReturnPublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),timeoutMs:8000,
  ralph:{token,maxRounds:2,writes:['add.mjs']}};
 const server=createBootstrap(runtimeDir);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('No address');
 const base=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(base+'/prepare',{method:'POST',body:JSON.stringify(input)})).status,201);
  const pending=executeRuntime(input,{runtimeDir,workspace,home,commands:{codex:script}});
  for(let round=1;round<=(resumeFails?1:2);round++){
   let checkpoint:import('../src/contracts.ts').RalphCheckpoint|undefined;
   for(let attempt=0;attempt<100;attempt++){
    const r=await fetch(base+'/ralph/checkpoint',{headers:{'x-hivemind-ralph':token}});
    if(r.ok){const value=await r.json() as typeof checkpoint;if(value?.round===round){checkpoint=value;break;}}
    await delay(30);
   }
   assert.equal(checkpoint?.sessionId,session);
   assert.equal((await fetch(base+'/ralph/checkpoint')).status,403);
   const body=JSON.stringify({round,snapshotId:checkpoint!.snapshot.digest,accepted:round===2,message:'Check result'});
   assert.equal((await fetch(base+'/ralph/feedback',{method:'POST',body})).status,403);
   const request=()=>fetch(base+'/ralph/feedback',{method:'POST',body,headers:{'x-hivemind-ralph':token}});
   assert.equal((await request()).status,200);
   assert.equal((await request()).status,200);
  }
  const result=await pending;
  assert.equal(result.sessionId,session);
  assert.ok(result.authReturn);
  if(resumeFails){
   assert.equal(result.process.status,'failed');
   assert.deepEqual(result.ralphRounds?.map(round=>round.accepted),[false]);
   return;
  }
  assert.equal(result.process.status,'passed');
  assert.deepEqual(result.ralphRounds?.map(round=>[round.round,round.sessionId,round.accepted]),[[1,session,false],[2,session,true]]);
  assert.equal(await readFile(join(workspace,'add.mjs'),'utf8'),'export const add=(a,b)=>a+b;');
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
