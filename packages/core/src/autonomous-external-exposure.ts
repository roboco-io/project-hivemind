import type {ExternalAction,ExternalState} from '../../contracts/src/autonomous-external.js';

export type ExternalCostStop='verified_reached_cap'|'exposure_over_cap'|'broker_cost_exceeded';
export interface ExternalTaskExposure {
  taskId:string; revision:number; capMicros:number; verifiedMicros:number; reservedMicros:number;
  exposureMicros:number; brokerCostStop:boolean; stop:null|ExternalCostStop; nextExpiryAt?:number;
}

/** Pure, read-only projection of the broker state; mirrors the broker's exposure and ceiling rules. */
function project(s:ExternalState,taskId:string):ExternalTaskExposure|null {
  const approvals=Object.values(s.approvals).filter(p=>p.taskId===taskId);
  if(!approvals.length)return null;
  let revision=0,capMicros=Infinity;
  for(const p of approvals)if(p.revision>revision){revision=p.revision;capMicros=p.budgetMicros;}
  const brokerCostStop=approvals.some(p=>p.revision===revision&&p.stopReason==='cost_exceeded');
  const actions=Object.values(s.actions).filter((a:ExternalAction)=>s.approvals[a.approvalId]?.taskId===taskId);
  let verifiedMicros=0,reservedMicros=0,nextExpiryAt:number|undefined;
  for(const a of actions){
    verifiedMicros+=a.verifiedCostMicros??0;reservedMicros+=a.reservedMicros;
    if(a.resource&&a.cleanupStatus!=='cleaned'&&(nextExpiryAt===undefined||a.expiresAt<nextExpiryAt))nextExpiryAt=a.expiresAt;
  }
  const exposureMicros=verifiedMicros+reservedMicros;
  const stop:ExternalTaskExposure['stop']=brokerCostStop?'broker_cost_exceeded':verifiedMicros>=capMicros?'verified_reached_cap':exposureMicros>capMicros?'exposure_over_cap':null;
  return {taskId,revision,capMicros,verifiedMicros,reservedMicros,exposureMicros,brokerCostStop,stop,...(nextExpiryAt===undefined?{}:{nextExpiryAt})};
}
export function externalTaskExposure(state:ExternalState,taskId:string):ExternalTaskExposure|null {return project(state,taskId);}
export function listExternalTaskExposures(state:ExternalState):ExternalTaskExposure[] {
  const ids=[...new Set(Object.values(state.approvals).map(p=>p.taskId))].sort();
  return ids.map(id=>project(state,id)!);
}
export function listExternalCostStops(state:ExternalState):ExternalTaskExposure[] {return listExternalTaskExposures(state).filter(e=>e.stop!==null);}
