import {sha256} from './snapshot.ts';
import type {JobRecord} from './contracts.ts';

export type DuckdbCacheMode = 'seed'|'cold'|'warm';
export interface CacheArchiveEvidence {sha256:string; sizeBytes:number; durationMs:number}
export interface DuckdbCacheEvidence {
 mode:DuckdbCacheMode;
 restoreMs:number;
 restoredSha256?:string;
 restoredBytes?:number;
 published?:CacheArchiveEvidence;
}
export const duckdbCacheOrigin='https://hivemind-duckdb-cache.invalid';
export const duckdbCachePath='/v1/cache';
export const duckdbCacheOutputChars=48_000;
export const duckdbCacheMaxBytes=96*1024**2;

export function duckdbCacheMode(argv:readonly string[]|undefined):DuckdbCacheMode|undefined {
 if(argv?.length!==4||argv[0]!=='node'||argv[1]!=='runner.mjs'||!['C3','C4'].includes(argv[2]!))return;
 const mode=argv[3];
 if(mode==='seed'||mode==='cold'||mode==='warm')return mode;
}

export function duckdbCacheIdentity(job:JobRecord|undefined,revision:string) {
 if(job?.kind!=='compute'||job.executionGroup?.instance!=='standard-4'||!job.executionGroup.dependencyNetwork||
    job.largeArtifacts?.length!==2||!job.largeArtifacts.some(ref=>ref.name==='source')||
    !job.largeArtifacts.some(ref=>ref.name==='data'))return;
 const mode=duckdbCacheMode(job.argv);
 if(!mode)return;
 const key=sha256(JSON.stringify([revision,job.snapshotId,job.argv![2],job.largeArtifacts]));
 return {mode,key:'duckdb-ccache/v1/'+key};
}

export function validateDuckdbCacheEvidence(value:unknown,mode:DuckdbCacheMode):DuckdbCacheEvidence {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid DuckDB cache receipt');
 const item=value as DuckdbCacheEvidence;
 const duration=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
 const size=(n:unknown)=>duration(n)&&(n as number)>0&&(n as number)<=duckdbCacheMaxBytes;
 const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 if(Object.keys(item).some(k=>!['mode','restoreMs','restoredSha256','restoredBytes','published'].includes(k))||
    item.mode!==mode||!duration(item.restoreMs))throw Error('Invalid DuckDB cache receipt');
 if(mode==='warm' ? !digest(item.restoredSha256)||!size(item.restoredBytes) : item.restoredSha256!==undefined||item.restoredBytes!==undefined)
   throw Error('Invalid DuckDB cache restore');
 if(mode!=='seed'&&item.published!==undefined)throw Error('Invalid DuckDB cache publish');
 if(item.published!==undefined){
  const p=item.published;
  if(!p||Object.keys(p).some(k=>!['sha256','sizeBytes','durationMs'].includes(k))||
      !digest(p.sha256)||!size(p.sizeBytes)||!duration(p.durationMs))throw Error('Invalid DuckDB cache publish');
 }
 return item;
}
