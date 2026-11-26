import type { ModelFactoryJob } from '../../contracts/src/model-factory.js';
import type { ModelFactoryStore } from './model-factory.js';
import { DomainError } from './store.js';

/**
 * Estimated instance cost from launch to `endedMs`, at the job's maximum hourly price.
 * EC2 Linux bills per second with a 60-second minimum. The result never exceeds the reserved amount.
 * This is an upper-bound estimate from the price cap, not the billed Spot price.
 */
export function calculateActualCostMicros(
  job: ModelFactoryJob,
  endedMs: number,
): { actualCostMicros: number; instanceSeconds: number } {
  const launchedMs = job.instance?.launchedAt ? Date.parse(job.instance.launchedAt) : endedMs;
  const elapsedSeconds = Math.max(1, Math.ceil(Math.max(0, endedMs - launchedMs) / 1000));
  const billedSeconds = Math.max(60, elapsedSeconds);
  // Rounded to 6 decimals before the ceiling, so binary floating-point noise (90000.00000000001) does not
  // add one micro.
  const rawMicros = Math.ceil(Number(((billedSeconds * job.compute.maxHourlyPriceUsd * 1_000_000) / 3600).toFixed(6)));
  return {
    actualCostMicros: Math.min(rawMicros, job.cost.reservedMicros || rawMicros),
    instanceSeconds: billedSeconds,
  };
}

export type GuardSettlementOutcome =
  | 'settled'
  | 'already_settled'
  | 'job_not_found'
  | 'instance_mismatch';

export interface GuardSettlementResult {
  jobId: string;
  instanceId: string;
  outcome: GuardSettlementOutcome;
  settledMicros: number | null;
}

/**
 * Records in the ledger that the TTL Guard terminated a job's instance, and settles its cost.
 *
 * The TTL Guard Lambda calls this while the Control Plane may be stopped. It only records the termination
 * and the cost. It does not load the S3 receipt and does not fail the job: `nextWakeAt` is cleared, so the
 * Control Plane wakes the job on its next start and finishes those steps.
 *
 * It is safe to call twice for the same instance. An instance ID that is not the job's current instance is
 * ignored, so a stale or forged `hivemind:job-id` tag cannot settle another job.
 */
export async function settleGuardTermination(
  store: ModelFactoryStore,
  input: { jobId: string; instanceId: string; endedMs: number; reason: string },
): Promise<GuardSettlementResult> {
  const base = { jobId: input.jobId, instanceId: input.instanceId };
  let job: ModelFactoryJob;
  try {
    job = await store.get(input.jobId);
  } catch (error) {
    if (error instanceof DomainError && error.statusCode === 404) {
      return { ...base, outcome: 'job_not_found', settledMicros: null };
    }
    throw error;
  }
  if (!job.instance || job.instance.instanceId !== input.instanceId) {
    return { ...base, outcome: 'instance_mismatch', settledMicros: null };
  }
  if (job.cost.settledMicros !== null) {
    return { ...base, outcome: 'already_settled', settledMicros: job.cost.settledMicros };
  }
  const reason = `TTL Guard Lambda forced termination: ${input.reason}`.slice(0, 500);
  job = await store.recordWakeUpdate(job.id, {
    state: 'shutting-down',
    nextWakeAt: null,
    forcedTerminationReason: reason,
    diagnostic: reason,
  });
  const settled = await store.settleCost(job.id, {
    ...calculateActualCostMicros(job, input.endedMs),
    diagnostic: 'Settled by the TTL Guard Lambda after forced termination',
  });
  return { ...base, outcome: 'settled', settledMicros: settled.cost.settledMicros };
}
