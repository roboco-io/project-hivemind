import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { handleProbe, type ProbeKind } from './handler.ts';
import { codexOutbound, claudeOutbound } from './outbound.ts';

interface Env {
  CF_VERSION_METADATA?: {id:string};
  PHASE0: DurableObjectNamespace<Phase0Container>;
  PROBE_TOKEN?: string;
  CODEX_AUTH_JSON?: string;
  AUTH_RETURN_PUBLIC_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}

export class CodexOutbound extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return codexOutbound(request, request => fetch(request, { redirect: 'manual' }));
  }
}

export class ClaudeOutbound extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return claudeOutbound(request, request => fetch(request, { redirect: 'manual' }));
  }
}

export class Phase0Container extends DurableObject<Env> {
  private inflight?: Promise<unknown>;

  async diagnostics(kind: ProbeKind) {
    if (!this.inflight) {
      this.inflight = this.run(kind).finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  private async run(kind: ProbeKind) {
    const container = this.ctx.container;
    if (!container) throw new Error('Container binding is unavailable');
    if (kind === 'codex') {
      if (!this.env.CODEX_AUTH_JSON || !this.env.AUTH_RETURN_PUBLIC_KEY) throw new Error('Subscription probe is not configured');
      const accepted = await this.ctx.blockConcurrencyWhile(async () => {
        if (this.ctx.storage.kv.get('codex-probe-v4-used')) return false;
        this.ctx.storage.kv.put('codex-probe-v4-used', true);
        return true;
      });
      if (!accepted) throw new Error('One-shot subscription probe already used');
    }
    if (kind === 'claude') {
      if (!this.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('Claude subscription probe is not configured');
      const accepted = await this.ctx.blockConcurrencyWhile(async () => {
        if (this.ctx.storage.kv.get('claude-probe-v5-used')) return false;
        this.ctx.storage.kv.put('claude-probe-v5-used', true);
        return true;
      });
      if (!accepted) throw new Error('One-shot Claude probe already used');
    }
    try {
      if (!container.running) {
        container.start({
          image: container.images.probe,
          instance: 'standard-1',
          entrypoint: ['sleep', '120'],
          enableInternet: false,
        });
      }
      if (kind === 'codex') {
        await container.interceptAllOutboundHttp(this.ctx.exports.CodexOutbound);
        await container.interceptOutboundHttps('*', this.ctx.exports.CodexOutbound);
      }
      if (kind === 'claude') {
        await container.interceptAllOutboundHttp(this.ctx.exports.ClaudeOutbound);
        await container.interceptOutboundHttps('*', this.ctx.exports.ClaudeOutbound);
      }
      const sandboxScript = `
awk '/^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):/ { print }' /proc/self/status
printf before > /home/node/phase0-outside.txt
printf before > /workspace/phase0-inside.txt
codex sandbox -P :workspace -- sh -ec 'printf inside > /workspace/phase0-inside.txt; if (printf escaped > /home/node/phase0-outside.txt) 2>/dev/null; then exit 31; fi; printf "WORKSPACE_WRITE_OK_OUTSIDE_WRITE_DENIED\\n"'
test "$(cat /home/node/phase0-outside.txt)" = before
codex sandbox -P :read-only -- sh -ec 'if (printf changed > /workspace/phase0-inside.txt) 2>/dev/null; then exit 32; fi; printf "READONLY_WRITE_DENIED\\n"'
test "$(cat /workspace/phase0-inside.txt)" = inside
node -e 'const keys=["CLOUDFLARE_API_TOKEN","CF_API_TOKEN","PROBE_TOKEN","AUTH_WRAP_KEY"]; console.log(JSON.stringify(Object.fromEntries(keys.map(k=>[k,Boolean(process.env[k])])))); if(keys.some(k=>process.env[k])) process.exit(33)'
printf "HIVEMIND_SANDBOX_BOUNDARIES_VERIFIED\\n"
`;
      const diagnosticCommand = kind === 'claude-concurrency' ? ['node', '/opt/hivemind/scripts/phase0/claude-command-concurrency-probe.ts'] : kind === 'compute-stdio' ? ['node', '/opt/hivemind/scripts/phase0/compute-stdio-probe.ts'] : kind === 'claude-layer' ? ['node', '/opt/hivemind/scripts/phase0/claude-codex-layer-probe.ts'] : kind === 'landlock' ? ['node', '/opt/hivemind/scripts/phase0/landlock-probe.ts'] : kind === 'codex-boundary' ? ['node', '/opt/hivemind/scripts/phase0/codex-boundary-probe.ts', '--builtin-control'] : kind === 'claude-boundary' ? [
        'node', '/opt/hivemind/scripts/phase0/claude-boundary-probe.ts',
      ] : kind === 'claude' ? [
        'node', '/opt/hivemind/scripts/phase0/claude-probe.ts',
      ] : kind === 'codex' ? [
        'node', '/opt/hivemind/scripts/phase0/codex-probe.ts',
      ] : kind === 'sandbox' ? [
        'sh', '-ec',
        sandboxScript,
      ] : [
        'sh', '-ec',
        'id -u; node --version; codex --version; claude --version; node --test /opt/hivemind/tests/phase0-mcp.test.ts',
      ];
      // Remote exec supplied ambient capabilities even for UID 1000.
      // Remove privileges instead of disabling Codex's sandbox.
      const command = [
        'setpriv', '--no-new-privs', '--inh-caps=-all', '--ambient-caps=-all',
        '--bounding-set=-all', ...diagnosticCommand,
      ];
      const env = kind === 'claude' ? {
        HIVEMIND_CLAUDE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN!,
        SSL_CERT_FILE: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      } : kind === 'codex' ? {
        HIVEMIND_CODEX_AUTH_JSON: this.env.CODEX_AUTH_JSON!,
        HIVEMIND_AUTH_RETURN_PUBLIC_KEY: this.env.AUTH_RETURN_PUBLIC_KEY!,
        SSL_CERT_FILE: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      } : {};
      const process = await container.exec(command, { cwd: '/workspace', env });
      const output = await process.output();
      await container.destroy();
      if(kind==='claude-boundary'||kind==='codex-boundary'||kind==='landlock'||kind==='claude-layer'||kind==='compute-stdio'||kind==='claude-concurrency')return {...JSON.parse(new TextDecoder().decode(output.stdout)),containerStopped:!container.running};
      if (kind === 'codex' || kind === 'claude') {
        if (output.exitCode !== 0) throw new Error('Subscription fixture failed before encrypted auth return');
        const data = JSON.parse(new TextDecoder().decode(output.stdout));
        return { ...data, containerStopped: !container.running };
      }
      return {
        scope: kind === 'sandbox' ? 'cloudflare-codex-filesystem-boundaries' : 'cloudflare-container-prerequisites-only',
        exitCode: output.exitCode,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
        containerStopped: !container.running,
      };
    } finally {
      if (container.running) await container.destroy();
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const response=await handleProbe(request, env.PROBE_TOKEN, async kind => ({...await env.PHASE0.getByName(`phase0-${kind}-v1`).diagnostics(kind) as object, workerVersion:env.CF_VERSION_METADATA?.id}));
    response.headers.set('X-Hivemind-Probe-Revision','boundary-20261110-r3');
    return response;
  },
};
