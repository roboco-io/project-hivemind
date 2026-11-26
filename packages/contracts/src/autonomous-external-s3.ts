/** Brokered S3 put/inspect contracts. Targets and credentials are server-owned, never model input. */
export type ExternalS3Operation = 'aws.s3.put'|'aws.s3.inspect';
export interface ExternalS3Target {
  accountId:string; region:string; bucket:string;
  /** Always ends with `/`. */
  prefix:string; kmsKeyId?:string; maxObjectBytes:number; retentionDays:number;
}
/** Parameters of aws.s3.put. */
export interface ExternalS3Parameters {keySuffix:string; artifactDigest:string}
/** Parameters of aws.s3.inspect: only an owned put action of the same approval; key and digest come from that put. */
export interface ExternalS3InspectParameters {putActionId:string}
export interface ExternalS3Profile {
  id:string; enabled?:boolean; credentialRef:string; maxLifetimeMs:number;
  /** Trusted maximum exposure, not an estimate or verified charge. */
  upperBoundMicros:number; maxActiveActions:number;
  provider:'s3'; target:ExternalS3Target; operations:ExternalS3Operation[];
}
