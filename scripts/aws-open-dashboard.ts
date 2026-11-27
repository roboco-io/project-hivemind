import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureTunnelAndOpen,
  runTunnelSupervisor,
  stopManagedTunnel,
  type OpenDashboardConfig,
  type OpenDashboardSystem,
} from './lib/open-dashboard.js';

const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '4310');
const config: OpenDashboardConfig = {
  profile: process.env.AWS_PROFILE ?? 'roboco',
  region: process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2',
  cluster: process.env.HIVEMIND_ECS_CLUSTER ?? 'hivemind-runtime-cluster',
  service: process.env.HIVEMIND_CONTROL_PLANE_SERVICE ?? 'hivemind-runtime-control-plane',
  localPort,
  operatorTokenFile: process.env.OPERATOR_TOKEN_FILE ?? join(homedir(), '.hivemind', 'aws-operator-token.json'),
  pidFile: process.env.HIVEMIND_TUNNEL_PID_FILE ?? join(tmpdir(), `hivemind-ssm-tunnel-${localPort}.pid`),
  logFile: process.env.HIVEMIND_TUNNEL_LOG_FILE ?? join(tmpdir(), `hivemind-ssm-tunnel-${localPort}.log`),
};

const scriptPath = fileURLToPath(import.meta.url);
const ssmTunnelScriptPath = fileURLToPath(new URL('./aws-ssm-tunnel.ts', import.meta.url));
const tsxLoaderPath = fileURLToPath(new URL('../infrastructure/aws-runtime/node_modules/tsx/dist/loader.mjs', import.meta.url));

function createRealSystem(): OpenDashboardSystem {
  const awsBase = ['--profile', config.profile, '--region', config.region];
  return {
    awsJson: (args) =>
      new Promise((resolve, reject) => {
        execFile(
          'aws',
          [...awsBase, ...args, '--output', 'json'],
          { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => {
            if (error) reject(new Error('AWS CLI 조회에 실패했습니다. 로그인·프로필을 확인하세요.'));
            else {
              try {
                resolve(JSON.parse(stdout));
              } catch {
                reject(new Error('AWS CLI 응답을 해석하지 못했습니다.'));
              }
            }
          },
        );
      }),
    isHealthy: async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          redirect: 'error',
          signal: AbortSignal.timeout(2_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    readOperatorToken: (file) => {
      if (!existsSync(file)) {
        throw new Error(`${file} 파일이 없습니다. 먼저 npm run bootstrap 을 확인하세요.`);
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { OPERATOR_TOKEN?: unknown };
      if (typeof parsed?.OPERATOR_TOKEN !== 'string' || !parsed.OPERATOR_TOKEN.trim()) {
        throw new Error('OPERATOR_TOKEN 필드가 비어 있거나 올바르지 않습니다.');
      }
      return parsed.OPERATOR_TOKEN.trim();
    },
    readPid: (pidFile) => {
      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 1 ? pid : null;
      } catch {
        return null;
      }
    },
    writePid: (pidFile, pid) => {
      writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
    },
    removePid: (pidFile, expectedPid) => {
      try {
        if (expectedPid !== undefined) {
          const current = Number(readFileSync(pidFile, 'utf8').trim());
          if (current !== expectedPid) return;
        }
        unlinkSync(pidFile);
      } catch {
        // already removed
      }
    },
    killProcessGroup: (pid) => {
      try {
        process.kill(-pid, 'SIGTERM');
        return true;
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
          return true;
        } catch {
          return false;
        }
      }
    },
    spawnDaemon: () => {
      const logFd = openSync(config.logFile, 'a', 0o600);
      try {
        const child = spawn(process.execPath, ['--import', tsxLoaderPath, scriptPath, '--daemon'], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: {
            ...process.env,
            AWS_PROFILE: config.profile,
            HIVEMIND_AWS_REGION: config.region,
            HIVEMIND_ECS_CLUSTER: config.cluster,
            HIVEMIND_CONTROL_PLANE_SERVICE: config.service,
            HIVEMIND_LOCAL_PORT: String(config.localPort),
            HIVEMIND_TUNNEL_PID_FILE: config.pidFile,
            HIVEMIND_TUNNEL_LOG_FILE: config.logFile,
          },
        });
        child.unref();
        if (!child.pid) throw new Error('SSM 터널 감시기 프로세스를 시작하지 못했습니다.');
        writeFileSync(config.pidFile, `${child.pid}\n`, { mode: 0o600 });
        return child.pid;
      } finally {
        closeSync(logFd);
      }
    },
    spawnSsmTunnel: (_target, port) => {
      // Delegate to scripts/aws-ssm-tunnel.ts so SSM session creation stays centralized
      // and session-manager-plugin is always cleaned up via its process group.
      const child = spawn(process.execPath, ['--import', tsxLoaderPath, ssmTunnelScriptPath], {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
        env: {
          ...process.env,
          AWS_PROFILE: config.profile,
          HIVEMIND_AWS_REGION: config.region,
          HIVEMIND_ECS_CLUSTER: config.cluster,
          HIVEMIND_CONTROL_PLANE_SERVICE: config.service,
          HIVEMIND_LOCAL_PORT: String(port),
        },
      });
      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      };
      const exited = new Promise<number>((resolve) => {
        child.on('error', () => resolve(1));
        child.on('exit', (code) => resolve(code ?? 0));
      });
      return { pid: child.pid ?? 0, exited, killGroup };
    },
    openBrowser: (url) => {
      const cmd = process.env.OPEN_CMD || (process.platform === 'darwin' ? 'open' : 'xdg-open');
      execFileSync(cmd, [url], { stdio: 'ignore' });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => {
      console.log(`[${new Date().toISOString()}] ${message}`);
    },
  };
}

const mode = process.argv[2];
const sys = createRealSystem();

try {
  if (mode === '--stop') {
    const stopped = stopManagedTunnel(config.pidFile, sys);
    console.log(stopped ? '백그라운드 SSM 터널을 종료했습니다.' : '실행 중인 백그라운드 SSM 터널이 없습니다.');
  } else if (mode === '--daemon') {
    sys.writePid(config.pidFile, process.pid);
    const controller = new AbortController();
    const onStop = () => {
      controller.abort();
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, onStop);
    try {
      await runTunnelSupervisor(config, sys, { signal: controller.signal });
    } finally {
      sys.removePid(config.pidFile, process.pid);
    }
  } else {
    const result = await ensureTunnelAndOpen(config, sys);
    if (result.tunnelAction === 'started') {
      console.log(
        `SSM 자동 재연결 터널을 시작하고 관제실을 열었습니다: ${result.urlWithoutToken} (종료: make tunnel-stop, 로그: ${config.logFile})`,
      );
    } else {
      console.log(`관제실을 열었습니다: ${result.urlWithoutToken} (기존 터널·서버 사용, 토큰은 주소창에서 즉시 제거됩니다)`);
    }
  }
} catch (error) {
  console.error(`오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
