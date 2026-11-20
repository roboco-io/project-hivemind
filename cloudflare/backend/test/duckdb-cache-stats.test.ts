import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCacheStats} from '../scripts/duckdb-pilot/remote/cache-stats.ts';

test('reports direct and preprocessed hits without counting their lookup misses twice',()=>{
 assert.deepEqual(parseCacheStats(JSON.stringify({
  direct_cache_hit:7,preprocessed_cache_hit:1,cache_miss:2,
  direct_cache_miss:3,preprocessed_cache_miss:2,
  called_for_link:2,unsupported_compiler_option:1,bad_input_file:4,
  files_in_cache:11,cache_size_kibibyte:163,
 })),{version:'4.14.3',hits:8,directHits:7,preprocessedHits:1,misses:2,uncacheable:3,filesInCache:11,sizeKiB:163,cleanups:0});
});

test('rejects malformed ccache statistics',()=>{
 assert.throws(()=>parseCacheStats('{"direct_cache_hit":-1}'),/Invalid ccache statistics/);
});
