import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Runs a long-lived command in its own process group and stops the WHOLE group when this process is asked
 * to stop or when the command itself exits.
 *
 * Why a group: `aws ssm start-session` starts `session-manager-plugin` as a child, and the plugin is the
 * process that listens on the local port. Stopping only `aws` leaves the plugin running, so the port stays
 * taken and the next tunnel on that port fails. A signal sent to the group reaches both.
 *
 * stdin is not passed on: a process in a background group that reads the terminal would be suspended.
 */
export function runInOwnProcessGroup(command: string, args: string[], onExit: (code: number) => void = (code) => process.exit(code)): ChildProcess {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  const stopGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // the group is already gone
    }
  };
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    stopGroup();
    onExit(code);
  };
  // The child is outside the terminal's foreground group, so Ctrl-C reaches only this process.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => finish(0));
  process.on('exit', stopGroup);
  child.on('error', () => finish(1));
  child.on('exit', (code) => finish(code ?? 0));
  return child;
}
