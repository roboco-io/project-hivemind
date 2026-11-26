import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateExternalS3Target,validateExternalS3Parameters,externalS3ObjectKey,externalS3Mark} from '../packages/core/src/autonomous-external-s3.ts';
const target={accountId:'123456789012',region:'ap-northeast-2',bucket:'hivemind-runs',prefix:'runs/',maxObjectBytes:1024,retentionDays:30};
const digest='a'.repeat(64);

test('object key rejects traversal, encoded and malformed suffixes',()=>{
  assert.equal(externalS3ObjectKey({prefix:'runs/'},'t1/m.json'),'runs/t1/m.json');
  for(const bad of ['../x','a/../b','/a','a//b','a/','a/./b','a/.','a/b/.','%2e%2e/x','a\\b','','.hidden','a'.repeat(241)])assert.throws(()=>externalS3ObjectKey({prefix:'runs/'},bad),Error,bad);
  assert.equal(externalS3ObjectKey({prefix:'runs/'},'a'.repeat(240)).length,245);
});
test('a dot segment in the prefix is rejected',()=>{
  assert.throws(()=>externalS3ObjectKey({prefix:'runs/./'},'a'));
  assert.throws(()=>validateExternalS3Target({...target,prefix:'runs/./'}));
});
test('target validation is strict',()=>{
  assert.deepEqual(validateExternalS3Target(target),target);
  assert.deepEqual(validateExternalS3Target({...target,kmsKeyId:'alias/hivemind'}).kmsKeyId,'alias/hivemind');
  for(const bad of [{...target,bucket:'my.bucket'},{...target,prefix:'runs'},{...target,prefix:'/runs/'},{...target,prefix:'a/../'},{...target,prefix:'a//'},{...target,prefix:''},
    {...target,accountId:'1'},{...target,region:'x'},{...target,maxObjectBytes:1048577},{...target,maxObjectBytes:0},{...target,retentionDays:0},{...target,extra:1},{...target,kmsKeyId:'a b'},null,[],'x'])
    assert.throws(()=>validateExternalS3Target(bad));
});
test('parameters reject extra keys and bad values',()=>{
  assert.deepEqual(validateExternalS3Parameters({keySuffix:'t1/m.json',artifactDigest:digest}),{keySuffix:'t1/m.json',artifactDigest:digest});
  for(const bad of [{keySuffix:'t1/m.json',artifactDigest:digest,bucket:'other'},{keySuffix:'../x',artifactDigest:digest},{keySuffix:'x',artifactDigest:'A'.repeat(64)},{keySuffix:'x'},null])
    assert.throws(()=>validateExternalS3Parameters(bad));
});
test('mark is sha256 of the JSON triple',()=>{
  const i={ownershipToken:'o',idempotencyKey:'k',parametersHash:'p'};
  assert.equal(externalS3Mark(i),createHash('sha256').update(JSON.stringify(['o','k','p'])).digest('hex'));
  assert.notEqual(externalS3Mark(i),externalS3Mark({...i,idempotencyKey:'k2'}));
});
