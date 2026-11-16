import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const helper=resolve(import.meta.dirname,'../scripts/duckdb-pilot/oracle.py');
const driver=`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('oracle',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
x=json.load(sys.stdin)
try:
 r=m.compare(x['csv'].encode(),x['actual'].encode(),x['query'])
except Exception as e:r={'rejected':str(e)}
print(json.dumps(r))`;
function compare(csv:string,actual:string,query=9){const p=spawnSync('python3',['-c',driver,helper],{input:JSON.stringify({csv,actual,query}),encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);}
const answer='nation|o_year|sum_profit\nALGERIA|1992|1234567890123456789.123456789\n';
test('oracle preserves arbitrary decimal precision with exact comparison',()=>{
 assert.equal(compare(answer,'[{"nation":"ALGERIA","o_year":1992,"sum_profit":1234567890123456789.123456789}]').passed,true);
 assert.equal(compare(answer,'[{"nation":"ALGERIA","o_year":1992,"sum_profit":1234567890123456789.123456788}]').passed,false);
});
test('oracle rejects column order, row order, integer types, and duplicate keys',()=>{
 assert.equal(compare(answer,'[{"o_year":1992,"nation":"ALGERIA","sum_profit":1234567890123456789.123456789}]').reason,'column-order-or-name');
 assert.equal(compare(answer,'[{"nation":"ALGERIA","o_year":1992.0,"sum_profit":1234567890123456789.123456789}]').reason,'value-or-type');
 assert.equal(compare(answer,'[{"nation":"ALGERIA","nation":"ALGERIA","o_year":1992,"sum_profit":1}]').rejected,'duplicate-json-column');
 const two='nation|o_year|sum_profit\nA|1992|1.00\nB|1993|2.00\n';
 assert.equal(compare(two,'[{"nation":"B","o_year":1993,"sum_profit":2},{"nation":"A","o_year":1992,"sum_profit":1}]').passed,false);
 assert.equal(compare(two,'[]').reason,'row-count');
});
test('query 3, 18 and 21 use exact schemas, including dates',()=>{
 assert.equal(compare('l_orderkey|revenue|o_orderdate|o_shippriority\n1|2.50|1995-03-01|0\n','[{"l_orderkey":1,"revenue":2.5,"o_orderdate":"1995-03-01","o_shippriority":0}]',3).passed,true);
 assert.equal(compare('c_name|c_custkey|o_orderkey|o_orderdate|o_totalprice|sum(l_quantity)\nA|1|2|1995-01-02|3.50|4.00\n','[{"c_name":"A","c_custkey":1,"o_orderkey":2,"o_orderdate":"1995-01-02","o_totalprice":3.5,"sum(l_quantity)":4}]',18).passed,true);
 assert.equal(compare('s_name|numwait\nA|1\n','[{"s_name":"A","numwait":true}]',21).passed,false);
 assert.equal(compare('s_name|numwait\nA|1\n','[{"s_name":"A","numwait":1}]',21).passed,true);
});
test('unsupported scales stay unavailable without reading any reference path',()=>{
 const p=spawnSync('python3',[helper,'--source','/nonexistent','--actual','/nonexistent','--sf','30','--query','9'],{encoding:'utf8',timeout:5000});assert.equal(p.status,2);assert.equal(JSON.parse(p.stdout).passed,null);
});
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
test('reference reads are fixed to the pinned query path and hash-bound manifest',()=>{
 const root=mkdtempSync(join(tmpdir(),'duckdb-oracle-'));
 try{
  const source=join(root,'source'),relative='extension/tpch/dbgen/answers/sf1/q09.csv',reference=join(source,relative),actual=join(root,'actual.json');mkdirSync(join(source,'extension/tpch/dbgen/answers/sf1'),{recursive:true});writeFileSync(reference,answer);writeFileSync(actual,'[{"nation":"ALGERIA","o_year":1992,"sum_profit":1234567890123456789.123456789}]');
  writeFileSync(join(root,'normalization.json'),JSON.stringify({commit:'68d7555f68bd25c1a251ccca2e6338949c33986a',sourceArchiveSha256:'495fe47027a380fc37828dd04be65b2370f68b51872325c78cdeb54d1ec3a2a1',files:[{path:relative,sha256:createHash('sha256').update(answer).digest('hex')}]}));
  const args=[helper,'--source',source,'--actual',actual,'--sf','1','--query','9'];let p=spawnSync('python3',args,{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stdout);
  writeFileSync(reference,answer+'B|1993|2\n');p=spawnSync('python3',args,{encoding:'utf8',timeout:5000});assert.equal(p.status,1);assert.equal(JSON.parse(p.stdout).reason,'reference-hash');
  p=spawnSync('python3',[helper,'--source','/nonexistent','--actual','/nonexistent','--sf','1','--query','0'],{encoding:'utf8',timeout:5000});assert.equal(p.status,1);assert.equal(JSON.parse(p.stdout).reason,'invalid-query-id');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('only pinned SF1 q18 sum(l_quantity) may map to the answer column sum',()=>{
 const csv='c_name|c_custkey|o_orderkey|o_orderdate|o_totalprice|sum\nA|1|2|1995-01-02|3.50|4.00\n';
 const actual='[{"c_name":"A","c_custkey":1,"o_orderkey":2,"o_orderdate":"1995-01-02","o_totalprice":3.5,"sum(l_quantity)":4}]';
 const result=compare(csv,actual,18);assert.equal(result.passed,true);assert.deepEqual(result.columnNormalizations,[{columnIndex:5,reference:'sum',actual:'sum(l_quantity)',reason:'pinned-q18-upstream-answer-alias'}]);
 assert.equal(compare(csv,actual.replace('sum(l_quantity)','quantity'),18).reason,'column-order-or-name');
 assert.equal(compare(csv,actual.replace('"sum(l_quantity)":4','"sum(l_quantity)":5'),18).reason,'value-or-type');
 assert.equal(compare(csv,actual.replace('"c_name":"A","c_custkey":1','"c_custkey":1,"c_name":"A"'),18).reason,'column-order-or-name');
 const other='nation|o_year|sum\nA|1992|4.00\n';assert.equal(compare(other,'[{"nation":"A","o_year":1992,"sum(l_quantity)":4}]',9).reason,'column-order-or-name');
});
