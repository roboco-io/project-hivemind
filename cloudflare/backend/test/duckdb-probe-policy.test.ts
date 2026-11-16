import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyBoundaryError,validBoundaryCheck,validDataPostcondition} from '../scripts/duckdb-pilot/remote/probe-policy.ts';
test('mutation probes accept only explicit permission-denied errors',()=>{
 for(const code of ['EACCES','EPERM','EROFS'])assert.equal(classifyBoundaryError('mutation',code).blocked,true);
 for(const code of ['ENOENT','ENOSPC','ENOMEM','EIO','ENOTDIR',undefined,'unexpected-private-string']){
  const result=classifyBoundaryError('mutation',code);assert.equal(result.blocked,false);assert.equal(result.classification,'unexpected-error');
 }
});
test('private read ENOENT is explicit namespace hiding, not a permission-denied claim',()=>{
 assert.deepEqual(classifyBoundaryError('private-read','ENOENT'),{blocked:true,code:'ENOENT',classification:'namespace-hidden'});
 for(const code of ['ENOSPC','ENOMEM','EIO','EROFS'])assert.equal(classifyBoundaryError('private-read',code).blocked,false);
 assert.equal(validBoundaryCheck({name:'runtime-input-read',...classifyBoundaryError('private-read','ENOENT')}),true);
 assert.equal(validBoundaryCheck({name:'source-write',...classifyBoundaryError('private-read','ENOENT')}),false);
 assert.equal(validBoundaryCheck({name:'data-write',blocked:true,code:'ENOSPC',classification:'permission-denied'}),false);
});
test('data boundary requires matching before/after content and length',()=>{
 const sha256='a'.repeat(64),sizeBytes=3,receipt={sha256,bytes:3,afterSha256:sha256,afterBytes:3,unchanged:true};
 assert.equal(validDataPostcondition(receipt,{sha256,sizeBytes}),true);
 for(const broken of [{...receipt,afterSha256:'b'.repeat(64)},{...receipt,afterBytes:4},{...receipt,bytes:4},{...receipt,unchanged:false},{sha256,bytes:3}])assert.equal(validDataPostcondition(broken,{sha256,sizeBytes}),false);
});
