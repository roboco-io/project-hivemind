import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';

export interface NpmBenchmarkTiming {kind:'install'|'build'|'typecheck';ms:number;operation?:'ci'|'install';registryGets?:number}
export function parseNpmBenchmarkTiming(data:unknown):NpmBenchmarkTiming|undefined {
  if(!data||typeof data!=='object')return;
  const {metadata,timers}=data as {metadata?:{command?:unknown};timers?:Record<string,number>};
  const argv=metadata?.command;
  const ms=timers?.npm;
  if(!Array.isArray(argv)||!argv.every(arg=>typeof arg==='string')||typeof ms!=='number'||!Number.isSafeInteger(ms)||ms<0)return;
  if(timers?.['command:install']!==undefined||timers?.['command:ci']!==undefined)return {kind:'install',ms,operation:timers?.['command:ci']!==undefined?'ci':'install'};
  if(timers?.['command:run']!==undefined||timers?.['command:run-script']!==undefined){
    const index=argv.findIndex(arg=>arg==='run'||arg==='run-script');
    const kind=argv[index+1];
    if(index>=0&&(kind==='build'||kind==='typecheck'))return {kind,ms};
  }
  if(timers?.['command:exec']!==undefined&&argv.includes('tsc'))return {kind:argv.includes('--noEmit')?'typecheck':'build',ms};
}
export async function readNpmBenchmarkTimings(dir:string):Promise<NpmBenchmarkTiming[]> {
  const entries=await readdir(dir).catch(()=>[]);
  const records:NpmBenchmarkTiming[]=[];
  for(const name of entries.filter(name=>/^\d{4}-[\dT_:.-]+Z-timing\.json$/.test(name)).sort().slice(0,300)){
    try{
      const file=join(dir,name);
      const info=await stat(file);
      if(!info.isFile()||info.size>262144)continue;
      const timing=parseNpmBenchmarkTiming(JSON.parse(await readFile(file,'utf8')));
      if(!timing)continue;
      const debug=join(dir,name.replace(/-timing\.json$/,'-debug-0.log'));
      const logInfo=await stat(debug).catch(()=>undefined);
      if(timing.kind==='install'&&logInfo?.isFile()&&logInfo.size<=2*1024*1024){
        const log=await readFile(debug,'utf8');
        timing.registryGets=(log.match(/^\d+ http fetch GET /gm)??[]).length;
      }
      records.push(timing);
    }catch{/* Partial npm logs are omitted. */}
  }
  return records;
}
