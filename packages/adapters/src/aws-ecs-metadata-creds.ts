import type { AwsEcsCredentials } from './aws-ecs-driver.js';

/**
 * Loads temporary AWS IAM credentials for an ECS Fargate task from the task metadata endpoint
 * (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) or falls back to explicit environment variables for local testing.
 */
export function createEcsTaskCredentialsProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): () => Promise<AwsEcsCredentials> {
  return async () => {
    const relUri = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (relUri) {
      if (!relUri.startsWith('/')) {
        throw new Error('Invalid AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
      }
      const response = await fetchImpl(`http://169.254.170.2${relUri}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`ECS task credentials endpoint failed with HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        Token?: string;
      };
      if (!data.AccessKeyId || !data.SecretAccessKey) {
        throw new Error('Malformed ECS task credentials payload');
      }
      return {
        accessKeyId: data.AccessKeyId,
        secretAccessKey: data.SecretAccessKey,
        ...(data.Token ? { sessionToken: data.Token } : {}),
      };
    }

    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      };
    }

    throw new Error('No AWS ECS task credentials available');
  };
}
