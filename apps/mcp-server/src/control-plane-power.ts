import { execFile, spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Starts and stops the dormant AWS Control Plane from the local MCP server.
 *
 * The Control Plane service normally has desiredCount 0, and its API is reachable only through an SSM
 * port-forwarding tunnel. Starting it means: raise the ECS service to 1, wait for the task, open the tunnel
 * on the local port of HIVEMIND_API_URL. Stopping it means: close the tunnel and lower the service to 0.
 *
 * Starting is always an explicit tool call, because it starts a billed resource. Stopping is refused while
 * work is in progress, because a running worker reports its result to the Control Plane. When this server
 * started the Control Plane and no tool has been called for the idle period, it stops it on its own.
 */
export interface ControlPlanePowerConfig {
  region: string;
  cluster: string;
  service: string;
  profile?: string;
  idleMinutes?: number;
  /**
   * 'always-on' (default): the service runs all day on Fargate Spot. Start only opens or reopens the tunnel,
   * nothing is lowered on idle or on server exit, and stop needs force. 'on-demand': the earlier
   * behaviour, where a service this server raised is lowered after idleMinutes.
   */
  mode?: 'always-on' | 'on-demand';
}

export interface PowerSystem {
  /** Runs the AWS CLI with the configured profile and region, JSON output. Rejects on a non-zero exit. */
  aws(args: string[]): Promise<string>;
  /** Opens the port-forwarding tunnel. `close` must stop every process of the tunnel. */
  openTunnel(target: string, localPort: number): { close(): void };
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ControlPlanePowerOptions {
  apiUrl: string;
  operatorToken: string;
  config?: ControlPlanePowerConfig;
  system?: PowerSystem;
  /** Raw fetch for this module's own checks. These calls do not count as operator activity. */
  fetchImpl?: typeof fetch;
  startTimeoutMs?: number;
  tunnelTimeoutMs?: number;
  pollMs?: number;
  /**
   * Agent profile: open or reopen the tunnel to a running task and nothing else. The service's desired
   * count is never changed, whatever the configuration or the call.
   */
  tunnelOnly?: boolean;
}

export type PowerState = 'not_configured' | 'stopped' | 'starting' | 'running' | 'unknown';
export interface InProgressWork {
  deliveryTasks: number;
  computeJobs: number;
  collabSubtasks: number;
  /** Ids of the records that count as in progress (at most 10), so the operator can look at or cancel them. */
  blockingIds?: string[];
  /** Records the Control Plane could not settle because it holds no evidence about their worker. */
  unverifiable?: { id: string; reason: string }[];
}
export interface StartResult {
  state: PowerState;
  started: boolean;
  alreadyRunning?: boolean;
  startedInSeconds?: number;
  idleStopAfterMinutes?: number;
  reason?: string;
}
export interface StopResult {
  stopped: boolean;
  alreadyStopped?: boolean;
  inProgress?: InProgressWork;
  reason?: string;
}

const NAME = /^[A-Za-z0-9._-]{1,128}$/;
export const DEFAULT_IDLE_MINUTES = 15;
const NOT_CONFIGURED =
  'Control Plane 기동 설정이 없습니다. `npm run bootstrap`이 ~/.hivemind/aws-control-plane.json 을 만듭니다. 이 파일이 없으면 서비스와 터널을 직접 켜야 합니다.';

/** Reads the non-secret settings file written by the bootstrap. Returns undefined when it is absent or invalid. */
export function loadControlPlanePowerConfig(path: string): ControlPlanePowerConfig | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 4096) return undefined;
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { region, cluster, service, profile, idleMinutes, mode } = value;
    if (typeof region !== 'string' || typeof cluster !== 'string' || typeof service !== 'string') return undefined;
    if (![region, cluster, service].every((name) => NAME.test(name))) return undefined;
    if (profile !== undefined && (typeof profile !== 'string' || !NAME.test(profile))) return undefined;
    if (idleMinutes !== undefined && (typeof idleMinutes !== 'number' || !Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 720)) return undefined;
    if (mode !== undefined && mode !== 'always-on' && mode !== 'on-demand') return undefined;
    return { region, cluster, service, ...(profile ? { profile } : {}), ...(idleMinutes ? { idleMinutes } : {}), ...(mode ? { mode } : {}) };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

export function createRealPowerSystem(config: ControlPlanePowerConfig): PowerSystem {
  const base = [...(config.profile ? ['--profile', config.profile] : []), '--region', config.region];
  return {
    aws: (args) =>
      new Promise((resolve, reject) => {
        execFile('aws', [...base, ...args, '--output', 'json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          // The CLI's own error text is not passed on: it can name account resources.
          if (error) reject(new Error('aws_cli_failed'));
          else resolve(stdout);
        });
      }),
    openTunnel: (target, localPort) => {
      // Own process group: `aws` starts session-manager-plugin, which is the process that holds the port.
      const child = spawn(
        'aws',
        [...base, 'ssm', 'start-session', '--target', target, '--document-name', 'AWS-StartPortForwardingSession', '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(localPort)] })],
        { stdio: 'ignore', detached: true },
      );
      child.on('error', () => undefined);
      const close = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      };
      process.once('exit', close);
      return { close: () => { process.removeListener('exit', close); close(); } };
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }),
    now: () => Date.now(),
  };
}

export class ControlPlanePower {
  private readonly config: ControlPlanePowerConfig | undefined;
  private readonly system: PowerSystem | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly port: number | null;
  private tunnel: { close(): void } | null = null;
  /** True when this server raised the service or opened the tunnel. Only then does it stop on idle. */
  private owned = false;
  private starting: Promise<StartResult> | null = null;
  /** Result of a start whose caller stopped waiting. The next start call receives it once. */
  private unclaimedStart: StartResult | null = null;
  private startWaiters = 0;
  private lastActivityAt = 0;
  private nextIdleCheckAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private checkingIdle = false;

  constructor(private readonly options: ControlPlanePowerOptions) {
    this.config = options.config;
    this.system = options.system ?? (options.config ? createRealPowerSystem(options.config) : undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
    const url = new URL(options.apiUrl);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    this.port = url.protocol === 'http:' && loopback && url.port ? Number(url.port) : null;
  }

  get idleMinutes(): number {
    return this.config?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  }
  /** True unless the configuration asks for the on-demand mode. */
  get alwaysOn(): boolean {
    return this.options.tunnelOnly === true || this.config?.mode !== 'on-demand';
  }

  get configured(): boolean {
    return Boolean(this.config && this.system && this.port);
  }
  get ownsControlPlane(): boolean {
    return this.owned;
  }

  /** Every operator tool call goes through this, so the idle period restarts on real use only. */
  markActivity(): void {
    if (this.system) this.lastActivityAt = this.system.now();
  }

  private async api(method: 'GET' | 'POST', path: string, timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.fetchImpl(new URL(path, this.options.apiUrl), {
        method,
        redirect: 'error',
        headers: { authorization: `Bearer ${this.options.operatorToken}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async reachable(): Promise<boolean> {
    return (await this.api('GET', '/api/compute/ledger', 4_000)) !== null;
  }

  private async desiredCount(): Promise<number | null> {
    try {
      const raw = await this.system!.aws(['ecs', 'describe-services', '--cluster', this.config!.cluster, '--services', this.config!.service]);
      const count = (JSON.parse(raw) as { services?: { desiredCount?: unknown }[] }).services?.[0]?.desiredCount;
      return typeof count === 'number' ? count : null;
    } catch {
      return null;
    }
  }

  private async setDesiredCount(count: 0 | 1): Promise<void> {
    if (this.options.tunnelOnly) throw new Error('tunnel-only: the desired count is never changed');
    await this.system!.aws(['ecs', 'update-service', '--cluster', this.config!.cluster, '--service', this.config!.service, '--desired-count', String(count)]);
  }

  /** `ecs:<cluster>_<taskId>_<runtimeId>` of the running control-plane container, or null while it is not up. */
  private async tunnelTarget(): Promise<string | null> {
    try {
      const listed = JSON.parse(await this.system!.aws(['ecs', 'list-tasks', '--cluster', this.config!.cluster, '--service-name', this.config!.service, '--desired-status', 'RUNNING'])) as { taskArns?: string[] };
      const taskArn = listed.taskArns?.[0];
      if (!taskArn) return null;
      const described = JSON.parse(await this.system!.aws(['ecs', 'describe-tasks', '--cluster', this.config!.cluster, '--tasks', taskArn])) as {
        tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string; lastStatus?: string }[] }[];
      };
      const task = described.tasks?.[0];
      const container = task?.containers?.find((c) => c.name === 'control-plane');
      const taskId = taskArn.split('/').pop();
      if (task?.lastStatus !== 'RUNNING' || container?.lastStatus !== 'RUNNING' || !container.runtimeId || !taskId) return null;
      return `ecs:${this.config!.cluster}_${taskId}_${container.runtimeId}`;
    } catch {
      return null;
    }
  }

  async state(): Promise<PowerState> {
    if (!this.configured) return 'not_configured';
    if (this.starting) return 'starting';
    if (await this.reachable()) return 'running';
    const desired = await this.desiredCount();
    if (desired === null) return 'unknown';
    return desired === 0 ? 'stopped' : 'starting';
  }

  /**
   * Starts the Control Plane. Calling it again while a start is in progress joins that start.
   * `waitMs` bounds how long this call waits; the start itself continues after the call returns.
   */
  async start(waitMs = 50_000): Promise<StartResult> {
    if (!this.configured) return { state: 'not_configured', started: false, reason: NOT_CONFIGURED };
    this.markActivity();
    if (!this.starting) {
      if (this.unclaimedStart) {
        // The start this caller was told to ask about again has finished in the meantime.
        const finished = this.unclaimedStart;
        this.unclaimedStart = null;
        return finished;
      }
      const run: Promise<StartResult> = this.doStart().then((result) => {
        if (this.startWaiters === 0) this.unclaimedStart = result;
        return result;
      }).finally(() => {
        this.starting = null;
      });
      this.starting = run;
      run.catch(() => undefined);
    }
    const pending = this.starting;
    this.startWaiters += 1;
    const timedOut = Symbol('timeout');
    // Wall-clock bound of this call only. It is not `system.sleep`: the start keeps its own pace.
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([pending, new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), waitMs); timer.unref(); })]);
    clearTimeout(timer);
    this.startWaiters -= 1;
    if (outcome === timedOut) {
      return { state: 'starting', started: false, reason: '기동 중입니다. 보통 1-2분 걸립니다. 잠시 뒤 hivemind_control_plane_start 를 다시 호출하면 결과를 받습니다.' };
    }
    return outcome as StartResult;
  }

  private async doStart(): Promise<StartResult> {
    const system = this.system!;
    const startedAt = system.now();
    const pollMs = this.options.pollMs ?? 5_000;
    if (await this.reachable()) {
      this.armIdleTimer();
      return { state: 'running', started: false, alreadyRunning: true, ...(this.owned ? { idleStopAfterMinutes: this.idleMinutes } : {}) };
    }
    const desired = await this.desiredCount();
    if (desired === null) return { state: 'unknown', started: false, reason: 'ECS 서비스 상태를 조회하지 못했습니다. AWS CLI 설치, 프로필과 로그인 상태를 확인하세요.' };
    let raisedByThisCall = false;
    if (desired === 0 && this.options.tunnelOnly) {
      return { state: 'stopped', started: false, reason: 'Control Plane 서비스가 0이라 터널을 열 수 없습니다. 에이전트 프로필은 서비스를 올리지 않습니다. 운영자에게 알리세요.' };
    }
    if (desired === 0) {
      try {
        await this.setDesiredCount(1);
      } catch {
        return { state: 'stopped', started: false, reason: 'ECS 서비스를 올리지 못했습니다. AWS 권한과 로그인 상태를 확인하세요.' };
      }
      raisedByThisCall = true;
      this.owned = !this.alwaysOn;
    }
    const undo = async (reason: string): Promise<StartResult> => {
      this.closeTunnel();
      // Only what this call raised is lowered again; a service someone else started is left alone.
      if (raisedByThisCall) {
        await this.setDesiredCount(0).catch(() => undefined);
        this.owned = false;
        return { state: 'stopped', started: false, reason: `${reason} 올렸던 서비스는 다시 0으로 내렸습니다.` };
      }
      return { state: 'unknown', started: false, reason };
    };

    const taskDeadline = startedAt + (this.options.startTimeoutMs ?? 300_000);
    let target: string | null = null;
    while (!(target = await this.tunnelTarget())) {
      if (system.now() >= taskDeadline) return undo('Control Plane 작업이 제한 시간 안에 실행 상태가 되지 않았습니다.');
      await system.sleep(pollMs);
    }
    this.closeTunnel();
    this.tunnel = system.openTunnel(target, this.port!);
    // In the always-on mode nobody owns the service: it is never lowered on idle or on exit.
    this.owned = !this.alwaysOn;
    const tunnelDeadline = system.now() + (this.options.tunnelTimeoutMs ?? 90_000);
    while (!(await this.reachable())) {
      if (system.now() >= tunnelDeadline) return undo('터널을 열었지만 Control Plane API가 응답하지 않았습니다. session-manager-plugin 설치와 로컬 포트 사용 여부를 확인하세요.');
      await system.sleep(Math.min(pollMs, 2_000));
    }
    this.markActivity();
    this.armIdleTimer();
    return { state: 'running', started: true, startedInSeconds: Math.round((system.now() - startedAt) / 1000), ...(this.owned ? { idleStopAfterMinutes: this.idleMinutes } : {}) };
  }

  /**
   * Work that needs the Control Plane to stay up. Before counting, the Control Plane is asked to settle work
   * whose worker no longer exists; it marks such work failed only on evidence from ECS. Without that step a
   * record left `running` by a lost worker would keep the Control Plane up for ever.
   */
  async inProgress(): Promise<InProgressWork | null> {
    const settled = await this.api('POST', '/api/delivery/reconcile', 35_000);
    const delivery = await this.api('GET', '/api/delivery/tasks');
    const jobs = await this.api('GET', '/api/compute/jobs');
    const collab = await this.api('GET', '/api/collab/sessions');
    if (!delivery || !jobs || !collab) return null;
    const ID = /^[a-z]{2,4}-[0-9a-f-]{36}$/;
    const blockingIds: string[] = [];
    const count = (items: unknown, status: string) => {
      const matching = Array.isArray(items) ? items.filter((item) => (item as { status?: unknown } | null)?.status === status) : [];
      for (const item of matching) {
        const id = (item as { id?: unknown }).id;
        if (typeof id === 'string' && ID.test(id) && blockingIds.length < 10) blockingIds.push(id);
      }
      return matching.length;
    };
    let collabSubtasks = 0;
    const active = (Array.isArray(collab.sessions) ? collab.sessions : []).filter((s) => (s as { status?: unknown } | null)?.status === 'active').slice(0, 25);
    for (const session of active) {
      const id = (session as { id?: unknown }).id;
      if (typeof id !== 'string' || !/^ses-[0-9a-f-]{36}$/.test(id)) continue;
      await this.api('POST', `/api/collab/sessions/${id}/reconcile`, 35_000);
      const snapshot = await this.api('GET', `/api/collab/sessions/${id}`);
      if (!snapshot) return null;
      collabSubtasks += count(snapshot.subtasks, 'running');
    }
    const deliveryTasks = count(delivery.tasks, 'running');
    const computeJobs = count(jobs.jobs, 'running');
    const unverifiable = (Array.isArray(settled?.untouched) ? settled.untouched : [])
      .map((entry) => entry as { taskId?: unknown; reason?: unknown })
      .filter((entry): entry is { taskId: string; reason: string } => typeof entry.taskId === 'string' && ID.test(entry.taskId) && typeof entry.reason === 'string')
      .slice(0, 10)
      .map((entry) => ({ id: entry.taskId, reason: entry.reason.slice(0, 160) }));
    return { deliveryTasks, computeJobs, collabSubtasks, ...(blockingIds.length ? { blockingIds } : {}), ...(unverifiable.length ? { unverifiable } : {}) };
  }

  /**
   * Always-on mode only: reopens the tunnel to the current task after a Spot replacement or a dropped
   * tunnel. It never raises a service that is at 0; that takes hivemind_control_plane_start.
   */
  async reconnect(waitMs = 60_000): Promise<StartResult | null> {
    if (!this.configured || !this.alwaysOn) return null;
    const desired = await this.desiredCount();
    if (desired === null || desired < 1) return null;
    return this.start(waitMs);
  }

  async stop(force = false): Promise<StopResult> {
    if (!this.configured) return { stopped: false, reason: NOT_CONFIGURED };
    if (this.options.tunnelOnly) {
      return { stopped: false, reason: '에이전트 프로필은 Control Plane을 내리지 않습니다.' };
    }
    if (this.alwaysOn && !force) {
      return { stopped: false, reason: 'Control Plane은 Fargate Spot에서 상시 운영 중입니다. 그래도 내리려면 force: true 로 호출하세요. 내린 서비스는 hivemind_control_plane_start 로 다시 올립니다.' };
    }
    if (this.starting) await this.starting.catch(() => undefined);
    this.unclaimedStart = null;
    const up = await this.reachable();
    if (!up) {
      const desired = await this.desiredCount();
      if (desired === 0) {
        this.closeTunnel();
        this.owned = false;
        this.disarmIdleTimer();
        return { stopped: true, alreadyStopped: true };
      }
      if (!force) {
        return { stopped: false, reason: 'Control Plane API에 연결할 수 없어 진행 중인 작업을 확인하지 못했습니다. 그래도 내리려면 force: true 로 호출하세요.' };
      }
    } else if (!force) {
      const work = await this.inProgress();
      if (!work) return { stopped: false, reason: '진행 중인 작업을 확인하지 못했습니다. 그래도 내리려면 force: true 로 호출하세요.' };
      if (work.deliveryTasks + work.computeJobs + work.collabSubtasks > 0) {
        return { stopped: false, inProgress: work, reason: '진행 중인 작업이 있어 내리지 않았습니다. 실행 중인 워커는 결과를 Control Plane에 보고합니다. 작업이 끝난 뒤 다시 호출하거나, 그래도 내리려면 force: true 로 호출하세요.' };
      }
    }
    this.closeTunnel();
    try {
      await this.setDesiredCount(0);
    } catch {
      return { stopped: false, reason: 'ECS 서비스를 내리지 못했습니다. AWS 권한과 로그인 상태를 확인하세요. 서비스가 계속 실행 중일 수 있습니다.' };
    }
    this.owned = false;
    this.disarmIdleTimer();
    return { stopped: true };
  }

  private closeTunnel(): void {
    this.tunnel?.close();
    this.tunnel = null;
  }

  private armIdleTimer(): void {
    if (!this.owned || this.idleTimer) return;
    this.idleTimer = setInterval(() => void this.checkIdle(), 60_000);
    this.idleTimer.unref();
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stops the Control Plane when this server started it, nothing was called for the idle period, and no work is in progress. */
  async checkIdle(): Promise<'not_owned' | 'active' | 'busy' | 'stopped' | 'failed'> {
    if (!this.owned || !this.system) return 'not_owned';
    const now = this.system.now();
    if (this.checkingIdle || this.starting || now - this.lastActivityAt < this.idleMinutes * 60_000 || now < this.nextIdleCheckAt) return 'active';
    this.checkingIdle = true;
    try {
      const result = await this.stop(false);
      if (result.stopped) return 'stopped';
      // Work in progress or an unreadable state: look again later instead of every minute.
      this.nextIdleCheckAt = this.system.now() + 5 * 60_000;
      return result.inProgress ? 'busy' : 'failed';
    } finally {
      this.checkingIdle = false;
    }
  }

  /**
   * Called when the MCP server closes. The idle timer ends with the server, so a Control Plane this server
   * started would otherwise stay up with nobody watching it. It is lowered unless work is in progress.
   */
  async shutdown(timeoutMs = 20_000): Promise<'not_owned' | 'stopped' | 'left_running'> {
    this.disarmIdleTimer();
    let outcome: 'not_owned' | 'stopped' | 'left_running' = 'not_owned';
    if (this.owned && this.system) {
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([this.stop(false).catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref(); })]);
      clearTimeout(timer);
      outcome = result?.stopped ? 'stopped' : 'left_running';
    }
    this.closeTunnel();
    return outcome;
  }
}

export function registerControlPlanePowerTools(server: McpServer, power: ControlPlanePower): void {
  const result = (output: object): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output as Record<string, unknown> });

  server.registerTool(
    'hivemind_control_plane_start',
    {
      title: 'Control Plane 기동',
      description:
        '휴지 상태(desiredCount 0)인 AWS Control Plane을 켜고 로컬 SSM 터널을 엽니다. Fargate 작업이 실행되어 과금되므로 사용자가 HIVEMIND 사용을 요청했을 때만 호출하세요. 기동에는 보통 1-2분이 걸리며, 이 호출이 먼저 끝나면 state가 starting으로 돌아옵니다. 그때는 잠시 뒤 다시 호출하세요. 이 서버가 켠 Control Plane은 도구 호출이 일정 시간 없고 진행 중인 작업도 없으면 스스로 내립니다.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => result(await power.start()),
  );

  server.registerTool(
    'hivemind_control_plane_stop',
    {
      title: 'Control Plane 종료',
      description:
        '터널을 닫고 AWS Control Plane을 desiredCount 0으로 내립니다. 먼저 워커가 사라진 작업을 정리한 뒤 진행 중인 작업을 셉니다. 진행 중인 SW 전달 작업, 학습 작업, 협업 하위 작업이 있으면 내리지 않고 그 건수를 돌려줍니다. force: true 는 이 확인을 건너뛰며, 실행 중인 워커가 결과를 보고하지 못하게 되므로 사용자가 명시적으로 지시했을 때만 쓰세요.',
      inputSchema: z.strictObject({ force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => result(await power.stop(args.force === true)),
  );
}
