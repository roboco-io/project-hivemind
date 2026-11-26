import {
  settleGuardTermination,
  type GuardSettlementResult,
} from '../../core/src/model-factory-guard-settlement.js';
import type { ModelFactoryStore } from '../../core/src/model-factory.js';
import type { Ec2SpotTrainerPort } from './aws-ec2-spot-trainer.js';

export interface TtlGuardRegionSummary {
  region: string;
  checked: number;
  terminated: { instanceId: string; jobId: string | null; expiresAt: string | null }[];
  settlements: GuardSettlementResult[];
  /** Short error texts. A failure in one region or one settlement never stops the others. */
  errors: string[];
}

export interface TtlGuardRunOptions {
  regions: string[];
  ec2: Pick<Ec2SpotTrainerPort, 'sweepExpiredSpotInstances'>;
  /** Ledger to settle in. When absent, the guard only terminates instances (the pre-DSQL behavior). */
  store?: ModelFactoryStore;
  now?: () => number;
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * One TTL Guard run: in every region, terminate managed EC2 instances that are past their expiry tag, then
 * settle each terminated instance's job in the ledger.
 *
 * Termination comes first and never depends on the ledger. When the ledger is unreachable the instances
 * are still terminated, and the settlement error is reported in the summary.
 */
export async function runModelFactoryTtlGuard(options: TtlGuardRunOptions): Promise<TtlGuardRegionSummary[]> {
  const now = options.now ?? Date.now;
  const summaries: TtlGuardRegionSummary[] = [];
  for (const region of options.regions) {
    const summary: TtlGuardRegionSummary = { region, checked: 0, terminated: [], settlements: [], errors: [] };
    summaries.push(summary);
    try {
      const sweep = await options.ec2.sweepExpiredSpotInstances(region, now());
      summary.checked = sweep.checkedCount;
      summary.terminated = sweep.terminated.map((t) => ({ instanceId: t.instanceId, jobId: t.jobId, expiresAt: t.expiresAt }));
      if (!options.store) continue;
      for (const terminated of sweep.terminated) {
        if (!terminated.jobId) continue;
        try {
          summary.settlements.push(
            await settleGuardTermination(options.store, {
              jobId: terminated.jobId,
              instanceId: terminated.instanceId,
              endedMs: now(),
              reason: terminated.reason,
            }),
          );
        } catch (error) {
          summary.errors.push(`settle ${terminated.jobId}: ${shortError(error)}`);
        }
      }
    } catch (error) {
      summary.errors.push(`sweep: ${shortError(error)}`);
    }
  }
  return summaries;
}
