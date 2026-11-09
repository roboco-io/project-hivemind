import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../scripts/phase0/compute-stdio-probe.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess} from '../backend/src/runtime/process.ts';

const tap='TAP version 13\nok 1 - arithmetic\nok 2 - source\n# tests 2\n# pass 2\n# fail 0\n';
const passed=()=>({status:'passed',exitCode:0,stdout:tap,stderr:'',durationMs:10,truncated:false});
test('compute stdio proof requires real two-test TAP totals rather than exit success alone',()=>{
 const assess=(probe as any).assessComputeStdio;assert.equal(typeof assess,'function');assert.equal(assess(passed()).passed,true);
 for(const patch of [{stdout:''},{stdout:'HIVEMIND_STDOUT_CONTROL'},{stdout:tap.replace('# tests 2','# tests 20')},{stdout:tap.replace('# pass 2','# pass 1')},{stdout:tap.replace('# fail 0','# fail 1')},{status:'error'},{exitCode:1},{truncated:true}])assert.equal(assess({...passed(),...patch}).passed,false);
});
test('compute stdio probe uses the named compute permission profile',()=>{
 const args=(probe as any).computeStdioArgs;assert.equal(typeof args,'function');
 assert.deepEqual(args(),['codex','sandbox','-c','permissions.checks={extends=":workspace",network={enabled=true}}','-P','checks','--','node','--test','--test-reporter=tap','stdio.test.mjs']);
});
test('fixed stdio fixture emits actual two-test TAP through regular output files locally',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hive-stdio-fixture-'));try{
  await writeFile(join(dir,'stdio.test.mjs'),(probe as any).computeStdioTestSource());
  const result=await runProcess([process.execPath,'--test','--test-reporter=tap','stdio.test.mjs'],{cwd:dir,env:{PATH:process.env.PATH},captureDirectory:join(dir,'capture'),timeoutMs:5000,maxBytes:32768});
  assert.equal((probe as any).assessComputeStdio(result).passed,true);assert.match(result.stdout,/HIVEMIND_STDIO_FD /);assert.match(result.stdout+result.stderr,/HIVEMIND_STDERR_CONTROL/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
