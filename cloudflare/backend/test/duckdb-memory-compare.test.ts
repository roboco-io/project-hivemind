import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const helper=resolve(import.meta.dirname,'../scripts/duckdb-pilot/compare-memory.py');
const driver=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
x=json.load(sys.stdin)
try:r=m.compare_query(x['left'].encode(),x['leftSchema'].encode(),x['right'].encode(),x['rightSchema'].encode())
except Exception as e:r={'error':str(e)}
print(json.dumps(r))`;
function compare(left:string,right:string,kind='DECIMAL(38,12)',rightKind=kind){
 const schema=(t:string)=>JSON.stringify([{column_name:'value',column_type:t}]);
 const p=spawnSync('python3',['-c',driver,helper],{input:JSON.stringify({left,right,leftSchema:schema(kind),rightSchema:schema(rightKind)}),encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
test('integers and decimals remain exact while floats use only the frozen tolerance',()=>{
 assert.equal(compare('[{"value":1234567890123456789.123456789}]','[{"value":1234567890123456789.123456789}]').passed,true);
 assert.equal(compare('[{"value":0}]','[{"value":0.000000009}]').passed,false);
 assert.equal(compare('[{"value":0}]','[{"value":0.000000009}]','DOUBLE').passed,true);
 assert.equal(compare('[{"value":0}]','[{"value":0.00000002}]','DOUBLE').passed,false);
 assert.equal(compare('[{"value":1000000000}]','[{"value":1000000000.0005}]','FLOAT').passed,true);
 assert.equal(compare('[{"value":1}]','[{"value":1.0}]','BIGINT').passed,false);
});
test('schema names/types, ordered rows, duplicate keys and strings cannot be normalized away',()=>{
 assert.equal(compare('[{"value":1}]','[{"value":1}]','BIGINT','DOUBLE').reason,'schema-name-order-or-type');
 assert.equal(compare('[{"value":1},{"value":2}]','[{"value":2},{"value":1}]','INTEGER').passed,false);
 assert.equal(compare('[{"value":"A"}]','[{"value":"a"}]','VARCHAR').passed,false);
 assert.equal(compare('[{"value":1}]','[{"value":1,"value":1}]','INTEGER').error,'duplicate-json-key');
 assert.equal(compare('[{"value":null}]','[{"value":null}]','UNKNOWN').error,'unsupported-column-type');
});
test('cross-memory comparison requires an explicit flag and the same binary',()=>{
 const code=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
base={'sourceCommit':m.COMMIT,'sf':30,'memoryGiB':6,'threads':4,'datasetSha256':'a'*64,'querySourceSha256':{'11':'b'*64},'shards':m.SHARDS,'floatComparison':m.FLOAT_POLICY,'binarySha256':'c'*64}
candidate={**base,'memoryGiB':3}
out=[]
for allow,different in [(False,False),(True,False),(True,True)]:
 right={**candidate,'binarySha256':'d'*64} if different else candidate
 try:out.append(m.validate_comparison_inputs(base,right,allow))
 except Exception as e:out.append(str(e))
print(json.dumps(out))`;
 const p=spawnSync('python3',['-c',code,helper],{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),['comparison-inputs-differ',true,'tuning-binary-differs']);
});
