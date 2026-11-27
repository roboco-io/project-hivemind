export interface OpenDashboardConfig {
  profile: string;
  region: string;
  cluster: string;
  service: string;
  localPort: number;
  operatorTokenFile: string;
  pidFile: string;
  logFile: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface TunnelChildHandle {
  pid: number;
  exited: Promise<number>;
  killGroup(): void;
}

export interface OpenDashboardSystem {
  awsJson(args: string[]): Promise<unknown>;
  isHealthy(port: number): Promise<boolean>;
  readOperatorToken(file: string): string;
  readPid(pidFile: string): number | null;
  writePid(pidFile: string, pid: number): void;
  removePid(pidFile: string, expectedPid?: number): void;
  killProcessGroup(pid: number): boolean;
  spawnDaemon(): number;
  spawnSsmTunnel(target: string, port: number): TunnelChildHandle;
  openBrowser(url: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

export interface EnsureOpenResult {
  urlWithoutToken: string;
  tunnelAction: 'reused' | 'started';
  daemonPid?: number;
}

export async function resolveRunningTunnelTarget(
  config: Pick<OpenDashboardConfig, 'cluster' | 'service'>,
  awsJson: (args: string[]) => Promise<unknown>,
): Promise<string | null> {
  const listed = (await awsJson([
    'ecs',
    'list-tasks',
    '--cluster',
    config.cluster,
    '--service-name',
    config.service,
    '--desired-status',
    'RUNNING',
  ])) as { taskArns?: unknown };
  const taskArn = Array.isArray(listed?.taskArns) && typeof listed.taskArns[0] === 'string' ? listed.taskArns[0] : null;
  if (!taskArn) return null;

  const described = (await awsJson([
    'ecs',
    'describe-tasks',
    '--cluster',
    config.cluster,
    '--tasks',
    taskArn,
  ])) as {
    tasks?: {
      lastStatus?: string;
      containers?: { name?: string; runtimeId?: string; lastStatus?: string }[];
    }[];
  };
  const task = described?.tasks?.[0];
  const container = task?.containers?.find((c) => c.name === 'control-plane');
  const taskId = taskArn.split('/').pop();
  if (task?.lastStatus !== 'RUNNING' || container?.lastStatus !== 'RUNNING' || !container.runtimeId || !taskId) {
    return null;
  }
  return `ecs:${config.cluster}_${taskId}_${container.runtimeId}`;
}

export function stopManagedTunnel(pidFile: string, sys: Pick<OpenDashboardSystem, 'readPid' | 'killProcessGroup' | 'removePid'>): boolean {
  const pid = sys.readPid(pidFile);
  if (pid === null) return false;
  const killed = sys.killProcessGroup(pid);
  sys.removePid(pidFile, pid);
  return killed;
}

export async function ensureTunnelAndOpen(config: OpenDashboardConfig, sys: OpenDashboardSystem): Promise<EnsureOpenResult> {
  if (!Number.isInteger(config.localPort) || config.localPort < 1 || config.localPort > 65535) {
    throw new Error(`올바르지 않은 로컬 포트입니다: ${config.localPort}`);
  }
  const token = sys.readOperatorToken(config.operatorTokenFile);
  const baseUrl = `http://127.0.0.1:${config.localPort}`;
  const fullUrl = `${baseUrl}/#token=${encodeURIComponent(token)}`;

  if (await sys.isHealthy(config.localPort)) {
    sys.openBrowser(fullUrl);
    return { urlWithoutToken: baseUrl, tunnelAction: 'reused' };
  }

  // Tunnel is not reachable: clean up any stale managed daemon, check that AWS Control Plane is RUNNING,
  // and launch the auto-reconnecting background tunnel supervisor.
  stopManagedTunnel(config.pidFile, sys);

  const target = await resolveRunningTunnelTarget(config, (args) => sys.awsJson(args));
  if (!target) {
    throw new Error('실행 중인 AWS Control Plane 작업이 없습니다. 먼저 make aws-up 으로 기동하세요.');
  }

  const daemonPid = sys.spawnDaemon();
  const deadline = sys.now() + (config.readyTimeoutMs ?? 25_000);
  const pollMs = config.pollIntervalMs ?? 500;
  while (sys.now() < deadline) {
    if (await sys.isHealthy(config.localPort)) {
      sys.openBrowser(fullUrl);
      return { urlWithoutToken: baseUrl, tunnelAction: 'started', daemonPid };
    }
    await sys.sleep(pollMs);
  }

  sys.killProcessGroup(daemonPid);
  sys.removePid(config.pidFile, daemonPid);
  throw new Error(
    `SSM 포트 포워딩 터널이 제한 시간 안에 준비되지 않았습니다. 로그를 확인하세요: ${config.logFile}`,
  );
}

export interface SupervisorOptions {
  maxRapidFailures?: number;
  rapidThresholdMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Interval for lightweight GET /health pings that prevent SSM idle timeout without hitting Aurora DSQL. 0 disables. */
  keepaliveIntervalMs?: number;
  signal?: AbortSignal;
}

export async function runTunnelSupervisor(
  config: OpenDashboardConfig,
  sys: OpenDashboardSystem,
  opts: SupervisorOptions = {},
): Promise<{ reconnects: number; stopReason: 'stopped' | 'no_running_task' | 'rapid_failures' }> {
  const maxRapidFailures = opts.maxRapidFailures ?? 5;
  const rapidThresholdMs = opts.rapidThresholdMs ?? 15_000;
  const initialBackoffMs = opts.initialBackoffMs ?? 2_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 15_000;
  const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? 60_000;
  const signal = opts.signal;

  let reconnects = 0;
  let rapidFailures = 0;
  let backoffMs = initialBackoffMs;
  let activeChild: TunnelChildHandle | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const stopKeepalive = () => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
  const onAbort = () => {
    stopKeepalive();
    activeChild?.killGroup();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!signal?.aborted) {
      let target: string | null = null;
      try {
        target = await resolveRunningTunnelTarget(config, (args) => sys.awsJson(args));
      } catch {
        target = null;
      }
      if (signal?.aborted) {
        return { reconnects, stopReason: 'stopped' };
      }
      if (!target) {
        sys.log('실행 중인 Control Plane 작업이 없어 SSM 터널 감시기를 종료합니다.');
        return { reconnects, stopReason: 'no_running_task' };
      }

      const startedAt = sys.now();
      sys.log(`SSM 포트 포워딩 터널 연결: 127.0.0.1:${config.localPort} -> ${target}:4310`);
      activeChild = sys.spawnSsmTunnel(target, config.localPort);
      if (keepaliveIntervalMs > 0) {
        keepaliveTimer = setInterval(() => {
          void sys.isHealthy(config.localPort).catch(() => false);
        }, keepaliveIntervalMs);
        keepaliveTimer.unref?.();
      }
      const code = await activeChild.exited;
      stopKeepalive();
      activeChild.killGroup();
      activeChild = null;

      if (signal?.aborted) {
        return { reconnects, stopReason: 'stopped' };
      }

      const livedMs = sys.now() - startedAt;
      if (livedMs >= rapidThresholdMs) {
        rapidFailures = 0;
        backoffMs = initialBackoffMs;
      } else {
        rapidFailures += 1;
        if (rapidFailures >= maxRapidFailures) {
          sys.log(`SSM 터널이 연속 ${rapidFailures}회 빠르게 종료되어 감시기를 중단합니다 (exit=${code}).`);
          return { reconnects, stopReason: 'rapid_failures' };
        }
      }

      reconnects += 1;
      sys.log(`SSM 터널 종료 (exit=${code}, 유지=${Math.round(livedMs / 1000)}초). ${Math.round(backoffMs / 1000)}초 후 자동 재연결합니다.`);
      await Promise.race([
        sys.sleep(backoffMs),
        new Promise<void>((resolve) => {
          if (!signal) return;
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
    }
    return { reconnects, stopReason: 'stopped' };
  } finally {
    stopKeepalive();
    signal?.removeEventListener('abort', onAbort);
    activeChild?.killGroup();
  }
}
