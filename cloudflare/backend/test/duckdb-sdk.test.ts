import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {selectMacSdk} from '../scripts/duckdb-pilot/sdk.ts';
test('explicit SDK selection records the resolved path, version and settings hash',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hvm-sdk-'));
 try{
  const sdk=join(root,'MacOSX26.5.sdk');await mkdir(sdk);const settings=JSON.stringify({CanonicalName:'macosx26.5',Version:'26.5'});await writeFile(join(sdk,'SDKSettings.json'),settings);
  const actual=await selectMacSdk(sdk,'darwin');assert.equal(actual?.path,await realpath(sdk));assert.equal(actual?.version,'26.5');assert.equal(actual?.settingsSha256,createHash('sha256').update(settings).digest('hex'));assert.equal(actual?.selection,'explicit');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SDK selection rejects nonabsolute paths, nonmac platforms and mismatched metadata',async()=>{
 await assert.rejects(()=>selectMacSdk('relative.sdk','darwin'));await assert.rejects(()=>selectMacSdk('/missing.sdk','linux'));
 const root=await mkdtemp(join(tmpdir(),'hvm-sdk-'));
 try{const sdk=join(root,'MacOSX26.5.sdk');await mkdir(sdk);await writeFile(join(sdk,'SDKSettings.json'),JSON.stringify({Version:'26.5',CanonicalName:'iphoneos26.5'}));await assert.rejects(()=>selectMacSdk(sdk,'darwin'));}finally{await rm(root,{recursive:true,force:true});}
});
test('unset SDK preserves default toolchain behavior',async()=>{assert.equal(await selectMacSdk(undefined,'darwin'),undefined);});
