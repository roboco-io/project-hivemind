import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * The live AWS proof scripts once each carried their own SSM tunnel code, and several killed only the
 * `aws` process, which left session-manager-plugin running and holding the local port. All of them now use
 * scripts/lib/aws-live.ts. This test keeps a new script from reintroducing its own tunnel.
 */
const scriptsDir = join(process.cwd(), 'scripts');
const scripts = readdirSync(scriptsDir).filter((name) => /^aws-.*\.ts$/.test(name));

test('only the shared live helper and the interactive tunnel command start an SSM session', () => {
  const starters = scripts.filter((name) => readFileSync(join(scriptsDir, name), 'utf8').includes('start-session')).sort();
  // aws-ssm-tunnel.ts is the foreground tunnel an operator runs by hand and stops with Ctrl-C.
  assert.deepEqual(starters, ['aws-ssm-tunnel.ts']);
  assert.ok(readFileSync(join(scriptsDir, 'lib', 'aws-live.ts'), 'utf8').includes('start-session'));
});

test('the shared tunnel helper stops the whole process group, and no script kills a tunnel by a bare child.kill', () => {
  const lib = readFileSync(join(scriptsDir, 'lib', 'aws-live.ts'), 'utf8');
  assert.match(lib, /detached: true/);
  assert.match(lib, /process\.kill\(-this\.tunnelPid, 'SIGTERM'\)/);
  for (const name of scripts) {
    const text = readFileSync(join(scriptsDir, name), 'utf8');
    assert.doesNotMatch(text, /(tunnel|child)\.kill\('SIGTERM'\)/, `${name} must close tunnels through scripts/lib/aws-live.ts`);
  }
});

test('every script that talks to the Control Plane through a tunnel imports the shared helper', () => {
  const tunnelUsers = scripts.filter((name) => {
    const text = readFileSync(join(scriptsDir, name), 'utf8');
    return /openSsmTunnel\(|new ControlPlane\(|ControlPlane\.fromOutputs\(/.test(text);
  });
  assert.ok(tunnelUsers.length >= 10, `expected the proof scripts to be found, got ${tunnelUsers.length}`);
  for (const name of tunnelUsers) {
    assert.match(readFileSync(join(scriptsDir, name), 'utf8'), /from '\.\/lib\/aws-live\.js'/, name);
  }
});
