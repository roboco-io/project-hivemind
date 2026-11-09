import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HiveStore, DomainError, equalSecret, text } from '../../../packages/core/src/store.js';
import type { CreateTask, RunResult, RepositoryPolicy, Provider, Runtime } from '../../../packages/contracts/src/index.js';

export interface AppOptions { dbPath?: string; operatorToken?: string; workerToken?: string; now?: () => number; repository?: RepositoryPolicy }
const string = {type:'string',minLength:1,maxLength:4000};
const credentials = {workerId:{...string,maxLength:120},leaseToken:{...string,maxLength:120}};
const body = (properties: Record<string,unknown>, required = Object.keys(properties)) => ({body:{type:'object',additionalProperties:false,required,properties}});
const command = {type:'array',minItems:1,maxItems:32,items:{type:'string',minLength:1,maxLength:1000}};
const code = {type:['integer','null'],minimum:-2147483648,maximum:2147483647};
const status = {type:'string',enum:['passed','failed','timed_out','error','not_run']};
const log = {type:'string',maxLength:16000};
const processProperties = {command,status,exitCode:code,durationMs:{type:'integer',minimum:0,maximum:86400000},stdout:log,stderr:log,truncated:{type:'boolean'}};
const processEvidence = {type:'object',additionalProperties:false,required:Object.keys(processProperties),properties:processProperties};
const usageProperties = {inputTokens:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},cachedInputTokens:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},outputTokens:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}};
const agentProperties = {status,exitCode:code,threadId:{type:['string','null'],minLength:1,maxLength:200},model:{type:['string','null'],minLength:1,maxLength:200},usage:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:Object.keys(usageProperties),properties:usageProperties}]},stderr:log};
const executionProperties = {
  repositoryId:{...string,maxLength:120},baseCommit:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},headCommit:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},
  worktreePath:{...string,maxLength:4096},diffTruncated:{type:'boolean'},status:{type:'string',enum:['succeeded','failed']},setup:processEvidence,tests:processEvidence,
  codex:{type:'object',additionalProperties:false,required:Object.keys(agentProperties),properties:agentProperties},
  claude:{type:'object',additionalProperties:false,required:Object.keys(agentProperties),properties:agentProperties},
};
const executionEvidence = {anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:Object.keys(executionProperties).filter(key=>!['setup','codex','claude'].includes(key)),properties:executionProperties}]};

export function buildApp(options: AppOptions = {}) {
  const operatorToken = options.operatorToken ?? 'local-development-only';
  const workerToken = options.workerToken ?? 'local-worker-only';
  if (!operatorToken.trim() || !workerToken.trim() || equalSecret(operatorToken,workerToken)) throw new Error('Operator and worker tokens must be nonempty and distinct');
  const app = Fastify({bodyLimit:2000000,logger:false,ajv:{customOptions:{coerceTypes:false,removeAdditional:false}}});
  const store = new HiveStore(options.dbPath ?? ':memory:',options.now,options.repository);
  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest',async (_request,reply) => {
    reply.header('cache-control','no-store');
    reply.header('x-content-type-options','nosniff');
    reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((error,request,reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({error:error.message});
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({error:error.message});
    request.log.error(error); return reply.code(500).send({error:'Internal server error'});
  });
  const guard = (token: string) => async (request: FastifyRequest,reply: FastifyReply) => {
    if (!equalSecret(request.headers.authorization ?? '',`Bearer ${token}`)) return reply.code(401).send({error:'Unauthorized'});
  };
  const operator = guard(operatorToken), worker = guard(workerToken);
  app.get('/health',async () => ({status:'ok',mode:options.repository ? 'local-workers' : 'mock-local'}));
  app.get('/favicon.ico',async (_request,reply) => reply.code(204).send());
  const staticRoot = new URL('../../../../apps/dashboard/public/',import.meta.url);
  for (const [route,file,mime] of [['/','index.html','text/html'],['/app.js','app.js','application/javascript'],['/styles.css','styles.css','text/css'],['/brand/hivemind-logo.png','brand/hivemind-logo.png','image/png'],['/brand/hivemind-bee.png','brand/hivemind-bee.png','image/png']] as const) {
    app.get(route,async (_request,reply) => reply.type(mime.startsWith('image/') ? mime : mime+'; charset=utf-8').send(await readFile(fileURLToPath(new URL(file,staticRoot)))));
  }
  app.get('/api/capabilities',{preHandler:operator},async () => ({providers:options.repository ? ['mock','codex','claude'] : ['mock'],repository:options.repository ?? null}));
  app.get('/api/state',{preHandler:operator},async () => store.state());
  app.post<{Body:CreateTask}>('/api/tasks',{
    preHandler:operator,
    schema:body({title:{...string,maxLength:160},instructions:{...string,maxLength:12000},budgetMicros:{type:'integer',minimum:0,maximum:1000000000},provider:{type:'string',enum:['mock','codex','claude']},runtime:{type:'string',enum:['local','ecs','cloudflare']},repositoryId:{...string,maxLength:120},baseCommit:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},testProfile:{...string,maxLength:120}},['title','instructions','budgetMicros','provider','runtime']),
  },async (request,reply) => reply.code(201).send(store.create(request.body)));
  app.post<{Params:{id:string};Body:{decision:string;reason:string}}>('/api/tasks/:id/decision',{
    preHandler:operator,schema:body({decision:{type:'string',enum:['approve','reject']},reason:string}),
  },async request => store.decision(request.params.id,request.body.decision,request.body.reason));
  app.post<{Params:{id:string};Body:{reason:string}}>('/api/tasks/:id/cancel',{
    preHandler:operator,schema:body({reason:string}),
  },async request => store.cancel(request.params.id,request.body.reason));
  app.post<{Body:{workerId:string;provider:Provider;runtime:Runtime;repositoryId?:string}}>('/api/workers/register',{
    preHandler:worker,schema:body({workerId:{...string,maxLength:120},provider:{type:'string',enum:['mock','codex','claude']},runtime:{const:'local',type:'string'},repositoryId:{...string,maxLength:120}},['workerId','provider','runtime']),
  },async request => store.register(request.body.workerId,request.body.provider,request.body.runtime,request.body.repositoryId));
  app.post<{Body:{workerId:string}}>('/api/workers/claim',{
    preHandler:worker,schema:body({workerId:{...string,maxLength:120}}),
  },async (request,reply) => {
    // Fastify treats a null return as no response; send JSON null explicitly.
    const lease = store.claim(text(request.body.workerId,'workerId',120));
    return reply.type('application/json').send(lease === null ? 'null' : lease);
  });
  type Creds = {workerId:string;leaseToken:string};
  app.post<{Params:{id:string};Body:Creds}>('/api/tasks/:id/heartbeat',{
    preHandler:worker,schema:body(credentials),
  },async request => store.heartbeat(request.params.id,request.body.workerId,request.body.leaseToken));
  app.post<{Params:{id:string};Body:Creds & RunResult}>('/api/tasks/:id/result',{
    preHandler:worker,schema:body({...credentials,summary:{...string,maxLength:12000},diff:{type:'string',maxLength:200000},actualCostMicros:{type:['integer','null'],minimum:0,maximum:1000000000},execution:executionEvidence},[...Object.keys(credentials),'summary','diff','actualCostMicros']),
  },async request => store.result(request.params.id,request.body.workerId,request.body.leaseToken,request.body));
  app.post<{Params:{id:string};Body:Creds & {message:string}}>('/api/tasks/:id/fail',{
    preHandler:worker,schema:body({...credentials,message:{...string,maxLength:12000}}),
  },async request => store.fail(request.params.id,request.body.workerId,request.body.leaseToken,request.body.message));
  return app;
}
