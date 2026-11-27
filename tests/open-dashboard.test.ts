import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTunnelAndOpen,
  resolveRunningTunnelTarget,
  runTunnelSupervisor,
  stopManagedTunnel,
  type OpenDashboardConfig,
  type OpenDashboardSystem,
} from '../scripts/lib/open-dashboard.js';

const baseConfig: OpenDashboardConfig = {
  profile: 'roboco',
  region: 'ap-northeast-2',
  cluster: 'hivemind-runtime-cluster',
  service: 'hivemind-runtime-control-plane',
  localPort: 4310,
  operatorTokenFile: '/tmp/fake-token.json',
  pidFile: '/tmp/fake-tunnel.pid',
  logFile: '/tmp/fake-tunnel.log',
  readyTimeoutMs: 5_000,
  pollIntervalMs: 10,
};

const runningDescribe = (taskId: string, runtimeId: string) => ({
  tasks: [
    {
      lastStatus: 'RUNNING',
      containers: [{ name: 'control-plane', lastStatus: 'RUNNING', runtimeId }],
    },
  ],
  taskId,
});

function createFakeSystem(overrides: Partial<OpenDashboardSystem> = {}) {
  const opened: string[] = [];
  const killed: number[] = [];
  const logs: string[] = [];
  let savedPid: number | null = null;
  let nowMs = 1_000;

  const sys: OpenDashboardSystem = {
    awsJson: async (args) => {
      if (args.includes('list-tasks')) {
        return { taskArns: ['arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind-runtime-cluster/task-1'] };
      }
      return runningDescribe('task-1', 'task-1-rt');
    },
    isHealthy: async () => true,
    readOperatorToken: () => 'OP_TOKEN_SECRET',
    readPid: () => savedPid,
    writePid: (_file, pid) => {
      savedPid = pid;
    },
    removePid: (_file, expected) => {
      if (expected === undefined || savedPid === expected) savedPid = null;
    },
    killProcessGroup: (pid) => {
      killed.push(pid);
      return true;
    },
    spawnDaemon: () => {
      savedPid = 4242;
      return 4242;
    },
    spawnSsmTunnel: () => ({
      pid: 9999,
      exited: Promise.resolve(0),
      killGroup: () => {
        killed.push(9999);
      },
    }),
    openBrowser: (url) => {
      opened.push(url);
    },
    sleep: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    log: (msg) => {
      logs.push(msg);
    },
    ...overrides,
  };
  return { sys, opened, killed, logs, getSavedPid: () => savedPid, advance: (ms: number) => { nowMs += ms; } };
}

test('ensureTunnelAndOpen reuses an already healthy local/tunnel endpoint without spawning a daemon', async () => {
  let spawned = 0;
  const { sys, opened } = createFakeSystem({
    isHealthy: async () => true,
    spawnDaemon: () => {
      spawned += 1;
      return 1234;
    },
  });
  const res = await ensureTunnelAndOpen(baseConfig, sys);
  assert.equal(res.tunnelAction, 'reused');
  assert.equal(spawned, 0);
  assert.deepEqual(opened, ['http://127.0.0.1:4310/#token=OP_TOKEN_SECRET']);
});

test('ensureTunnelAndOpen automatically starts tunnel daemon when port is down and opens browser once healthy', async () => {
  let healthChecks = 0;
  const { sys, opened, killed } = createFakeSystem({
    readPid: () => 7777, // stale daemon PID
    isHealthy: async () => {
      healthChecks += 1;
      return healthChecks >= 3;
    },
  });
  const res = await ensureTunnelAndOpen(baseConfig, sys);
  assert.equal(res.tunnelAction, 'started');
  assert.equal(res.daemonPid, 4242);
  assert.deepEqual(killed, [7777]);
  assert.deepEqual(opened, ['http://127.0.0.1:4310/#token=OP_TOKEN_SECRET']);
});

test('ensureTunnelAndOpen refuses to start a billed ECS service when no RUNNING task exists', async () => {
  let spawned = 0;
  const { sys, opened } = createFakeSystem({
    isHealthy: async () => false,
    awsJson: async () => ({ taskArns: [] }),
    spawnDaemon: () => {
      spawned += 1;
      return 1234;
    },
  });
  await assert.rejects(() => ensureTunnelAndOpen(baseConfig, sys), /make aws-up/);
  assert.equal(spawned, 0);
  assert.equal(opened.length, 0);
});

test('runTunnelSupervisor automatically reconnects after SSM inactivity timeout and follows Spot task replacement', async () => {
  const targets: string[] = [];
  let listCalls = 0;
  const fake = createFakeSystem({
    awsJson: async (args) => {
      if (args.includes('list-tasks')) {
        listCalls += 1;
        if (listCalls === 1) return { taskArns: ['arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind-runtime-cluster/task-old'] };
        if (listCalls === 2) return { taskArns: ['arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind-runtime-cluster/task-new'] };
        return { taskArns: [] }; // ECS stopped afterwards
      }
      const taskArn = args[args.indexOf('--tasks') + 1]!;
      const id = taskArn.split('/').pop()!;
      return runningDescribe(id, `${id}-rt`);
    },
    spawnSsmTunnel: (target) => {
      targets.push(target);
      // Simulate long-lived session (30 min) before inactivity timeout
      fake.advance(30 * 60 * 1000);
      return {
        pid: 5000 + targets.length,
        exited: Promise.resolve(0),
        killGroup: () => undefined,
      };
    },
  });

  const outcome = await runTunnelSupervisor(baseConfig, fake.sys, { initialBackoffMs: 10, maxBackoffMs: 40 });
  assert.equal(outcome.stopReason, 'no_running_task');
  assert.equal(outcome.reconnects, 2);
  assert.deepEqual(targets, [
    'ecs:hivemind-runtime-cluster_task-old_task-old-rt',
    'ecs:hivemind-runtime-cluster_task-new_task-new-rt',
  ]);
  // Ensure secret token never appears in supervisor logs
  assert.ok(fake.logs.every((line) => !line.includes('OP_TOKEN_SECRET')));
});

test('runTunnelSupervisor stops cleanly after repeated rapid failures instead of busy-looping', async () => {
  const fake = createFakeSystem({
    spawnSsmTunnel: () => ({
      pid: 6000,
      exited: Promise.resolve(1),
      killGroup: () => undefined,
    }),
  });
  const outcome = await runTunnelSupervisor(baseConfig, fake.sys, {
    maxRapidFailures: 3,
    rapidThresholdMs: 10_000,
    initialBackoffMs: 10,
    maxBackoffMs: 40,
  });
  assert.equal(outcome.stopReason, 'rapid_failures');
  assert.equal(outcome.reconnects, 2);
});

test('runTunnelSupervisor sends periodic /health keepalive pings while tunnel is running and cleans up on abort', async () => {
  let healthPings = 0;
  let resolveExit!: (code: number) => void;
  const controller = new AbortController();
  const fake = createFakeSystem({
    isHealthy: async () => {
      healthPings += 1;
      if (healthPings >= 2) controller.abort();
      return true;
    },
    spawnSsmTunnel: () => ({
      pid: 7001,
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      killGroup: () => resolveExit(0),
    }),
  });
  const outcome = await runTunnelSupervisor(baseConfig, fake.sys, {
    keepaliveIntervalMs: 15,
    signal: controller.signal,
  });
  assert.equal(outcome.stopReason, 'stopped');
  assert.ok(healthPings >= 2);
});

test('resolveRunningTunnelTarget and stopManagedTunnel handle missing tasks and cleanup cleanly', async () => {
  const none = await resolveRunningTunnelTarget(baseConfig, async () => ({ taskArns: [] }));
  assert.equal(none, null);

  const fake = createFakeSystem();
  fake.sys.writePid(baseConfig.pidFile, 8888);
  assert.equal(stopManagedTunnel(baseConfig.pidFile, fake.sys), true);
  assert.deepEqual(fake.killed, [8888]);
  assert.equal(fake.getSavedPid(), null);
});
