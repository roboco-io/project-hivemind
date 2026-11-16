import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNpmBenchmarkTiming} from '../src/runtime/npm-benchmark-timing.ts';

test('npm timing classifies install, build and typecheck without retaining argv',()=>{
 const data=(command:string[],key:string)=>({metadata:{command},timers:{npm:100,[key]:70}});
 assert.deepEqual(parseNpmBenchmarkTiming(data(['i','package'],'command:install')),{kind:'install',ms:100,operation:'install'});
 assert.deepEqual(parseNpmBenchmarkTiming(data(['ci'],'command:ci')),{kind:'install',ms:100,operation:'ci'});
 assert.deepEqual(parseNpmBenchmarkTiming(data(['run','build'],'command:run')),{kind:'build',ms:100});
 assert.deepEqual(parseNpmBenchmarkTiming(data(['exec','--','tsc','--noEmit'],'command:exec')),{kind:'typecheck',ms:100});
 assert.equal(parseNpmBenchmarkTiming(data(['run','dev'],'command:run')),undefined);
});
