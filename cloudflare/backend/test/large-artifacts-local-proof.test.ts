import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createFileBackedArtifactFetch} from '../scripts/large-artifacts/local-proof.ts';

async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'hvm-file-fetch-test-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const capability='hma_'+'0'.repeat(64);
const options=()=>({redirect:'error' as const,headers:{authorization:'Bearer '+capability},signal:AbortSignal.timeout(1000)});

test('local proof transport pulls at most64KiB only on demand and hashes the exact file',async()=>fixture(async root=>{
 const bytes=Buffer.alloc(1024*1024+17,71),file=join(root,'data');await writeFile(file,bytes);
 const factory=createFileBackedArtifactFetch([{name:'data',path:file,sha256:hash(bytes),sizeBytes:bytes.length}],capability);
 const response=await factory.fetch('https://hivemind-artifacts.invalid/'+hash(bytes),options());
 await setImmediate();assert.equal(factory.stats.requests[0]!.servedBytes,0);
 assert.equal(response.headers.get('content-length'),String(bytes.length));const reader=response.body!.getReader();const h=createHash('sha256');let total=0;
 while(true){const r=await reader.read();if(r.done)break;assert.ok(r.value.length<=65536);h.update(r.value);total+=r.value.length;await setImmediate();}
 assert.equal(total,bytes.length);assert.equal(h.digest('hex'),hash(bytes));assert.equal(factory.stats.requests[0]!.servedSha256,hash(bytes));assert.equal(factory.stats.requests[0]!.maxConcurrentReads,1);assert.equal(factory.stats.requests[0]!.closed,true);
 assert.equal(JSON.stringify(factory.stats).includes(capability),false);assert.deepEqual(await readFile(file),bytes);
}));

test('local proof transport rejects wrong origin, digest, authorization and redirection mode',async()=>fixture(async root=>{
 const bytes=Buffer.from('data'),file=join(root,'data');await writeFile(file,bytes);const factory=createFileBackedArtifactFetch([{name:'data',path:file,sha256:hash(bytes),sizeBytes:bytes.length}],capability);
 const url='https://hivemind-artifacts.invalid/'+hash(bytes);
 for(const [target,opt] of [[url.replace('hivemind-artifacts.invalid','elsewhere.invalid'),options()],[url+'?x=1',options()],['https://hivemind-artifacts.invalid/'+'a'.repeat(64),options()],[url,{...options(),headers:{authorization:'Bearer wrong'}}],[url,{...options(),redirect:'follow'}]] as const){await assert.rejects(factory.fetch(target,opt),/Local artifact request rejected/);}
 assert.equal(factory.stats.requests.length,0);
}));

test('local proof transport cancellation closes input and stops further reads',async()=>fixture(async root=>{
 const bytes=Buffer.alloc(200000,1),file=join(root,'data');await writeFile(file,bytes);const factory=createFileBackedArtifactFetch([{name:'data',path:file,sha256:hash(bytes),sizeBytes:bytes.length}],capability);
 const response=await factory.fetch('https://hivemind-artifacts.invalid/'+hash(bytes),options());const reader=response.body!.getReader();await reader.read();await reader.cancel();
 assert.equal(factory.stats.requests[0]!.closed,true);assert.equal(factory.stats.requests[0]!.servedBytes,65536);assert.equal(factory.stats.requests[0]!.servedSha256,undefined);
}));
