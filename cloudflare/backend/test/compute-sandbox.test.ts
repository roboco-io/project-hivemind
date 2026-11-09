import test from 'node:test';
import assert from 'node:assert/strict';
import {computeSandboxArgs} from '../src/runtime/compute-sandbox.ts';

test('compute explicitly selects a named workspace profile with network enabled',()=>{
 const args=computeSandboxArgs();
 assert.deepEqual(args.slice(0,2),['codex','sandbox']);assert.equal(args[args.indexOf('-P')+1],'checks');assert.equal(args[args.indexOf('-c')+1],'permissions.checks={extends=":workspace",network={enabled=true}}');assert.equal(args.at(-1),'--');
 assert.equal(args.some(arg=>/sandbox_workspace_write|dangerously|bypass|api[_-]?key|oauth|token/i.test(arg)),false);
});
test('compute invocation adds no provider session and returns independently mutable argv',()=>{
 const first=computeSandboxArgs();first.push('/bin/false');const second=computeSandboxArgs();assert.equal(second.includes('/bin/false'),false);assert.equal(second.at(-1),'--');assert.equal(second.includes('exec'),false);
});
