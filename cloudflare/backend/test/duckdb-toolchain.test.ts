import test from 'node:test';
import assert from 'node:assert/strict';
import {parseToolchainEvidence} from '../scripts/duckdb-pilot/remote/toolchain.ts';
const compiler='set(CMAKE_CXX_COMPILER "/usr/bin/clang++")\nset(CMAKE_CXX_COMPILER_ID "Clang")\nset(CMAKE_CXX_COMPILER_VERSION "14.0.6")\n';
const cache='CMAKE_CXX_FLAGS:STRING= -Wall -Wextra\nCMAKE_CXX_FLAGS_RELEASE:STRING=-O3 -DNDEBUG\nCMAKE_BUILD_TYPE:STRING=Release\n';
const input={compiler,cache,cmake:'cmake version 3.25.1\n\nCMake suite maintained',ninja:'1.11.1\n',platform:'linux',arch:'x64'};
test('compiler metadata reports actual CMake ID/version/path and bounded cache flags',()=>{
 const r=parseToolchainEvidence(input);assert.deepEqual(r.compiler,{id:'Clang',version:'14.0.6',path:'/usr/bin/clang++'});assert.equal(r.cmakeVersion,'3.25.1');assert.equal(r.ninjaVersion,'1.11.1');assert.equal(r.flags.release,'-O3 -DNDEBUG');assert.equal(r.flagsScope,'global-and-Release-cache-entries');assert.equal(r.arch,'x64');
});
test('missing, oversized and free-form metadata is rejected rather than copied',()=>{
 for(const bad of [{...input,compiler:''},{...input,compiler:compiler.replace('Clang','Clang\nSECRET')},{...input,cache:cache.replace('-O3 -DNDEBUG','a'.repeat(513))},{...input,cmake:'token=private'},{...input,arch:'private-user-string'},{...input,cache:cache.replace('-O3 -DNDEBUG','$(private)')}])assert.throws(()=>parseToolchainEvidence(bad));
});
test('pinned Ninja wheels retain their version suffix in evidence',()=>{
 const ninja='1.13.0.git.kitware.jobserver-pipe-1';
 assert.equal(parseToolchainEvidence({...input,ninja}).ninjaVersion,ninja);
 assert.throws(()=>parseToolchainEvidence({...input,ninja:'1.13.0.git.other-build'}));
});
