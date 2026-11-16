import test from 'node:test';
import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {syntheticTerraStream} from '../src/terra-gateway.ts';
import {replayTerraWire,wireReplayTurns} from '../src/runtime/terra-wire-replay.ts';

test('wire replay preserves the payload and records ordered SSE boundaries',async t=>{
 const root=await mkdtemp(join(tmpdir(),'terra-replay-'));
 try{
  const bodies=Array.from({length:wireReplayTurns},(_,i)=>JSON.stringify({
   model:'gpt-6.1-terra',reasoning:{effort:'medium'},stream:true,store:false,
   prompt_cache_key:'11111111-1111-4111-8111-111111111111',input:[{role:'user',content:String(i)}],
  }));
  await writeFile(join(root,'requests.json'),JSON.stringify(bodies));
  let calls=0;
  t.mock.method(globalThis,'fetch',async (url:string,init:RequestInit)=>{
   assert.equal(init.body,bodies[calls++]);
   const parsed=new URL(url);
   channel('undici:request:bodySent').publish({request:{origin:parsed.origin,path:parsed.pathname,method:'POST'}});
   return syntheticTerraStream();
  });
  const rows=await replayTerraWire(root,{access:'fixture'},AbortSignal.timeout(10000));
  assert.equal(rows.length,wireReplayTurns);
  for(const [i,row] of rows.entries()){
   assert.equal(row.error,undefined);
   assert.equal(row.bodySha256,createHash('sha256').update(bodies[i]!).digest('hex'));
   assert.ok(row.sentMs!<=row.headersMs!&&row.headersMs!<=row.firstTokenMs!&&row.firstTokenMs!<=row.completionMs!);
   assert.equal(row.input,123);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
