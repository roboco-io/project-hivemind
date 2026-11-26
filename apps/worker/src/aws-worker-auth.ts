import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryProvider } from '../../../packages/contracts/src/delivery.js';

export interface SealedModelAuthBundle {
  codex?: {
    authJson?: string;
    apiKey?: string;
    model?: string;
  };
  claude?: {
    oauthToken?: string;
    apiKey?: string;
    credentialsJson?: string;
    model?: string;
  };
}

export interface MaterializedProviderAuth {
  env: Record<string, string>;
  model?: string;
  redactSecrets: string[];
  cleanup(): Promise<void>;
}

function collectSecretsFromJson(raw: string, out: Set<string>): void {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const walk = (node: unknown) => {
      if (typeof node === 'string') {
        if (node.length >= 16) out.add(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (/(token|key|secret|auth|password)/i.test(k) && typeof v === 'string' && v.length >= 8) {
            out.add(v);
          } else {
            walk(v);
          }
        }
      }
    };
    walk(parsed);
  } catch {
    if (raw.length >= 16) out.add(raw);
  }
}

export function redactWorkerOutput(raw: string, secrets: string[]): string {
  let out = raw;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret && secret.length >= 8) out = out.replaceAll(secret, '[REDACTED]');
  }
  return out
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|oauth[_-]?token|password|secret)\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]');
}

export function parseSealedModelAuthBundle(secretString: string): SealedModelAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error('ModelSubscriptionAuthSecret must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ModelSubscriptionAuthSecret must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'codex' && key !== 'claude') {
      throw new Error(`Unsupported provider in ModelSubscriptionAuthSecret: ${key}`);
    }
  }
  return obj as SealedModelAuthBundle;
}

export async function materializeProviderAuth(
  provider: DeliveryProvider,
  secretString: string,
  authRoot: string,
): Promise<MaterializedProviderAuth> {
  if (provider !== 'codex' && provider !== 'claude') {
    throw new Error('AWS worker supports only codex or claude providers');
  }
  const bundle = parseSealedModelAuthBundle(secretString);
  await mkdir(authRoot, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(authRoot, `auth-${provider}-`));
  await chmod(dir, 0o700);

  const secrets = new Set<string>();
  const env: Record<string, string> = {};
  let model: string | undefined;

  try {
    if (provider === 'codex') {
      const codex = bundle.codex;
      if (!codex || (!codex.authJson && !codex.apiKey)) {
        throw new Error('ModelSubscriptionAuthSecret is missing codex credentials');
      }
      env.CODEX_HOME = dir;
      if (codex.authJson) {
        const authPath = join(dir, 'auth.json');
        await writeFile(authPath, codex.authJson, { encoding: 'utf8', mode: 0o600 });
        await chmod(authPath, 0o600);
        collectSecretsFromJson(codex.authJson, secrets);
      }
      if (codex.apiKey) {
        env.CODEX_API_KEY = codex.apiKey;
        secrets.add(codex.apiKey);
      }
      if (codex.model?.trim()) model = codex.model.trim();
    } else {
      const claude = bundle.claude;
      if (!claude || (!claude.oauthToken && !claude.apiKey && !claude.credentialsJson)) {
        throw new Error('ModelSubscriptionAuthSecret is missing claude credentials');
      }
      env.CLAUDE_CONFIG_DIR = dir;
      if (claude.oauthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = claude.oauthToken;
        secrets.add(claude.oauthToken);
      }
      if (claude.apiKey) {
        env.ANTHROPIC_API_KEY = claude.apiKey;
        secrets.add(claude.apiKey);
      }
      if (claude.credentialsJson) {
        const credPath = join(dir, '.credentials.json');
        await writeFile(credPath, claude.credentialsJson, { encoding: 'utf8', mode: 0o600 });
        await chmod(credPath, 0o600);
        collectSecretsFromJson(claude.credentialsJson, secrets);
      }
      if (claude.model?.trim()) model = claude.model.trim();
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    env,
    ...(model ? { model } : {}),
    redactSecrets: [...secrets],
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
