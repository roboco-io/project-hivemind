import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface AgentCredentialsMcpOptions {
  apiUrl: string;
  operatorToken: string;
  fetchImpl?: typeof fetch;
  /** Where credential files are written. Default: ~/.hivemind/agent-credentials. */
  credentialsDir?: string;
}

const TOOL_ERROR = 'HIVEMIND 최소 권한 자격 증명을 받지 못했습니다. Control Plane 연결과 목적 설정을 확인하세요.';

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

/** Writes an AWS shared credentials file readable only by this OS user. The secret never enters the tool result. */
export function writeCredentialFile(
  dir: string,
  profile: string,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
  region: string,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Credential directory must be a real directory');
  chmodSync(dir, 0o700);
  for (const value of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken, region]) {
    if (/[\r\n[\]]/.test(value)) throw new Error('Credential value contains a line break');
  }
  const file = join(dir, `${profile}.ini`);
  const temp = join(dir, `.${profile}.${process.pid}.${Date.now()}.tmp`);
  const body =
    `[${profile}]\n` +
    `aws_access_key_id = ${credentials.accessKeyId}\n` +
    `aws_secret_access_key = ${credentials.secretAccessKey}\n` +
    `aws_session_token = ${credentials.sessionToken}\n` +
    `region = ${region}\n`;
  writeFileSync(temp, body, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  return file;
}

export function registerAgentCredentialTools(server: McpServer, options: AgentCredentialsMcpOptions): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dir = options.credentialsDir ?? join(homedir(), '.hivemind', 'agent-credentials');

  server.registerTool(
    'hivemind_agent_credentials',
    {
      title: 'HIVEMIND 최소 권한 AWS 자격 증명 발급',
      description:
        '정해진 목적(purpose)에 필요한 권한만 가진 단기 AWS 자격 증명을 Control Plane에서 받아 이 컴퓨터의 자격 증명 파일에 씁니다. ' +
        '목적은 spot-placement-read(스팟 배치 점수·가격 조회), project-inputs-upload(projects/<projectId>/<workloadId>/inputs/ 업로드), project-artifacts-read(projects/<projectId>/<workloadId>/runs/ 읽기), model-inputs-upload, model-artifacts-read입니다. ' +
        '결과의 credentialsFile과 profile을 AWS_SHARED_CREDENTIALS_FILE, AWS_PROFILE로 지정해 AWS CLI를 실행하세요. 비밀 키는 결과에 넣지 않습니다. 만료되면 다시 호출합니다.',
      inputSchema: z.strictObject({
        purpose: z.enum(['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read', 'model-inputs-upload', 'model-artifacts-read']),
        projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/).optional(),
        workloadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/).optional(),
        modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/).optional(),
        durationSeconds: z.number().int().min(60).max(900).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra): Promise<CallToolResult> => {
      let response: Response;
      try {
        response = await fetchImpl(new URL('/api/agent-credentials', options.apiUrl), {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${options.operatorToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.any([extra.signal, AbortSignal.timeout(30_000)]),
        });
      } catch {
        return { content: [{ type: 'text', text: TOOL_ERROR }], isError: true };
      }
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !parsed) {
        // A refusal is an ordinary answer: the agent needs the reason (unknown purpose, bad modelId, STS failure).
        const refusal = {
          issued: false,
          httpStatus: response.status,
          error: typeof parsed?.error === 'string' ? parsed.error.slice(0, 300) : TOOL_ERROR,
        };
        return { content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal };
      }
      const credentials = parsed.credentials as Record<string, string> | undefined;
      const region = typeof parsed.region === 'string' ? parsed.region : '';
      if (!credentials || typeof credentials.accessKeyId !== 'string' || !/^[a-z]{2}-[a-z]+-\d+$/.test(region)) {
        return { content: [{ type: 'text', text: TOOL_ERROR }], isError: true };
      }
      const targetName = input.workloadId ?? input.modelId;
      const profile = safeName(`hivemind-${input.purpose}${input.projectId ? `-${input.projectId}` : ''}${targetName ? `-${targetName}` : ''}`);
      let credentialsFile: string;
      try {
        credentialsFile = writeCredentialFile(
          dir,
          profile,
          {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: String(credentials.secretAccessKey),
            sessionToken: String(credentials.sessionToken),
          },
          region,
        );
      } catch {
        return { content: [{ type: 'text', text: TOOL_ERROR }], isError: true };
      }
      const output = {
        issued: true,
        purpose: parsed.purpose,
        target: parsed.target,
        region,
        profile,
        credentialsFile,
        expiration: credentials.expiration,
        policyHash: parsed.policyHash,
        usage: `AWS_SHARED_CREDENTIALS_FILE=${credentialsFile} AWS_PROFILE=${profile} aws ...`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    },
  );
}
