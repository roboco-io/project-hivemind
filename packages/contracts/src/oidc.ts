import type {AutonomousTask} from './autonomous.js';
import type {ExternalApproval,ExternalAction,ExternalProfile} from './autonomous-external.js';
export type OidcPurpose='execute'|'inspect'|'cleanup';
export interface OidcConfig {issuer:string;audience:string;ttlSeconds?:number;roles:Record<string,{executeRoleArn:string;cleanupRoleArn:string}>}
/** Only canonical server snapshots; never construct from a worker request body. */
export interface OidcFacts {task:AutonomousTask;approval:ExternalApproval;action:ExternalAction;profile:ExternalProfile}
export interface OidcGrant {issuer:string;audience:string;subject:string;roleArn:string;taskId:string;revision:number;profileId:string;profileHash:string;actionId:string;purpose:OidcPurpose;issuedAt:number;expiresAt:number}
/** Private service binding only; neither grant nor JWT is a public worker DTO. */
export interface OidcSignerPort {sign(grant:Readonly<OidcGrant>):Promise<{token:string;kid:string}>}
export interface OidcPublicJwk {kty:'RSA';n:string;e:string;kid:string;alg:'RS256';use:'sig'}
