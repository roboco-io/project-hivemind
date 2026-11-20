import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCcacheStats} from '../scripts/duckdb-pilot/local-ccache.ts';

test('cache rate counts direct and preprocessed hits among cacheable calls', () => {
  assert.deepEqual(parseCcacheStats([
    'cache_miss 8', 'direct_cache_hit 80', 'preprocessed_cache_hit 12',
    'called_for_link 3', '',
  ].join('\n')), {
    directHits: 80, preprocessedHits: 12, misses: 8, hitRate: 0.92,
    counters: {cache_miss: 8, direct_cache_hit: 80, preprocessed_cache_hit: 12, called_for_link: 3},
  });
});

test('zero cacheable calls have no hit rate, and missing counters are an error', () => {
  assert.equal(parseCcacheStats('cache_miss 0\ndirect_cache_hit 0\npreprocessed_cache_hit 0\n').hitRate, null);
  assert.throws(() => parseCcacheStats('cache_miss 0\n'), /Missing ccache counter/);
});
