import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The wrapper process loads the compiled helper by path; this import makes the build emit it.
import '../scripts/lib/process-group.js';

const helper = resolve(fileURLToPath(import.meta.url), '../../scripts/lib/process-group.js');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

/** Starts a wrapper that runs `parent`, which starts a long-lived grandchild, like aws -> session-manager-plugin. */
function startTree(dir: string, parentBody: string) {
  const pidFile = join(dir, 'grandchild.pid');
  const parent = join(dir, 'parent.mjs');
  writeFileSync(
    parent,
    `import { spawn } from 'node:child_process';import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${parentBody}`,
  );
  const wrapper = join(dir, 'wrapper.mjs');
  writeFileSync(wrapper, `import { runInOwnProcessGroup } from ${JSON.stringify(helper)};runInOwnProcessGroup(process.execPath, [${JSON.stringify(parent)}]);`);
  const proc = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
  return { proc, pidFile };
}

for (const [name, parentBody, stop] of [
  ['stopping the wrapper also stops the grandchild that holds the port', 'setInterval(()=>{},1000);', true],
  ['a grandchild left behind when its parent exits is stopped too', 'setTimeout(()=>process.exit(0), 300);', false],
] as const) {
  test(`process group: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hm-pgroup-'));
    const { proc, pidFile } = startTree(dir, parentBody);
    let grandchild = 0;
    try {
      assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0), 'grandchild started');
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(grandchild));
      const exited = new Promise((r) => proc.once('exit', r));
      if (stop) proc.kill('SIGTERM');
      await exited;
      assert.ok(await waitFor(() => !alive(grandchild)), 'grandchild must not outlive the wrapper');
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
      if (proc.pid && alive(proc.pid)) proc.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
