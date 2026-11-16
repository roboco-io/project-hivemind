import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const helper=resolve(import.meta.dirname,'../scripts/duckdb-pilot/query_output.py');
const sql='SELECT v FROM t WHERE FALSE;\n';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'hvm-empty-query-'));const put=(name:string,value:any)=>writeFileSync(join(root,name),JSON.stringify(value));
 writeFileSync(join(root,'query-11.json'),'');put('query-11.schema.json',[{column_name:'v',column_type:'INTEGER'}]);put('shard-0.json',{passed:true,exitCode:0,signal:null,terminationReason:'exit'});put('query-11.profile.json',{rows_returned:0,query_name:sql});put('memory-batch-settings.json',{sourceCommit:'68d7555f68bd25c1a251ccca2e6338949c33986a',querySourceSha256:{'11':createHash('sha256').update(sql).digest('hex')}});
 return {root,put,run:()=>spawnSync('python3',[helper,'--run',root,'--queries','11'],{encoding:'utf8',timeout:5000}),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('empty CLI result needs successful stage, schema and matching zero-row query profile; raw file stays empty',()=>{
 const f=fixture();try{const p=f.run();assert.equal(p.status,0,p.stdout);const r=JSON.parse(p.stdout).outputs[0];assert.equal(r.rows,0);assert.equal(r.normalization.kind,'duckdb-empty-json-zero-rows');assert.equal(r.normalization.profileRowsReturned,0);assert.equal(readFileSync(join(f.root,'query-11.json')).length,0);}finally{f.close();}
});
test('missing, whitespace, invalid profile, nonzero rows, wrong query and failed stage are never normalized',()=>{
 const changes=[
  (f:ReturnType<typeof fixture>)=>unlinkSync(join(f.root,'query-11.json')),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.root,'query-11.json'),' \n'),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.root,'query-11.profile.json'),'not-json'),
  (f:ReturnType<typeof fixture>)=>f.put('query-11.profile.json',{rows_returned:1,query_name:sql}),
  (f:ReturnType<typeof fixture>)=>f.put('query-11.profile.json',{rows_returned:false,query_name:sql}),
  (f:ReturnType<typeof fixture>)=>f.put('query-11.profile.json',{rows_returned:0,query_name:'SELECT different;'}),
  (f:ReturnType<typeof fixture>)=>f.put('shard-0.json',{passed:false,exitCode:1,signal:null,terminationReason:'exit'}),
  (f:ReturnType<typeof fixture>)=>f.put('query-11.schema.json',[]),
 ];
 for(const change of changes){const f=fixture();try{change(f);assert.equal(f.run().status,1);}finally{f.close();}}
});
