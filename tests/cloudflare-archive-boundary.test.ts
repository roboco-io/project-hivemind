import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

/**
 * ADR-0012: `cloudflare/` is a read-only archive. Only the two legacy adapters may reference code under it.
 * Any other source file that starts to depend on the archive fails this test.
 */
const ALLOWED = ['packages/adapters/src/cloud-workflow.ts', 'packages/adapters/src/cloudflare.ts'];
const ARCHIVE_REFERENCE = /cloudflare\/(backend|oidc-issuer|scripts|tests)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('only the two legacy adapters reference code under the archived cloudflare/ directory (ADR-0012)', () => {
  const root = process.cwd();
  const referencing = ['apps', 'packages', 'infrastructure/aws-runtime/lib', 'infrastructure/aws-runtime/lambda', 'infrastructure/aws-runtime/bin']
    .flatMap((dir) => sourceFiles(join(root, dir)))
    .filter((file) => ARCHIVE_REFERENCE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).split('\\').join('/'))
    .sort();
  assert.deepEqual(referencing, ALLOWED);
});

test('the AWS single-path modules do not import the Cloudflare port or contracts', () => {
  const root = process.cwd();
  const awsPathFiles = [
    'packages/core/src/delivery.ts',
    'packages/core/src/model-factory.ts',
    'packages/core/src/agent-collab.ts',
    'packages/core/src/document-repository.ts',
    'apps/control-plane/src/delivery-api.ts',
    'apps/control-plane/src/delivery-orchestrator.ts',
    'apps/control-plane/src/model-factory-api.ts',
    'apps/control-plane/src/model-factory-orchestrator.ts',
    'apps/control-plane/src/collab-api.ts',
    'apps/control-plane/src/collab-orchestrator.ts',
    'apps/mcp-server/src/delivery.ts',
    'apps/mcp-server/src/model-factory.ts',
    'apps/mcp-server/src/collab.ts',
    'infrastructure/aws-runtime/lambda/mf-ttl-guard.ts',
  ];
  for (const file of awsPathFiles) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.ok(!/from ['"][^'"]*cloud(flare|-workflow)[^'"]*['"]/.test(text), `${file} must not import Cloudflare modules`);
  }
});
