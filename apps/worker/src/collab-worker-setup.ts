/**
 * Runs the set-up of a collaboration worker (model auth load and materialization). When the set-up throws,
 * it reports the subtask as failed before rethrowing. Without that report the subtask would stay 'running'
 * after the ECS task exits and would hold a parallel-worker slot until an operator intervenes.
 */
export async function setUpCollabWorkerOrFailSubtask<T>(
  setUp: () => Promise<T>,
  reportSubtaskFailed: (failureReason: string) => Promise<void>,
): Promise<T> {
  try {
    return await setUp();
  } catch (setupError) {
    const reason = `Worker set-up failed before the model run: ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`.slice(0, 1000);
    // The original set-up error is the one to surface, even when the report itself fails.
    await reportSubtaskFailed(reason).catch(() => undefined);
    throw setupError;
  }
}
