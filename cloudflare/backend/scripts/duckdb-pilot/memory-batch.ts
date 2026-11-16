import {isAbsolute} from 'node:path';
import {validateMemoryOptions} from './metrics.ts';
export const MEMORY_SHARDS:readonly (readonly number[])[]=[
 [9,1,5,11,15,19], [18,2,6,10,14,22], [21,4,7,12,16], [3,8,13,17,20],
];
export const FLOAT_COMPARISON={relative:'1e-12',absolute:'1e-8',formula:'abs(a-b) <= max(absTolerance, relTolerance * max(abs(a), abs(b)))'};
export function validateMemoryBatch(sf:number,memoryGiB:number,threads:number,concurrency:number){
 validateMemoryOptions(sf,memoryGiB,threads);if(![1,2,4].includes(concurrency))throw Error('Invalid memory batch concurrency');
 const ids=MEMORY_SHARDS.flat();if(ids.length!==22||new Set(ids).size!==22||ids.some(q=>q<1||q>22))throw Error('Invalid memory query partition');
 return {sf,memoryGiB,threads,concurrency,shards:MEMORY_SHARDS.map(x=>[...x]),floatComparison:FLOAT_COMPARISON};
}
function sqlPath(path:string){if(!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path))throw Error('Invalid pilot output path');return "'"+path.replaceAll("'","''")+"'";}
function shellPath(path:string){sqlPath(path);return JSON.stringify(path);}
export interface ShardQuery {id:number;sql:string;resultPath:string;schemaPath:string;profilePath:string}
export function shardScript(queries:ShardQuery[],memoryGiB:number,threads:number,spillPath:string){
 if(!queries.length||new Set(queries.map(q=>q.id)).size!==queries.length||![3,6,9].includes(memoryGiB)||!Number.isInteger(threads)||threads<1||threads>10)throw Error('Invalid shard script settings');
 const lines=['.bail on','.mode json',`SET threads=${threads};`,`SET memory_limit='${memoryGiB}GiB';`,`SET temp_directory=${sqlPath(spillPath)};`,"SET max_temp_directory_size='4GiB';",'LOAD tpch;','PRAGMA disable_profiling;'];
 for(const q of queries){
  if(!Number.isInteger(q.id)||q.id<1||q.id>22||!/^\s*(SELECT|WITH)\b/i.test(q.sql)||q.sql.includes('\0'))throw Error('Invalid pinned query');
  // Only caller-verified pinned SQL is accepted. q15 is a CTE, not a multi-command view script.
  const described=q.sql.trim().replace(/;\s*$/,'');
  lines.push(`.once ${shellPath(q.schemaPath)}`,`DESCRIBE ${described};`,`SET profiling_output=${sqlPath(q.profilePath)};`,"PRAGMA enable_profiling='json';",`.once ${shellPath(q.resultPath)}`,`PRAGMA tpch(${q.id});`,'PRAGMA disable_profiling;');
 }
 return lines.join('\n')+'\n';
}
