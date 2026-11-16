import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const helper=resolve(import.meta.dirname,'../scripts/duckdb-pilot/summarize.py');
test('SDK and parser failures are not classified from memory pressure observations',()=>{
 const code=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps([m.failure_class('FAILED',None),m.failure_class('STOPPED','batch-task-failed'),m.failure_class('STOPPED','critical-memory-pressure'),m.failure_class('STOPPED','critical-metrics-unavailable')]))`;
 const p=spawnSync('python3',['-c',code,helper],{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),['execution-or-harness-failure-not-attributed-to-resources','execution-or-harness-failure-not-attributed-to-resources','resource-guard-stop','measurement-failure']);
});
test('phase CPU, process RSS and pressure interval coverage keep separate meanings',()=>{
 const code=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rows=[{'startedAt':0,'finishedAt':2000,'cpuUserSeconds':2,'cpuSystemSeconds':1,'wait4MaxRssBytes':100,'passed':True,'terminationReason':'exit'},{'startedAt':1000,'finishedAt':3000,'cpuUserSeconds':2,'cpuSystemSeconds':1,'wait4MaxRssBytes':200,'passed':True,'terminationReason':'exit'}]
print(json.dumps({'stage':m.stage_summary(rows),'pressure':m.pressure_times([{'timestamp':0,'pressureState':'warning'},{'timestamp':2000,'pressureState':'normal'}],0,12000)}))`;
 const p=spawnSync('python3',['-c',code,helper],{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.stage.sumSeconds,4);assert.equal(r.stage.activeUnionSeconds,3);assert.equal(r.stage.peakIntervals,2);assert.equal(r.stage.cpuSeconds,6);assert.equal(r.stage.wait4MaxSingleProcessRssBytes,200);assert.equal(r.pressure.warning,2);assert.equal(r.pressure.normal,5);assert.equal(r.pressure.unobserved,5);
});
test('summary discovers actual comparison naming and never copies source, SQL, credentials or home paths',()=>{
 const code=`import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as t:
 root=Path(t);run=root/'runs'/'sdk-failed';run.mkdir(parents=True)
 (run/'result.json').write_text(json.dumps({'id':'sdk-failed','status':'FAILED','startedAt':0,'finishedAt':1000,'outcome':{'error':'super-secret /Users/private'},'stages':[],'host':{}}))
 (run/'build-settings.json').write_text(json.dumps({'config':'C1','configure':['/Users/private','SELECT private','super-secret']}))
 (root/'environment.json').write_text(json.dumps({'versions':{'clang':'21.0.0 /Users/private super-secret'}}))
 for name in ['a.compare.json','b-compare.json','c-quality.json','d.shared-output-policy.json']:(root/name).write_text(json.dumps({'passed':True,'kind':'same-input-query-equivalence-not-independent-oracle','queryCount':22,'sql':'SELECT private','secret':'super-secret'}))
 result=m.summarize(root);text=json.dumps(result)
 assert '/Users/private' not in text and 'super-secret' not in text and 'SELECT private' not in text
 assert len(result['comparisons'])==4
 assert result['runs'][0]['failureClass']=='execution-or-harness-failure-not-attributed-to-resources'
 assert result['runs'][0]['phaseTimes']['data-generation']['availability']=='not-run'
 print(json.dumps({'comparisons':len(result['comparisons']),'redacted':True}))`;
 const p=spawnSync('python3',['-c',code,helper],{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),{comparisons:4,redacted:true});
});
test('legacy same-memory comparisons use memoryGiB for both sides but tuning requires its pair',()=>{
 const code=`import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as t:
 p=Path(t)/'case-compare.json'
 out=[]
 for record in [{'kind':'same-input-query-equivalence-not-independent-oracle','memoryGiB':6},{'kind':'cross-memory-tuning-query-equivalence','memoryGiB':6},{'kind':'cross-memory-tuning-query-equivalence','baselineMemoryGiB':6,'actualMemoryGiB':3}]:
  p.write_text(json.dumps({'passed':True,**record}));r=m.comparison_summary(p);out.append([r['settings']['baselineMemoryGiB'],r['settings']['actualMemoryGiB']])
 print(json.dumps(out))`;
 const p=spawnSync('python3',['-c',code,helper],{encoding:'utf8',timeout:5000});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),[[6,6],[null,null],[6,3]]);
});
