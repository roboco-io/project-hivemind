interface ToolchainInput {compiler:string;cache:string;cmake:string;ninja:string;platform:string;arch:string}
const invalid=()=>Error('Toolchain metadata missing or invalid');
export function parseToolchainEvidence(input:ToolchainInput){
 if(Object.values(input).some(v=>typeof v!=='string'||v.length>262144))throw invalid();
 const setting=(name:string)=>{const values=[...input.compiler.matchAll(new RegExp('^set\\('+name+' "([^"\\r\\n]*)"\\)\\s*$','gm'))];if(values.length!==1)throw invalid();return values[0]![1]!;};
 const cached=(name:string)=>{const values=[...input.cache.matchAll(new RegExp('^'+name+':STRING=([^\\r\\n]*)$','gm'))];if(values.length!==1)throw invalid();return values[0]![1]!.trim();};
 const version=(value:string)=>{if(!/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.]{1,32})?$/.test(value)||value.length>64)throw invalid();return value;};
 const path=setting('CMAKE_CXX_COMPILER'),id=setting('CMAKE_CXX_COMPILER_ID'),compilerVersion=version(setting('CMAKE_CXX_COMPILER_VERSION'));
 if(!/^\/(?:usr|opt)\/[A-Za-z0-9_./+\-]{1,180}$/.test(path)||!['Clang','AppleClang','GNU'].includes(id))throw invalid();
 const cmakeLine=input.cmake.trim().split(/\r?\n/)[0]??'';if(!cmakeLine.startsWith('cmake version '))throw invalid();
 const cmakeVersion=version(cmakeLine.slice('cmake version '.length)),ninjaVersion=input.ninja.trim();
 version(ninjaVersion.replace(/\.git\.kitware\.jobserver-pipe-1$/,''));
 const global=cached('CMAKE_CXX_FLAGS'),release=cached('CMAKE_CXX_FLAGS_RELEASE');
 const safeFlag=(value:string)=>value.length<=512&&/^[A-Za-z0-9_ .,+:/=()\-]*$/.test(value)&&!value.includes('$');
 if(!safeFlag(global)||!safeFlag(release)||cached('CMAKE_BUILD_TYPE')!=='Release'||!['linux','darwin'].includes(input.platform)||!['x64','arm64'].includes(input.arch))throw invalid();
 return {compiler:{id,version:compilerVersion,path},cmakeVersion,ninjaVersion,platform:input.platform,arch:input.arch,buildType:'Release',flags:{global,release},flagsScope:'global-and-Release-cache-entries'};
}
