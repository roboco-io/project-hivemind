import {pathToFileURL} from 'node:url';
import {createSnapshot,sha256} from '../src/snapshot.ts';
import {TARGET} from './autonomous-readiness.ts';
export function createPilotPlan(input:{provider:string;model:string;requestId:string;now:number}){
 if(input.provider!=='claude'||typeof input.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.model)||typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>256||/[\p{Cc}]/u.test(input.requestId)||!Number.isSafeInteger(input.now)||input.now<0||!Number.isSafeInteger(input.now+600000))throw new Error('Explicit claude provider, model pin and request ID required');
 const snapshot=createSnapshot([{path:'counter.txt',content:Buffer.from('0\n').toString('base64'),sha256:sha256('0\n'),executable:false}]);
 const argv=['node','-e',"const fs=require('node:fs');const s=fs.readFileSync('counter.txt','utf8');if(!/^[12]\\n$/.test(s))process.exit(1)"];
 const draft={requestId:input.requestId,goal:'Use Bash with Node to modify only counter.txt. First iteration: write exactly two bytes 0x31 0x0a (digit 1 followed by LF), then end with only {"outcome":"continue"}. Second iteration: write exactly two bytes 0x32 0x0a (digit 2 followed by LF), then end with only {"outcome":"complete"}. Preserve the same session. Do not modify checks, the approved model pin, request ID or task goal.',provider:'claude' as const,model:input.model,billingPolicy:{model:'subscription' as const,budget:'external_actions' as const},endsAt:input.now+600000,budgetMicros:1,tools:['Bash'],systems:[],credentialIds:['claude-remote'],maxRunMs:120000,maxIterations:2,execution:{backend:'cloudflare' as const,snapshotId:snapshot.digest,checks:[{id:'counter',argv,timeoutMs:10000}]}};
 return {version:1,target:TARGET,remoteMutation:false,costDisclosure:{budgetScope:'external_actions_only',externalActionBudgetMicros:1,modelPlatformMonetaryCap:false,modelCost:'unknown',platformCost:'unknown',note:'The 1 micro external-action budget is not a model or platform monetary cap. No external systems are allowed; execution is bounded by time and iterations.'},mode:'plan',instance:'standard-1',maxConcurrentNativeRuns:1,snapshot,draft,frozenChecksHash:sha256(JSON.stringify(draft.execution.checks)),secretChangeProposal:{mode:'delta-only',keys:['AUTONOMOUS_WORKER_TOKEN','AUTONOMOUS_REPORTER_TOKEN','AUTONOMOUS_SESSION_KEY'],preserveAllOmitted:true},approvalRequired:true};
}
export function pilotMain(args=process.argv.slice(2)){
 const allowed=new Set(['--plan','--provider','--model','--request-id']);
 if(args.some(v=>v.startsWith('--')&&!allowed.has(v))||args[0]!=='--plan')throw new Error('Only local --plan is supported; execution requires separate operator approval');
 const take=(key:string)=>{const i=args.indexOf(key);if(i<0||args.lastIndexOf(key)!==i||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('Missing explicit plan argument');return args[i+1]!;};
 if(args.length!==7)throw new Error('Invalid plan arguments');
 return createPilotPlan({provider:take('--provider'),model:take('--model'),requestId:take('--request-id'),now:Date.now()});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{console.log(JSON.stringify(pilotMain(),null,2));}catch{console.error('Pilot plan failed: use --plan --provider claude --model PIN --request-id ID');process.exitCode=1;}
