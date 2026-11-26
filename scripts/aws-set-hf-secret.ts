import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

async function readTokenFromStdin(): Promise<string> {
  if (process.env.HIVEMIND_HF_TOKEN?.trim()) {
    return process.env.HIVEMIND_HF_TOKEN.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const chunks: string[] = [];
  for await (const line of rl) chunks.push(line);
  return chunks.join('').trim();
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const secretId = process.env.HIVEMIND_HF_SECRET_ID ?? 'hivemind-runtime/hf-release-token';
  const requiredOrg = process.env.HIVEMIND_HF_REQUIRED_ORG?.trim();

  const token = await readTokenFromStdin();
  if (!token || token.length < 20 || /\s/.test(token)) {
    throw new Error('Provide a valid Hugging Face token via HIVEMIND_HF_TOKEN or stdin.');
  }

  // Verify token identity via HF whoami-v2 without logging or echoing the token.
  const verifyRes = await fetch('https://huggingface.co/api/whoami-v2', {
    method: 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'project-hivemind-hf-secret-rotator',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!verifyRes.ok) {
    throw new Error(`Hugging Face whoami-v2 failed with HTTP ${verifyRes.status}`);
  }
  const whoami = (await verifyRes.json()) as {
    name?: string;
    auth?: { type?: string; accessToken?: { role?: string } };
    orgs?: { name?: string; roleInOrg?: string }[];
  };

  if (requiredOrg) {
    const matched = (whoami.orgs ?? []).find(
      (org) => org.name?.toLowerCase() === requiredOrg.toLowerCase(),
    );
    if (!matched) {
      throw new Error(`Hugging Face token does not belong to required org: ${requiredOrg}`);
    }
  }

  const payload = JSON.stringify({ token });
  const out = execFileSync(
    'aws',
    [
      '--profile',
      profile,
      '--region',
      region,
      'secretsmanager',
      'put-secret-value',
      '--secret-id',
      secretId,
      '--secret-string',
      payload,
      '--query',
      '{Name:Name,VersionId:VersionId}',
      '--output',
      'json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  console.log(
    JSON.stringify({
      ok: true,
      user: whoami.name ?? null,
      tokenRole: whoami.auth?.accessToken?.role ?? null,
      orgs: (whoami.orgs ?? []).map((o) => ({ name: o.name ?? null, role: o.roleInOrg ?? null })),
      secret: JSON.parse(out),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
