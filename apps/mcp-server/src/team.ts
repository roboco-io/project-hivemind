import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {workflowId,teamPageQuery,teamBlockInput,teamReviewInput,projectTeamResponse,type TeamSection} from '../../../packages/contracts/src/workflow.js';
interface TeamMcpOptions {apiUrl:string;operatorToken:string;fetchImpl?:typeof fetch}
const errorText='HIVEMIND 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
/** Operator-only HTTP tools. No worker capability, execution or provider access. */
export function registerTeamOperatorTools(server:McpServer,options:TeamMcpOptions):void{
 const readOnly={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
 const mutation={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false};
 async function request(id:string,section:TeamSection|'block'|'review',signal:AbortSignal,query:Record<string,number|undefined>={},body?:unknown):Promise<CallToolResult>{
  try{
   const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
   const url=new URL('/api/cloudflare/workflows/'+id+'/team'+(section==='summary'?'':'/'+section)+(params.size?'?'+params:''),options.apiUrl);
   const response=await (options.fetchImpl??fetch)(url,{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+options.operatorToken,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
   if(!response.ok||response.redirected||Number(response.headers.get('content-length'))>1048576){await response.body?.cancel();throw Error(errorText);}
   const reader=response.body?.getReader();if(!reader)throw Error(errorText);const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>1048576){await reader.cancel();throw Error(errorText);}chunks.push(chunk.value);}}finally{reader.releaseLock();}
   const data=projectTeamResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')),section,[options.operatorToken]);
   if(['summary','block','review'].includes(section)&&data.workflowId!==id)throw Error(errorText);
   return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }catch{return {isError:true,content:[{type:'text',text:errorText}]};}
 }
 server.registerTool('hivemind_workflow_team_get',{title:'워크플로 팀 원장 조회',description:'운영자 권한으로 등록된 워크플로의 팀 요약·작업·이벤트·메모를 조회합니다. 워커 capability를 사용하거나 실행을 시작하지 않습니다.',inputSchema:z.strictObject({workflowId,section:z.enum(['summary','tasks','events','notes']).default('summary'),...teamPageQuery.shape}).refine(v=>!['summary','tasks'].includes(v.section)||(v.after===undefined&&v.limit===undefined),'Pagination is only supported for events and notes'),annotations:readOnly},async({workflowId:id,section,after,limit},extra)=>request(id,section,extra.signal,{after,limit}));
 server.registerTool('hivemind_workflow_team_block',{title:'워크플로 팀 안전 중단',description:'사용자가 명시적으로 요청한 경우에만 운영자 권한으로 팀 안전 중단을 기록합니다. 새 실행을 차단하고 기존 작업의 중단을 요청합니다. 실제 중단 확인은 별도로 조회해야 합니다.',inputSchema:z.strictObject({workflowId,...teamBlockInput.shape}),annotations:mutation},async({workflowId:id,...input},extra)=>request(id,'block',extra.signal,{},input));
 server.registerTool('hivemind_workflow_team_review',{title:'워크플로 팀 검토 기록',description:'사용자가 명시적으로 요청한 경우에만 운영자 검토 사유를 기록합니다. 기존 팀·작업을 재활성화하거나 실제 실행·배포·병합하지 않습니다.',inputSchema:z.strictObject({workflowId,...teamReviewInput.shape}),annotations:mutation},async({workflowId:id,...input},extra)=>request(id,'review',extra.signal,{},input));
}
