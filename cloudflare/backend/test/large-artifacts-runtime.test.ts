import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtemp,readFile,writeFile,rm,readdir,stat,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareLargeArtifacts,extractTarArchive,type ArtifactRef} from '../src/runtime/large-artifacts.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
interface Entry {name:string;content?:string;type?:string;size?:number;link?:string}
function archive(entries:Entry[],trailer=Buffer.alloc(1024)){
 const chunks:Buffer[]=[];
 for(const entry of entries){
  const content=Buffer.from(entry.content??''),head=Buffer.alloc(512);
  head.write(entry.name,0,100,'utf8');head.write('0000644\0',100);head.write('0000000\0',108);head.write('0000000\0',116);
  head.write((entry.size??content.length).toString(8).padStart(11,'0')+'\0',124);head.write('00000000000\0',136);head.fill(32,148,156);head.write(entry.type??'0',156);head.write(entry.link??'',157,100);head.write('ustar\0',257);head.write('00',263);
  const checksum=[...head].reduce((sum,n)=>sum+n,0);head.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
  chunks.push(head,content,Buffer.alloc((512-content.length%512)%512));
 }
 return gzipSync(Buffer.concat([...chunks,trailer]));
}
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'hvm-large-test-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const ref=(data:Uint8Array,format:'file'|'tar.gz'='file'):ArtifactRef=>({name:format==='file'?'data':'source',sha256:sha(data),sizeBytes:data.length,format,expandedBytes:format==='file'?data.length:1024,maxFiles:format==='file'?1:20});
const mock=(data:Uint8Array):typeof fetch=>async()=>new Response(data as BodyInit);

test('large file is streamed with exact size/hash and publishes only after verification',async()=>fixture(async root=>{
 const data=Buffer.alloc(3*1024*1024+11,53);const calls:any[]=[];
 const fetchImpl:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(new ReadableStream({start(c){for(let i=0;i<data.length;i+=16384)c.enqueue(data.subarray(i,i+16384));c.close();}}));};
 const result=await prepareLargeArtifacts({refs:[ref(data)],capability:'capability-test'}, {directory:join(root,'inputs'),fetchImpl});
 assert.deepEqual(await readFile(result.paths.data!),data);assert.equal(result.receipts[0]!.sha256,sha(data));
 assert.equal(calls[0].url,'https://hivemind-artifacts.invalid/'+sha(data));assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.authorization,'Bearer capability-test');
 assert.equal(JSON.stringify(result).includes('capability-test'),false);
 assert.equal((await readdir(join(root,'inputs'))).some(p=>p.includes('stage')),false);
}));

test('wrong digest, short body, long body and failed response leave no published inputs',async()=>fixture(async root=>{
 const data=Buffer.from('payload'),good=ref(data);
 for(const [i,item] of [{r:{...good,sha256:'0'.repeat(64)},bytes:data},{r:{...good,sizeBytes:data.length+1,expandedBytes:data.length+1},bytes:data},{r:{...good,sizeBytes:data.length-1,expandedBytes:data.length-1},bytes:data}].entries()){
  const directory=join(root,String(i));await assert.rejects(prepareLargeArtifacts({refs:[item.r],capability:'private-token'},{directory,fetchImpl:mock(item.bytes)}),/artifact/i);assert.deepEqual(await readdir(directory),[]);
 }
 const directory=join(root,'http');await assert.rejects(prepareLargeArtifacts({refs:[good],capability:'private-token'},{directory,fetchImpl:async()=>new Response('private-token',{status:403})}),/artifact/i);assert.deepEqual(await readdir(directory),[]);
}));

test('cancellation cancels a streaming reader and removes incomplete files',async()=>fixture(async root=>{
 const controller=new AbortController();let cancelled=false;
 const fetchImpl:typeof fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('a'));setTimeout(()=>controller.abort(),20);},cancel(){cancelled=true;}}));
 const directory=join(root,'inputs');await assert.rejects(prepareLargeArtifacts({refs:[ref(Buffer.from('abc'))],capability:'private-token'},{directory,signal:controller.signal,fetchImpl,timeoutMs:1000}),/artifact/i);
 assert.equal(cancelled,true);assert.deepEqual(await readdir(directory),[]);
}));

test('safe tar extracts a normal archive and supports validated root stripping',async()=>fixture(async root=>{
 const data=archive([{name:'repo/',type:'5'},{name:'repo/src/',type:'5'},{name:'repo/src/main.cpp',content:'int main(){}\n'}]);const path=join(root,'source.tgz');await writeFile(path,data);
 const result=await extractTarArchive(path,join(root,'source'),{maxBytes:100,maxFiles:10,stripComponents:1});assert.equal(result.files,1);assert.equal(result.expandedBytes,13);assert.equal(await readFile(join(root,'source/src/main.cpp'),'utf8'),'int main(){}\n');
 const prepared=await prepareLargeArtifacts({refs:[ref(data,'tar.gz')],capability:'test'},{directory:join(root,'prepared'),fetchImpl:mock(data)});assert.equal(await readFile(join(prepared.paths.source!,'repo/src/main.cpp'),'utf8'),'int main(){}\n');
}));

test('tar refuses escape paths, links, devices, duplicate and ancestor collisions',async()=>fixture(async root=>{
 const cases:Entry[][]=[
  [{name:'../escape',content:'x'}],[{name:'/absolute',content:'x'}],[{name:'a/../escape',content:'x'}],[{name:'a\\escape',content:'x'}],
  [{name:'link',type:'2',link:'../outside'}],[{name:'hard',type:'1',link:'/etc/passwd'}],[{name:'device',type:'3'}],
  [{name:'same',content:'a'},{name:'same',content:'b'}],[{name:'A',content:'a'},{name:'a',content:'b'}],
  [{name:'a',content:'file'},{name:'a/b',content:'child'}],[{name:'a/b',content:'child'},{name:'a',content:'file'}],
 ];
 for(const [i,entries] of cases.entries()){
  const path=join(root,`${i}.tgz`),dst=join(root,`out-${i}`);await writeFile(path,archive(entries));await assert.rejects(extractTarArchive(path,dst,{maxBytes:1024,maxFiles:20}),/archive/i);await assert.rejects(stat(dst));
 }
 await assert.rejects(stat(join(root,'escape')));
}));

test('tar rejects payload/file limits, malformed header, truncated archive and gzip padding bomb',async()=>fixture(async root=>{
 const cases=[
  {data:archive([{name:'big',content:'a'.repeat(4096)}]),maxBytes:1024,maxFiles:10},
  {data:archive([{name:'a',content:'a'},{name:'b',content:'b'}]),maxBytes:100,maxFiles:1},
  {data:gzipSync(Buffer.alloc(512,42)),maxBytes:100,maxFiles:10},
  {data:archive([{name:'short',content:'a',size:10000}],Buffer.alloc(0)),maxBytes:20000,maxFiles:10},
  {data:archive([{name:'ok',content:'a'}],Buffer.alloc(4*1024*1024)),maxBytes:100,maxFiles:10},
 ];
 for(const [i,c] of cases.entries()){const path=join(root,`${i}.tgz`),dst=join(root,`out-${i}`);await writeFile(path,c.data);await assert.rejects(extractTarArchive(path,dst,c),/archive/i);await assert.rejects(stat(dst));}
}));

test('existing destination or symlink preparation parent is not overwritten',async()=>fixture(async root=>{
 const path=join(root,'a.tgz'),dst=join(root,'existing');await writeFile(path,archive([{name:'a',content:'x'}]));await mkdir(dst);await writeFile(join(dst,'keep'),'safe');await assert.rejects(extractTarArchive(path,dst,{maxBytes:100,maxFiles:10}),/archive/i);assert.equal(await readFile(join(dst,'keep'),'utf8'),'safe');
 await symlink(dst,join(root,'link'));await assert.rejects(prepareLargeArtifacts({refs:[ref(Buffer.from('x'))],capability:'test'},{directory:join(root,'link'),fetchImpl:mock(Buffer.from('x'))}),/artifact/i);
}));

test('failed helper never deletes a destination it did not mark as its own',async()=>fixture(async root=>{
 const program=join(root,'foreign-helper');await writeFile(program,'#!/usr/bin/env python3\nimport os,sys\np=sys.argv[sys.argv.index("--destination")+1]\nos.mkdir(p)\nopen(p+"/keep","w").write("unowned")\nsys.exit(1)\n',{mode:0o700});
 const path=join(root,'source.tgz'),dst=join(root,'destination');await writeFile(path,archive([{name:'a',content:'a'}]));
 await assert.rejects(extractTarArchive(path,dst,{maxBytes:100,maxFiles:10,pythonCommand:program}),/archive/i);
 assert.equal(await readFile(join(dst,'keep'),'utf8'),'unowned');
}));

function pax(key:string,value:string){const body=key+'='+value+'\n';let length=Buffer.byteLength(body)+2;while(Buffer.byteLength(String(length)+' '+body)!==length)length=Buffer.byteLength(String(length)+' '+body);return String(length)+' '+body;}
test('bounded PAX paths work while metadata bombs, escapes and sparse formats fail closed',async()=>fixture(async root=>{
 const long='repo/'+('n'.repeat(180));const valid=archive([{name:'pax_global_header',type:'g',content:pax('comment','fixed-public-revision')},{name:'pax',type:'x',content:pax('path',long)},{name:'short',content:'ok'}]);
 const path=join(root,'valid.tgz');await writeFile(path,valid);await extractTarArchive(path,join(root,'valid'),{maxBytes:100,maxFiles:10});assert.equal(await readFile(join(root,'valid',long),'utf8'),'ok');
 const cases=[
  archive([{name:'pax',type:'x',size:100*1024*1024}]),
  archive([{name:'pax',type:'x',content:pax('path','../escape')},{name:'safe',content:'x'}]),
  archive([{name:'pax',type:'x',content:pax('path','safe')},{name:'../escape',content:'x'}]),
  archive([{name:'pax',type:'x',content:pax('GNU.sparse.map','0,1')},{name:'safe',content:'x'}]),
  archive([{name:'pax',type:'x',content:pax('path','one')+pax('path','two')},{name:'safe',content:'x'}]),
  archive([{name:'long',type:'L',content:'a'.repeat(1000)}]),
  archive([{name:'.hivemind-extraction-owner',content:'fake'}]),
 ];
 for(const [i,data] of cases.entries()){const a=join(root,`bad-${i}.tgz`),dst=join(root,`bad-${i}`);await writeFile(a,data);await assert.rejects(extractTarArchive(a,dst,{maxBytes:1024,maxFiles:20}),/archive/i);await assert.rejects(stat(dst));}
}));

test('a later artifact failure never publishes an earlier valid source',async()=>fixture(async root=>{
 const source=archive([{name:'repo/main.cpp',content:'source'}]),data=Buffer.from('data');const directory=join(root,'inputs');
 const bad={...ref(data),sha256:'0'.repeat(64)};
 await assert.rejects(prepareLargeArtifacts({refs:[ref(source,'tar.gz'),bad],capability:'private-capability'},{directory,fetchImpl:async url=>new Response((String(url).endsWith(sha(source))?source:data) as BodyInit)}),error=>error instanceof Error&&!error.message.includes('private-capability'));
 assert.deepEqual(await readdir(directory),[]);
}));

test('compressed hash verification precedes any extraction helper',async()=>fixture(async root=>{
 const path=join(root,'sentinel'),flag=join(root,'ran');await writeFile(path,`#!/usr/bin/env python3\nopen(${JSON.stringify(flag)},"w").write("ran")\n`,{mode:0o700});
 const source=archive([{name:'repo/source',content:'source'}]);await assert.rejects(prepareLargeArtifacts({refs:[{...ref(source,'tar.gz'),sha256:'0'.repeat(64)}],capability:'private-capability'},{directory:join(root,'inputs'),fetchImpl:mock(source),pythonCommand:path}),/artifact/i);
 await assert.rejects(stat(flag));
}));
