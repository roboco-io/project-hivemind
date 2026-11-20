import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {safeEnv} from '../resource-validation/experiment.ts';

export type CacheCondition = 'cold' | 'seed' | 'reuse';
export const LOCAL_CCACHE_VERSION = '4.14.3';
const releaseName = 'ccache-' + LOCAL_CCACHE_VERSION + '-darwin';
const archiveSha256 = '764dd2a8100ff83e6bbd7b9a1e2016cc401be34bee8a70ea99698186622c34d5';
const executableSha256 = 'a2b2f42ba5c6dda37e8176da64dba698b375f454627fb88909c88024109509e5';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

export function parseCcacheStats(raw: string) {
  const counters: Record<string, number> = {};
  for (const line of raw.trim().split('\n')) {
    const match = /^([a-z][a-z0-9_]*)\s+(\d+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw Error('Pilot ccache statistics are invalid');
    counters[match[1]!] = Number(match[2]);
  }
  function counter(key: string) {
    const value = counters[key];
    if (value === undefined) throw Error('Missing ccache counter: ' + key);
    return value;
  }
  const directHits = counter('direct_cache_hit');
  const preprocessedHits = counter('preprocessed_cache_hit');
  const misses = counter('cache_miss');
  const hits = directHits + preprocessedHits;
  const cacheable = hits + misses;
  return {directHits, preprocessedHits, misses, hitRate: cacheable ? hits / cacheable : null, counters};
}

export function localCcachePaths(root: string, prefix: string) {
  if (prefix !== 'c3' && prefix !== 'c4') throw Error('Pilot ccache supports C3 and C4');
  const tools = join(root, 'ccache-tools');
  const state = join(root, 'ccache-experiment');
  const work = join(state, 'work');
  const seeds = join(state, 'seeds');
  const cache = join(work, 'cache', prefix);
  const archive = join(seeds, prefix + '.tar.gz');
  const config = join(tools, 'config');
  return {
    tools, seeds, work, archive, cache, config,
    settings: ['CCACHE_DIR=' + cache, 'CCACHE_CONFIGPATH=' + config,
      'CCACHE_COMPILERCHECK=content', 'CCACHE_MAXSIZE=5G'],
    executable: join(tools, 'ccache'),
  };
}

export async function verifyLocalCcache(root: string) {
  const paths = localCcachePaths(root, 'c3');
  if (hash(await readFile(paths.executable)) !== executableSha256) throw Error('Pilot ccache executable digest differs');
  if ((await readFile(paths.config)).length) throw Error('Pilot ccache config must be empty');
}

export async function prepareLocalCcache(root: string) {
  if (process.platform !== 'darwin') throw Error('Pilot local ccache requires Darwin');
  const paths = localCcachePaths(root, 'c3');
  await mkdir(paths.tools, {recursive: true, mode: 0o700});
  const archive = join(paths.tools, releaseName + '.tar.gz');
  const temporary = await mkdtemp(join(paths.tools, '.install-'));
  try {
    let data = await readFile(archive).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!data) {
      const download = join(temporary, 'release.tar.gz');
      const url = 'https://github.com/ccache/ccache/releases/download/v' + LOCAL_CCACHE_VERSION + '/' + releaseName + '.tar.gz';
      execFileSync('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
        '--max-time', '120', '--max-filesize', '16777216', '--output', download, url],
      {env: safeEnv(), timeout: 125000});
      data = await readFile(download);
      if (hash(data) !== archiveSha256) throw Error('Pilot ccache release digest differs');
      await rename(download, archive);
    }
    if (hash(data) !== archiveSha256) throw Error('Pilot ccache release digest differs');
    const executable = execFileSync('/usr/bin/tar', ['-xOzf', archive, releaseName + '/ccache'],
      {env: safeEnv(), maxBuffer: 16 * 1024 ** 2, timeout: 15000});
    if (hash(executable) !== executableSha256) throw Error('Pilot ccache executable digest differs');
    const binary = join(temporary, 'ccache');
    await writeFile(binary, executable, {flag: 'wx', mode: 0o700});
    await rename(binary, paths.executable);
    await writeFile(paths.config, '', {flag: 'wx', mode: 0o600}).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await verifyLocalCcache(root);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}
