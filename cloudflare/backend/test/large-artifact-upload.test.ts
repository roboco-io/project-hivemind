import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {uploadLargeArtifact} from '../scripts/large-artifacts/upload.ts';
test('operator uploader detects mutable source and aborts without publishing it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'large-upload-')),prior=globalThis.fetch,calls:string[]=[];
 const file=join(root,'data'),secret=join(root,'control.json');await writeFile(file,'abc');await writeFile(secret,JSON.stringify({CONTROL_TOKEN:'fixture-control'}),{mode:0o600});
 try{
  globalThis.fetch=async(input,init)=>{
   const path=new URL(String(input)).pathname;calls.push(path);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-control');
   if(path==='/v1/large-artifact-uploads'){await writeFile(file,'def');return Response.json({id:'11111111-1111-4111-8111-111111111111',parts:[]});}
   return Response.json({ok:true});
  };
  await assert.rejects(uploadLargeArtifact(file,{name:'data',format:'file',expandedBytes:3,maxFiles:1},'https://fixture',secret),/changed/);
  assert.ok(calls.some(p=>p.endsWith('/abort')));assert.ok(!calls.some(p=>p.endsWith('/complete')));
  calls.length=0;await chmod(secret,0o644);
  await assert.rejects(uploadLargeArtifact(file,{name:'data',format:'file',expandedBytes:3,maxFiles:1},'https://fixture',secret),/Private/);assert.equal(calls.length,0);
 }finally{globalThis.fetch=prior;await rm(root,{recursive:true,force:true});}
});
