import type { AcceptanceTestSpec, BundleManifest, DeliveryTask, DeliveryTaskStatus } from '../../../packages/contracts/src/delivery.js';
import type { AutonomyTrigger, AutonomyTriggerStore } from '../../../packages/core/src/autonomy-trigger.js';
import type { DeliveryStore } from '../../../packages/core/src/delivery.js';

/** A pinned snapshot of the repository for one task: the bundle (in S3) and the acceptance files. */
export interface PreparedSnapshot {
  baseCommit: string;
  bundle: BundleManifest;
  acceptance: AcceptanceTestSpec;
}

export interface AutonomyDispatcherOptions {
  triggers: AutonomyTriggerStore;
  delivery: DeliveryStore;
  /** Clones the base branch, uploads a pinned bundle and pins the protected files as acceptance files. */
  prepare: (trigger: AutonomyTrigger, signal: AbortSignal) => Promise<PreparedSnapshot>;
  /** Starts the worker for an approved task (DeliveryOrchestrator.dispatchWorker). */
  dispatchWorker: (taskId: string, signal: AbortSignal) => Promise<unknown>;
  /** Puts the task's acceptance spec where the verifier reads it (DeliveryOrchestrator.uploadAcceptanceSpec). */
  uploadAcceptance: (task: DeliveryTask, signal: AbortSignal) => Promise<unknown>;
  /**
   * Fails running tasks whose worker no longer exists (DeliveryOrchestrator.reconcileRunningTasks). Called
   * when a due trigger finds its task still running, so a lost worker does not block the trigger forever.
   */
  reconcile?: (signal: AbortSignal) => Promise<unknown>;
  /** Region the trigger's tasks run in; the agent token exists only on hub workers. */
  primaryRegion: string;
  now?: () => number;
  log?: (record: Record<string, unknown>) => void;
}

/** Task states that mean "the previous stage is not finished yet". */
const OPEN: ReadonlySet<DeliveryTaskStatus> = new Set(['awaiting_approval', 'queued', 'running', 'verified', 'draft_pr_published']);

/** Sends the next "advance one stage" task for each due trigger, never two at once (issue #20). */
export class AutonomyDispatcher {
  private ticking = false;
  constructor(private readonly options: AutonomyDispatcherOptions) {}

  private log(record: Record<string, unknown>): void {
    (this.options.log ?? ((r) => console.log(JSON.stringify(r))))({ event: 'hivemind.autonomy_trigger', ...record });
  }

  /** The trigger's task that is still open, if any. */
  async openTask(trigger: AutonomyTrigger): Promise<DeliveryTask | null> {
    const tasks = await this.options.delivery.list();
    return tasks.find((t) => t.delivery.repository === trigger.repository && t.delivery.branchPrefix === trigger.branchPrefix && OPEN.has(t.status)) ?? null;
  }

  async tick(signal: AbortSignal = AbortSignal.timeout(300_000)): Promise<{ dispatched: string[]; skipped: string[] }> {
    const result = { dispatched: [] as string[], skipped: [] as string[] };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      let reconciled = false;
      for (const trigger of await this.options.triggers.due((this.options.now ?? Date.now)())) {
        let open = await this.openTask(trigger);
        if (open?.status === 'running' && this.options.reconcile && !reconciled) {
          reconciled = true;
          try {
            await this.options.reconcile(signal);
          } catch (error) {
            this.log({ triggerId: trigger.id, reconcileError: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
          }
          open = await this.openTask(trigger);
        }
        if (open) {
          await this.options.triggers.recordSkip(trigger.id, `Task ${open.id} is still ${open.status}`);
          result.skipped.push(trigger.id);
          continue;
        }
        try {
          const taskId = await this.dispatchOne(trigger, signal);
          result.dispatched.push(taskId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.options.triggers.recordSkip(trigger.id, `Dispatch failed: ${reason}`);
          this.log({ triggerId: trigger.id, error: reason.slice(0, 300) });
          result.skipped.push(trigger.id);
        }
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  private async dispatchOne(trigger: AutonomyTrigger, signal: AbortSignal): Promise<string> {
    const snapshot = await this.options.prepare(trigger, signal);
    const draft = await this.options.delivery.create({
      title: trigger.title,
      instructions: trigger.instructions,
      provider: trigger.provider,
      maxIterations: trigger.maxIterations,
      budgetMicros: trigger.budgetMicros,
      acceptance: snapshot.acceptance,
      delivery: { mode: 'draft_pr', repository: trigger.repository, baseBranch: trigger.baseBranch, branchPrefix: trigger.branchPrefix, autoMerge: true, protectedPaths: trigger.protectedPaths },
      bundle: snapshot.bundle,
      spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
      routing: { primaryRegion: this.options.primaryRegion, allowedRegions: [this.options.primaryRegion], workloadClass: 'cpu-arm-worker' },
      executionPolicy: { hivemindAgentAccess: true, maxIterationDurationMs: trigger.maxIterationDurationMs },
    });
    // Same order as the delivery API: the verifier reads acceptance/<task>.json, so it must exist first.
    try {
      await this.options.uploadAcceptance(draft, signal);
    } catch (error) {
      await this.options.delivery.cancel(draft.id, `Acceptance spec upload failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`).catch(() => undefined);
      throw error;
    }
    // The operator approved this trigger's configuration once; each task it sends is approved by the trigger.
    await this.options.delivery.approve(draft.id, draft.approvalFingerprint, `Autonomy trigger ${trigger.id} (configured by the operator)`);
    await this.options.triggers.recordDispatch(trigger.id, draft.id, snapshot.baseCommit);
    try {
      await this.options.dispatchWorker(draft.id, signal);
    } catch (error) {
      // A task that never got a worker would block the trigger forever as an open task.
      await this.options.delivery.cancel(draft.id, `Worker dispatch failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`).catch(() => undefined);
      throw error;
    }
    this.log({ triggerId: trigger.id, taskId: draft.id, baseCommit: snapshot.baseCommit });
    return draft.id;
  }

  /** Stops every trigger that sends tasks to the repository of a refused auto-merge. */
  async stopForRefusedMerge(task: DeliveryTask, reason: string): Promise<string[]> {
    const stopped: string[] = [];
    for (const trigger of await this.options.triggers.list()) {
      if (trigger.enabled && trigger.repository === task.delivery.repository && trigger.branchPrefix === task.delivery.branchPrefix) {
        await this.options.triggers.setEnabled(trigger.id, false, `Auto-merge of ${task.id} was refused: ${reason}`.slice(0, 1000));
        stopped.push(trigger.id);
      }
    }
    return stopped;
  }
}
