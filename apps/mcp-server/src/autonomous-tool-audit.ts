import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

const errorText='HIVEMIND 요청을 처리하지 못했습니다. 연결·권한·입력과 현재 작업 상태를 확인하세요.';
const notice='워커가 보고한 도구 호출 기록입니다. 독립 증명이 아니며 누락·조작 가능성을 배제하지 않습니다. droppedByWorker·droppedByStore는 버려진 건수입니다.';
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const int=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const item=z.object({sequence:int,tool:z.string().max(128),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),inputSummary:z.string().max(2048),inputTruncated:z.boolean(),outcome:z.enum(['allowed','denied','error']),startedAt:int,durationMs:int.nullable(),subagent:z.literal(true).optional(),runId:z.string().max(256),iteration:int,receivedAt:int});
const totals=z.object({recorded:int,denied:int,errors:int,droppedByWorker:int,droppedByStore:int});
const page=z.object({source:z.literal('worker_report'),items:z.array(item).max(100),totals,nextCursor:z.string().max(2048).optional()});
export interface ToolAuditMcpOptions {apiUrl:string;operatorToken:string;fetchImpl?:typeof fetch;redact:(text:string)=>string}
/** Registers hivemind_autonomous_tool_calls. Called by the MCP server wiring. */
export function registerToolAuditTool(server:McpServer,options:ToolAuditMcpOptions):void{
 const fetcher=options.fetchImpl??fetch;
 const clean=(v:string)=>options.redact(v).replace(/(?:sk-ant-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g,'[REDACTED]');
 server.registerTool('hivemind_autonomous_tool_calls',{title:'장기 작업 워커 도구 호출 기록',description:'워커가 보고한 내부 도구 호출 기록을 페이지 단위로 조회합니다. 독립 증명이 아니며 입력은 가려진 요약입니다. 페이지 길이는 전체 건수가 아니고 totals가 누적값입니다.',inputSchema:z.strictObject({taskId:id,limit:z.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(2048).regex(/^[A-Za-z0-9_.-]+$/).optional()}),annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},async({taskId,limit,cursor},extra):Promise<CallToolResult>=>{
  try{
   const url=new URL('/api/cloudflare/autonomous-tasks/'+encodeURIComponent(taskId)+'/tool-calls?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):''),options.apiUrl);
   const response=await fetcher(url,{method:'GET',redirect:'error',headers:{authorization:'Bearer '+options.operatorToken},signal:AbortSignal.any([extra.signal,AbortSignal.timeout(10000)])});
   if(!response.ok||response.redirected){void response.body?.cancel().catch(()=>{});throw Error(errorText);}
   const text=await response.text();if(text.length>2_000_000)throw Error(errorText);
   const parsed=page.parse(JSON.parse(text));
   const data={source:parsed.source,notice,items:parsed.items.map(i=>({...i,inputSummary:clean(i.inputSummary),tool:clean(i.tool),source:'worker_report' as const})),totals:parsed.totals,...(parsed.nextCursor?{nextCursor:parsed.nextCursor}:{})};
   return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }catch{return {isError:true,content:[{type:'text',text:errorText}]};}
 });
}
