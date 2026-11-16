import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyBash,bashDiagnostic,validBashDiagnostic} from '../src/runtime/bash-diagnostic.ts';
test('bash diagnostics retain category and exit status without credentials or raw messages',()=>{
 const categories=classifyBash('git ls-remote https://user:secret@example.com/repo');
 const result={content:[{type:'text',text:'fatal: unable to access https://user:secret@example.com/repo: server certificate verification failed\nCommand exited with code 128'}]};
 const record=bashDiagnostic(categories,result,true);
 assert.deepEqual(record,{categories:['git'],exitCode:128,message:'TLS certificate verification failed'});
 assert.equal(validBashDiagnostic(record),true);
 assert.doesNotMatch(JSON.stringify(record),/secret|user|example.com/);
});
test('compound commands and unknown termination retain accurate limitations',()=>{
 assert.deepEqual(classifyBash('npm ci && npx prisma generate && npm run build'),['npm-install','prisma','build']);
 assert.deepEqual(bashDiagnostic(['test'],{content:[{type:'text',text:'Command timed out after 60 seconds'}]},true),
  {categories:['test'],exitCode:null,message:'Command reached its timeout'});
 assert.equal(bashDiagnostic(['other'],{content:[{type:'text',text:'private-content'}]},true).message,'Command failed; diagnostic text omitted');
 assert.equal(bashDiagnostic(['other'],{},false).exitCode,0);
 assert.equal(validBashDiagnostic({categories:['other'],exitCode:1,message:'untrusted raw output'}),false);
});
