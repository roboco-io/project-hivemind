import type { ComputeJob } from '../../contracts/src/compute.js';
import type { ComputeStore } from './compute.js';
import { DomainError } from './store.js';

/**
 * Estimated instance cost from launch to `endedMs`, at the job's maximum hourly price.
 * EC2 Linux bills per second with a 60-second minimum. The result never exceeds the reserved amount.
 * This is an upper-bound estimate from the price cap, not the billed Spot price.
 */
export function calculateActualCostMicros(
  job: ComputeJob,
  endedMs: number,
): { actualCostMicros: number; instanceSeconds: number } {
  const launchedMs = job.instance?.launchedAt ? Date.parse(job.instance.launchedAt) : endedMs;
  const elapsedSeconds = Math.max(1, Math.ceil(Math.max(0, endedMs - launchedMs) / 1000));
  const billedSeconds = Math.max(60, elapsedSeconds);
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
 * Safe to call twice for the same instance. An instance ID that is not the job's current instance is ignored.
 */
export async function settleGuardTermination(
  store: ComputeStore,
  input: { jobId: string; instanceId: string; endedMs: number; reason: string },
): Promise<GuardSettlementResult> {
  const base = { jobId: input.jobId, instanceId: input.instanceId };
  let job: ComputeJob;
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
