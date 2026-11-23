/** Server-owned broker, scoped provider transport and action audit contracts. */
import type {ExternalS3Operation,ExternalS3Parameters,ExternalS3InspectParameters,ExternalS3Target} from './autonomous-external-s3.js';
export type ExternalHfVisibility = 'private'|'public';
export type ExternalOperation = 'aws.spot.start'|'aws.spot.inspect'|'hf.model.commit'|'hf.model.lfs_commit'|'github.branch.push'|ExternalS3Operation;
export type ExternalTarget =
  | {accountId:string; region:string; workloadId:string}
  | {repository:string; revision:string; visibility?:ExternalHfVisibility; allowPublicLarge?:true}
  | {repository:string; branch:string}
  | ExternalS3Target;
interface ProfileLimits {
  id:string; enabled?:boolean; credentialRef:string; maxLifetimeMs:number;
  /** Trusted maximum exposure, not an estimate or verified charge. */
  upperBoundMicros:number; maxActiveActions:number;
}
export type ExternalProfile = ProfileLimits & (
  | {provider:'aws'; target:{accountId:string; region:string; workloadId:string}; operations:('aws.spot.start'|'aws.spot.inspect')[]}
  | {provider:'hf'; target:{repository:string; revision:string; visibility?:ExternalHfVisibility; allowPublicLarge?:true}; operations:('hf.model.commit'|'hf.model.lfs_commit')[]}
  | {provider:'github'; target:{repository:string; branch:string}; operations:'github.branch.push'[]}
  | {provider:'s3'; target:ExternalS3Target; operations:ExternalS3Operation[]}
);
/** Registry is server-owned. Missing entries and enabled !== true deny admission. */
export interface ExternalProfileRegistry {get(profileId:string):ExternalProfile|undefined}
/** Explicit safe default; targets and credentials must be configured by the server. */
export const DEFAULT_EXTERNAL_PROFILE_ENTRY: Readonly<{enabled:false}> = Object.freeze({enabled:false});
export interface ExternalApprovalRequest {taskId:string; revision:number; profileId:string; endsAt:number; budgetMicros:number}
export interface ExternalApproval extends ExternalApprovalRequest {
  id:string; profile:ExternalProfile; profileHash:string; approvedAt:number;
  stoppedAt?:number; stopReason?:'cancelled'|'expired'|'cost_exceeded';
}
export type ExternalParameters =
  | {lifetimeMs:number}
  | {startActionId:string}
  | {artifactDigest:string; message:string}
  | {manifestDigest:string; message:string}
  | {artifactDigest:string; expectedHead:string}
  | ExternalS3Parameters
  | ExternalS3InspectParameters;
export type ExternalActionRequest = Pick<ExternalApprovalRequest,'taskId'|'revision'|'profileId'> & {requestId:string} & (
  | {operation:'aws.spot.start'; parameters:{lifetimeMs:number}}
  | {operation:'aws.spot.inspect'; parameters:{startActionId:string}}
  | {operation:'hf.model.commit'; parameters:{artifactDigest:string; message:string}}
  | {operation:'hf.model.lfs_commit'; parameters:{manifestDigest:string; message:string}}
  | {operation:'github.branch.push'; parameters:{artifactDigest:string; expectedHead:string}}
  | {operation:'aws.s3.put'; parameters:ExternalS3Parameters}
  | {operation:'aws.s3.inspect'; parameters:ExternalS3InspectParameters}
);
export interface ExternalResource {id:string; cleanupRequired:true}
export interface ExternalProviderReceipt {
  /** Adapter verifies these against provider idempotency/ownership evidence. */
  ownershipToken:string; idempotencyKey:string; evidenceId:string;
  outcome:'succeeded'|'failed'|'unknown'; effect:'none'|'retained'|'resource'|'unknown';
  resource?:ExternalResource;
  /** Cumulative verified cost for this action; null must never mean zero. */
  billing:{verifiedCostMicros:number|null; final:boolean};
}
/** Private read-only progress; never a receipt or proof of absence. */
export interface ExternalPendingObservation {state:'pending';cursor:string|null}
export type ExternalInspection = ExternalProviderReceipt|null|ExternalPendingObservation;
export interface ExternalOperatorBilling {actualCostMicros:number;evidenceRef:string;reason:string;at:number}
export interface ExternalAction {
  id:string; approvalId:string; requestId:string; operation:ExternalOperation;
  parameters:ExternalParameters; parametersHash:string; profileHash:string;
  ownershipToken:string; idempotencyKey:string; createdAt:number; expiresAt:number;
  status:'intent'|'dispatching'|'ambiguous'|'succeeded'|'failed'|'cancelled';
  effect:'none'|'retained'|'resource'|'unknown'; resource?:ExternalResource;
  cleanupStatus:'none'|'pending'|'deleting'|'cleaned';
  upperBoundMicros:number; reservedMicros:number; verifiedCostMicros:number|null; billingFinal:boolean;
  /** Server-private durable discovery progress, never model input. */
  providerRecoveryCursor?:string;
  evidenceId?:string;
  /** Last accepted provider evidence stays separate from an operator's invoice review. */
  providerReceipt?:ExternalProviderReceipt;
  billingSource?:'provider_verified'|'operator_attested';
  operatorBilling?:ExternalOperatorBilling;
}
export interface ExternalState {version:1; approvals:Record<string,ExternalApproval>; actions:Record<string,ExternalAction>}
export interface ExternalTransactionalStore {
  /** Synchronous, atomic durable commit/rollback. Never retain callback state references.
   * Must serialize writers and reject asynchronous callbacks. No network inside callbacks. */
  transaction<T>(callback:(state:ExternalState)=>T):T;
}
export interface ExternalInvocation {
  actionId:string; taskId:string; revision:number; profile:ExternalProfile;
  operation:ExternalOperation; parameters:ExternalParameters; parametersHash:string;
  ownershipToken:string; idempotencyKey:string; expiresAt:number;
  /** Server-private cursor copied only from the durable action. */
  providerRecoveryCursor?:string;
  /** aws.spot.inspect resolves an owned start action, never an arbitrary resource. */
  ownedResource?:ExternalResource & {actionId:string; ownershipToken:string; idempotencyKey:string};
  /** aws.s3.inspect resolves the owned put action, so it can only check that put's object and mark. */
  ownedPut?:{actionId:string; ownershipToken:string; idempotencyKey:string; parametersHash:string; parameters:ExternalS3Parameters};
}
export interface ExternalCredentialScope {
  taskId:string; revision:number; actionId:string; provider:ExternalProfile['provider'];
  target:ExternalTarget; operation:ExternalOperation; purpose:'execute'|'inspect'|'cleanup'; expiresAt:number;
}
export interface ExternalCredentialResolver<Credential=unknown> {
  /** Credential is opaque to broker; only the trusted transport callback consumes it.
   * Cleanup/inspect must remain possible after execution authority expires. */
  withCredential<T>(reference:string,scope:Readonly<ExternalCredentialScope>,consume:(credential:Credential)=>Promise<T>):Promise<T>;
}
export interface ExternalProviderTransport<Credential=unknown> {
  /** Must enforce fixed provider endpoints, target, TTL, artifact digest, non-force
   * expected-head writes and ownership. No env/CLI credentials or arbitrary URLs.
   * Failure/timeout is NOT proof that no effect occurred. */
  execute(invocation:ExternalInvocation,credential:Credential):Promise<ExternalProviderReceipt>;
  /** Read-only discovery by idempotency/ownership. null means unresolved, never absent. */
  inspect(invocation:ExternalInvocation,credential:Credential):Promise<ExternalInspection>;
  /** Idempotent deletion of exactly this owned resource. */
  cleanup(invocation:ExternalInvocation,resource:ExternalResource,credential:Credential):Promise<void>;
  /** true requires actual provider absence, not merely an accepted deletion request. */
  confirmAbsent(invocation:ExternalInvocation,resource:ExternalResource,credential:Credential):Promise<boolean>;
}
export interface ExternalBrokerOptions<Credential=unknown> {
  store:ExternalTransactionalStore; registry:ExternalProfileRegistry;
  resolver:ExternalCredentialResolver<Credential>; transport:ExternalProviderTransport<Credential>;
  now?:()=>number;
}
