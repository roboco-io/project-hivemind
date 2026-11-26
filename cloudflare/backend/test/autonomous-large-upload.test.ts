import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,link,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadWorkspaceFiles,LARGE_PART_BYTES,type LargePost} from '../src/runtime/autonomous-large-upload.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
interface Log{op:string;body:any}
// Swappable fixture: the fake control-plane stands in for the HTTP binding of
// external-large/{begin,part,complete,abort,manifest} (owned by p4a). SUPERLITE_REAL=1
// has no wired real counterpart in this file; the seam is the single LargePost function.
function fakePost(opts:{stored?:(file:{path:string;size:number;sha256:string})=>{partNumber:number;sha256:string}[];onPart?:(n:number)=>void}={}){
  const log:Log[]=[];const uploads=new Map<string,{path:string;size:number;sha256:string}>();
  const post:LargePost=(async(op:string,body:any)=>{
    log.push({op,body:op==='part'?{...body,data:{len:body.data.byteLength,sha:sha(body.data)}}:body});
    if(op==='begin'){const id='u-'+body.path;uploads.set(id,body);return {uploadId:id,parts:opts.stored?.(body)??[]};}
    if(op==='part'){opts.onPart?.(body.partNumber);return {};}
    if(op==='complete'){const f=uploads.get(body.uploadId)!;return {path:f.path,size:f.size,sha256:f.sha256,storageRef:`external-large/${'a'.repeat(64)}/${f.sha256}`};}
    if(op==='manifest')return {manifestDigest:'e'.repeat(64)};
    return {};
  }) as LargePost;
  return {post,log};
}
async function workspace(){const root=await mkdtemp(join(tmpdir(),'large-upload-'));return {root,done:()=>rm(root,{recursive:true,force:true})};}

test('upload: small file hashes while streaming and completes into a manifest',async()=>{
  const w=await workspace();try{
    await mkdir(join(w.root,'m'));const data=Buffer.from('hello large');await writeFile(join(w.root,'m/a.bin'),data);
    const f=fakePost();
    const r=await uploadWorkspaceFiles({root:w.root,paths:['m/a.bin'],post:f.post});
    assert.deepEqual(r,{manifestDigest:'e'.repeat(64)});
    assert.deepEqual(f.log.map(l=>l.op),['begin','part','complete','manifest']);
    assert.deepEqual(f.log[0]!.body,{path:'m/a.bin',size:data.byteLength,sha256:sha(data)});
    assert.equal(f.log[1]!.body.partNumber,1);assert.equal(f.log[1]!.body.data.sha,sha(data));
    assert.equal(f.log[3]!.body.files[0].storageRef,`external-large/${'a'.repeat(64)}/${sha(data)}`);
  }finally{await w.done();}
});

test('upload: file over one part is split in 8 MiB parts and stored parts are skipped',async()=>{
  const w=await workspace();try{
    const data=Buffer.alloc(LARGE_PART_BYTES+5,7);await writeFile(join(w.root,'big.bin'),data);
    const first=sha(data.subarray(0,LARGE_PART_BYTES));
    const f=fakePost({stored:()=>[{partNumber:1,sha256:first}]});
    await uploadWorkspaceFiles({root:w.root,paths:['big.bin'],post:f.post});
    const parts=f.log.filter(l=>l.op==='part');
    assert.deepEqual(parts.map(p=>p.body.partNumber),[2]);assert.equal(parts[0]!.body.data.len,5);
    // A stored part whose hash differs is uploaded again.
    const g=fakePost({stored:()=>[{partNumber:1,sha256:'0'.repeat(64)}]});
    await uploadWorkspaceFiles({root:w.root,paths:['big.bin'],post:g.post});
    assert.deepEqual(g.log.filter(l=>l.op==='part').map(p=>p.body.partNumber),[1,2]);
    assert.equal(g.log.find(l=>l.op==='part')!.body.data.len,LARGE_PART_BYTES);
  }finally{await w.done();}
});

test('upload: rejects traversal, absolute, empty segments, duplicates before any post',async()=>{
  const w=await workspace();try{
    await writeFile(join(w.root,'ok.bin'),'x');
    for(const paths of [['../x'],['a/../ok.bin'],['/etc/passwd'],['a//b'],['./ok.bin'],['ok.bin','ok.bin'],[''],['ok\0.bin'],[],['a\\b']]){
      const f=fakePost();await assert.rejects(uploadWorkspaceFiles({root:w.root,paths,post:f.post}));assert.equal(f.log.length,0);
    }
  }finally{await w.done();}
});

test('upload: rejects symlink file, symlinked directory, missing and non-regular files',async()=>{
  const w=await workspace();const outside=await workspace();try{
    await writeFile(join(outside.root,'secret.bin'),'secret');
    await symlink(join(outside.root,'secret.bin'),join(w.root,'link.bin'));
    await symlink(outside.root,join(w.root,'dir'));
    await mkdir(join(w.root,'real'));await symlink(join(w.root,'real'),join(w.root,'inner'));await writeFile(join(w.root,'real/in.bin'),'x');
    for(const p of ['link.bin','dir/secret.bin','inner/in.bin','missing.bin','real']){
      const f=fakePost();await assert.rejects(uploadWorkspaceFiles({root:w.root,paths:[p],post:f.post}),p);assert.equal(f.log.length,0,p);
    }
  }finally{await w.done();await outside.done();}
});

test('upload: hard link and empty file are rejected',async()=>{
  const w=await workspace();try{
    await writeFile(join(w.root,'a.bin'),'x');await link(join(w.root,'a.bin'),join(w.root,'b.bin'));await writeFile(join(w.root,'empty.bin'),'');
    for(const p of ['a.bin','empty.bin']){const f=fakePost();await assert.rejects(uploadWorkspaceFiles({root:w.root,paths:[p],post:f.post}));assert.equal(f.log.length,0);}
  }finally{await w.done();}
});

test('upload: abort signal stops before the next post',async()=>{
  const w=await workspace();try{
    await writeFile(join(w.root,'a.bin'),Buffer.alloc(LARGE_PART_BYTES*2,1));
    const c=new AbortController();const f=fakePost({onPart:()=>c.abort()});
    await assert.rejects(uploadWorkspaceFiles({root:w.root,paths:['a.bin'],post:f.post,signal:c.signal}));
    assert.equal(f.log.filter(l=>l.op==='part').length,1);
    assert.ok(!f.log.some(l=>l.op==='complete'||l.op==='manifest'));
    const pre=new AbortController();pre.abort();const g=fakePost();
    await assert.rejects(uploadWorkspaceFiles({root:w.root,paths:['a.bin'],post:g.post,signal:pre.signal}));assert.equal(g.log.length,0);
  }finally{await w.done();}
});

test('upload: root is resolved once and must be a directory',async()=>{
  const w=await workspace();try{
    await writeFile(join(w.root,'a.bin'),'x');
    const f=fakePost();await assert.rejects(uploadWorkspaceFiles({root:join(w.root,'a.bin'),paths:['a.bin'],post:f.post}));
    await assert.rejects(uploadWorkspaceFiles({root:'relative/dir',paths:['a.bin'],post:f.post}));
    void realpath;
  }finally{await w.done();}
});
