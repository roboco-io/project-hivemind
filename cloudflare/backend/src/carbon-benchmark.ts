import type {TerraGatewayTiming,TerraLatencyMode} from './terra-latency.ts';
export const carbonModel = 'gemini-4-carbon';
export const carbonRunBudget = 5_000_000;
export const carbonCampaignBudget = 20_000_000;
export type BenchmarkInstance = 'standard-1'|'standard-3';
export const terraSizingOrder:readonly BenchmarkInstance[]=['standard-1','standard-3','standard-1','standard-3','standard-1','standard-3'];
export type NpmCacheMode='cold'|'warm';
export const terraCachePairOrder:readonly NpmCacheMode[]=['cold','warm','cold','warm','cold','warm'];
export type CarbonEffort = 'low' | 'medium';

export interface CarbonUsage { input: number; cacheRead: number; output: number; thinking: number }

export interface CarbonRun {
  id: string;
  effort: CarbonEffort;
  spentMicros: number;
  instance?: BenchmarkInstance;
  cacheMode?: NpmCacheMode;
  modelWaitMs?: number;
  gatewayTiming?: TerraGatewayTiming;
  gatewayTimings?: TerraGatewayTiming[];
  requests: number;
  usage?: CarbonUsage;
  reservedMicros?: number;
  blocked?: boolean;
  failureCode?: string;
}
export interface CarbonCampaign {
  id: string;
  snapshotId: string;
  phase: 'compare' | 'repeat' | 'done';
  runs: CarbonRun[];
  winner?: CarbonEffort;
  requestId?: string;
  probe?: boolean;
  model?: 'terra';
  runtimeRevision?: string;
  instance?: BenchmarkInstance;
  sizing?: boolean;
  latency?: TerraLatencyMode;
  priorSpentMicros?: number;
}
export interface CarbonOutcome {
  terminal: boolean;
  cancelled?: boolean;
  passed: boolean;
  durationMs: number;
}

export function advanceCarbonCampaign(
  campaign: CarbonCampaign,
  read: (id: string) => CarbonOutcome | undefined,
  enqueue: (effort: CarbonEffort, instance?:BenchmarkInstance,cacheMode?:NpmCacheMode) => string,
): void {
  if (campaign.phase === 'done') return;
  const outcomes = campaign.runs.map(run => ({run, outcome: read(run.id)}));
  if (outcomes.some(({outcome}) => !outcome?.terminal)) return;
  if(campaign.latency==='realworld-cache-pairs'&&!campaign.probe){
    const cacheMode=terraCachePairOrder[campaign.runs.length];
    if(!cacheMode||outcomes.some(({run,outcome})=>run.blocked||outcome?.cancelled)){campaign.phase='done';return;}
    const instance='standard-3';
    campaign.runs.push({id:enqueue('medium',instance,cacheMode),effort:'medium',instance,cacheMode,spentMicros:0,requests:0});
    return;
  }
  if(campaign.sizing){
    const instance=terraSizingOrder[campaign.runs.length];
    if(!instance||outcomes.some(({run,outcome})=>run.blocked||outcome?.cancelled)){campaign.phase='done';return;}
    campaign.runs.push({id:enqueue('medium',instance),effort:'medium',instance,spentMicros:0,requests:0});
    return;
  }
  if (campaign.probe || campaign.model==='terra' || campaign.phase === 'repeat') {
    campaign.phase = 'done';
    return;
  }
  const winner = outcomes.filter(({outcome}) => outcome!.passed).sort((a, b) =>
    a.outcome!.durationMs - b.outcome!.durationMs || a.run.effort.localeCompare(b.run.effort))[0];
  if (!winner || campaign.runs.some(run=>run.blocked) || (campaign.priorSpentMicros??0)+campaign.runs.reduce((total, run) => total + run.spentMicros, 0) >= carbonCampaignBudget) {
    campaign.phase = 'done';
    return;
  }
  const effort = winner.run.effort;
  const repeats = [enqueue(effort), enqueue(effort)].map(id => ({id, effort, spentMicros: 0, requests: 0}));
  campaign.runs.push(...repeats);
  campaign.winner = effort;
  campaign.phase = 'repeat';
}

export function reserveCarbonRequest(campaign: CarbonCampaign, runId: string, reserve: number): boolean {
  const run = campaign.runs.find(item => item.id === runId);
  if (!run || run.blocked || campaign.phase === 'done' || run.reservedMicros !== undefined ||
      !Number.isSafeInteger(reserve) || reserve <= 0 || run.spentMicros + reserve > carbonRunBudget) return false;
  const total = campaign.runs.reduce((sum, item) => sum + item.spentMicros + (item.reservedMicros ?? 0), campaign.priorSpentMicros??0);
  if (total + reserve > carbonCampaignBudget) return false;
  run.reservedMicros = reserve;
  return true;
}

export function settleCarbonRequest(campaign: CarbonCampaign, runId: string, actual: number | null, usage?: CarbonUsage, failure?:string): void {
  const run = campaign.runs.find(item => item.id === runId);
  if (!run || run.reservedMicros === undefined) throw new Error('No matching Carbon reservation');
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error('Invalid Carbon usage cost');
  if(actual===null||actual>run.reservedMicros){
    run.blocked=true;
    run.failureCode??=actual!==null?'RESERVATION_EXCEEDED':
      failure&&/^[A-Z0-9_]{1,80}$/.test(failure)?failure:'USAGE_UNKNOWN';
  }
  run.spentMicros += actual ?? run.reservedMicros;
  run.requests++;
  if(usage){
    const total=run.usage??={input:0,cacheRead:0,output:0,thinking:0};
    for(const key of ['input','cacheRead','output','thinking'] as const)total[key]+=usage[key];
  }
  delete run.reservedMicros;
}

function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000)
    throw new Error('Invalid Gemini token count');
  return value;
}

/** Standard price in USD micros per token through 2026-11-30. */
export function readCarbonUsage(value: unknown): CarbonUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing Gemini usage');
  const usage = value as Record<string, unknown>;
  const input = tokens(usage.promptTokenCount);
  const cached = tokens(usage.cachedContentTokenCount ?? 0);
  const thinking = tokens(usage.thoughtsTokenCount ?? 0);
  // Google can omit a zero-valued output count. Only infer zero from a matching total.
  const output = tokens(usage.candidatesTokenCount ??
    (usage.totalTokenCount===input+thinking?0:undefined));
  if (cached > input || tokens(usage.toolUsePromptTokenCount ?? 0) !== 0)
    throw new Error('Unsupported Gemini usage');
  return {input:input-cached,cacheRead:cached,output,thinking};
}
export function carbonUsageMicros(value: unknown): number {
  const {input,cacheRead,output,thinking}=readCarbonUsage(value);
  return Math.ceil(input*2+cacheRead/10+(output+thinking)*10);
}
