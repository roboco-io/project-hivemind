import {zstdDecompressSync} from 'node:zlib';

const capability=process.env.HIVEMIND_TERRA_CAPABILITY;
const probe=process.env.HIVEMIND_TERRA_PROBE==='1';
delete process.env.HIVEMIND_TERRA_CAPABILITY;
delete process.env.HIVEMIND_TERRA_PROBE;
delete process.env.NODE_OPTIONS;
if(capability){
  const endpoint='https://hivemind-terra.invalid/codex/responses';
  let upstreamFetch=globalThis.fetch;
  const fetch=(input,init)=>{
    if(String(input)!==endpoint)return upstreamFetch(input,init);
    const headers=new Headers(init.headers);
    headers.set('authorization','Bearer '+capability);
    headers.delete('chatgpt-account-id');
    if(probe)headers.set('x-hivemind-terra-probe','1');
    if(headers.get('content-encoding')!=='zstd')return upstreamFetch(input,{...init,headers});
    headers.delete('content-encoding');
    const body=zstdDecompressSync(init.body,{maxOutputLength:8*1024*1024});
    return upstreamFetch(input,{...init,headers,body});
  };
  Object.defineProperty(globalThis,'fetch',{
    configurable:true,
    get:()=>fetch,
    set:value=>{if(value!==fetch)upstreamFetch=value;},
  });
}
