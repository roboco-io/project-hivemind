import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

async function readTokenFromStdin(): Promise<string> {
  if (process.env.HIVEMIND_GITHUB_PAT?.trim()) {
    return process.env.HIVEMIND_GITHUB_PAT.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const chunks: string[] = [];
  for await (const line of rl) chunks.push(line);
  return chunks.join('').trim();
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const repository = process.env.HIVEMIND_GITHUB_REPOSITORY ?? 'roboco-io/project-hivemind';
  const secretId = process.env.HIVEMIND_GITHUB_SECRET_ID ?? 'hivemind-runtime/github-draft-pr';

  const token = await readTokenFromStdin();
  if (!token || token.length < 20 || /\s/.test(token)) {
    throw new Error('Provide a valid GitHub Fine-Grained PAT via HIVEMIND_GITHUB_PAT or stdin.');
  }

  // Verify token can access the target repository without printing or logging the token.
  const verifyRes = await fetch(`https://api.github.com/repos/${repository}`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'project-hivemind-secret-rotator',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!verifyRes.ok) {
    throw new Error(`GitHub repository check for ${repository} failed with HTTP ${verifyRes.status}`);
  }
  const repo = (await verifyRes.json()) as { full_name?: string; permissions?: { push?: boolean; pull?: boolean } };
  if (repo.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub token verification returned unexpected repository');
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

  // Also check if ControlPlaneService outputs file exists to remind operator if service is stopped.
  let hint = '';
  try {
    const outputs = JSON.parse(readFileSync('/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    if (outputs.HivemindAwsRuntimeStack?.ControlPlaneServiceName) {
      hint = `Service ${outputs.HivemindAwsRuntimeStack.ControlPlaneServiceName} loads this secret dynamically per Draft PR publication.`;
    }
  } catch {
    // optional
  }

  console.log(
    JSON.stringify({
      ok: true,
      repository: repo.full_name,
      pushPermission: Boolean(repo.permissions?.push),
      fineGrainedPrefix: token.startsWith('github_pat_'),
      secret: JSON.parse(out),
      ...(hint ? { note: hint } : {}),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
