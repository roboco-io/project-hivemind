// Shared Web handler has type-only imports and remains safe in Workers and Node.
export { handleAutonomousApi } from '../../../../apps/control-plane/src/autonomous-api.ts';
export type { AutonomousApiService, AutonomousOperation } from '../../../../apps/control-plane/src/autonomous-api.ts';
