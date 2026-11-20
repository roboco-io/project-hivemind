import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {foldToolAuditSpool,appendToolAuditLine} from '../src/runtime/tool-audit-spool.ts';
const D='a'.repeat(64);
const s=(id:string|undefined,at:number,extra:object={})=>JSON.stringify({v:1,t:'s',...(id?{id}:{}),tool:'Bash',digest:D,summary:'ls',truncated:false,outcome:'allowed',at,...extra})+'\n';
test('fold pairs start and end, assigns sequences',()=>{
 const raw=s('t1',1000)+s('t2',1100,{sub:true})+JSON.stringify({v:1,t:'e',id:'t1',ok:true,at:1250})+'\n'+JSON.stringify({v:1,t:'e',id:'t2',ok:false,at:1105})+'\n'+s('t3',1200,{outcome:'denied'});
 const r=foldToolAuditSpool(raw);
 assert.equal(r.droppedByWorker,0);
 assert.deepEqual(r.records.map(x=>[x.sequence,x.outcome,x.durationMs,x.subagent]),[[1,'allowed',250,undefined],[2,'error',5,true],[3,'denied',null,undefined]]);
});
test('malformed lines are counted, partial last line ignored, drop markers summed',()=>{
 const raw=s('a',1)+'garbage\n'+JSON.stringify({v:1,t:'d',n:3})+'\n'+s('b',2)+'{"v":1,"t":"s"';
 const r=foldToolAuditSpool(raw);
 assert.equal(r.records.length,2);assert.equal(r.droppedByWorker,4);
});
test('end for unknown id is ignored and sequences are stable on re-fold',()=>{
 const raw=JSON.stringify({v:1,t:'e',id:'zz',ok:true,at:5})+'\n'+s('a',1)+s('b',2);
 const one=foldToolAuditSpool(raw),two=foldToolAuditSpool(raw+s('c',3));
 assert.deepEqual(two.records.slice(0,2),one.records);assert.equal(two.records[2]!.sequence,3);
});
test('oversized record is dropped',()=>{
 const r=foldToolAuditSpool(s('a',1,{summary:'x'.repeat(2000)}));
 assert.equal(r.records.length,0);assert.equal(r.droppedByWorker,1);
});
test('append respects limit with a drop marker and rejects unsafe files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit-')),p=join(dir,'sub','spool.jsonl');
 assert.deepEqual(await appendToolAuditLine(p,'{"a":1}',20),{dropped:false});
 assert.deepEqual(await appendToolAuditLine(p,'{"b":2222222222}',20),{dropped:true});
 assert.equal(await readFile(p,'utf8'),'{"a":1}\n{"v":1,"t":"d","n":1}\n');
 const loose=join(dir,'loose.jsonl');await writeFile(loose,'');await chmod(loose,0o644);
 await assert.rejects(appendToolAuditLine(loose,'x'));
});
test('append refuses a symlinked spool and a hard-linked spool, leaving the target untouched',async()=>{
 const {symlink,link}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'audit-')),target=join(dir,'target.txt');await writeFile(target,'keep',{mode:0o600});
 const sym=join(dir,'sym.jsonl');await symlink(target,sym);
 await assert.rejects(appendToolAuditLine(sym,'{"a":1}'));
 const hard=join(dir,'hard.jsonl');await link(target,hard);
 await assert.rejects(appendToolAuditLine(hard,'{"a":1}'));
 assert.equal(await readFile(target,'utf8'),'keep');
});
