import { apiJson, awsJson, ControlPlane, loadOperatorToken, loadRuntimeOutputs, PRIMARY_REGION, sleep } from './lib/aws-live.js';

/**
 * Starts the deployed Seoul Control Plane, reads which storage backend each store reports over the operator
 * API, reads the DSQL start-up log events, and stops the Control Plane again (desiredCount 0).
 * It registers nothing and never prints the operator token.
 */
async function main(): Promise<void> {
  const outputs = loadRuntimeOutputs();
  const controlPlane = ControlPlane.fromOutputs(outputs, Number(process.env.HIVEMIND_LOCAL_PORT ?? '14351'));
  const token = loadOperatorToken(outputs);
  const startedAtMs = Date.now();
  const summary: Record<string, unknown> = {};
  try {
    await controlPlane.start();
    const get = (path: string) => apiJson<Record<string, unknown>>(`${controlPlane.baseUrl}${path}`, token, undefined, 30_000);
    const mf = await get('/api/model-factory/jobs');
    const delivery = await get('/api/delivery/tasks');
    const collab = await get('/api/collab/sessions');
    summary.modelFactory = { storageBackend: mf.storageBackend ?? null, jobs: (mf.jobs as unknown[]).length };
    summary.delivery = { storageBackend: delivery.storageBackend ?? null, tasks: (delivery.tasks as unknown[]).length };
    summary.collab = { storageBackend: collab.storageBackend ?? null, sessions: (collab.sessions as unknown[]).length };
    await sleep(8_000);
    const logs = awsJson<{ events?: { message?: string }[] }>(PRIMARY_REGION, [
      'logs', 'filter-log-events', '--log-group-name', `/hivemind/${process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime'}`,
      '--start-time', String(startedAtMs), '--filter-pattern', '"dsql_enabled"',
    ]);
    summary.startupEvents = (logs.events ?? []).map((e) => (e.message ?? '').slice(0, 240));
  } finally {
    await controlPlane.stop();
  }
  summary.controlPlaneDesiredCount = controlPlane.desiredCount();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
