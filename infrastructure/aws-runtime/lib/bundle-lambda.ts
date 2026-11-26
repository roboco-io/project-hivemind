import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const bundled = new Map<string, string>();

/**
 * Bundles one Lambda entry file under `lambda/` into a single CommonJS `index.js` and returns the
 * directory that holds it, for `lambda.Code.fromAsset`. The Lambda shares repository code (and the `pg`
 * driver) with the Control Plane, which inline code cannot do. The result is cached per process.
 */
export function bundleLambda(entryFileName: string): string {
  const cached = bundled.get(entryFileName);
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const outdir = mkdtempSync(join(tmpdir(), 'hivemind-lambda-'));
  buildSync({
    entryPoints: [join(here, '..', 'lambda', entryFileName)],
    outfile: join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    // Optional native and Cloudflare-only backends of `pg`; neither exists in the Lambda runtime.
    external: ['pg-native', 'cloudflare:sockets'],
    logLevel: 'silent',
  });
  bundled.set(entryFileName, outdir);
  return outdir;
}
