import {projectAutonomousCloudResponse,validateAutonomousCloudRequest,type AutonomousCloudProxy} from './autonomous-cloud-proxy.js';
import {handleAutonomousExternalApi,type AutonomousExternalService} from './autonomous-external-api.js';
import {createAutonomousStore} from '../../../packages/core/src/autonomous-store.js';
import {createAutonomousApiService,handleAutonomousApi} from './autonomous-api.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HiveStore, DomainError, equalSecret, text } from '../../../packages/core/src/store.js';
import type { CreateTask, RunResult, RepositoryPolicy, Provider, Runtime } from '../../../packages/contracts/src/index.js';
import type { CloudControl } from '../../../packages/contracts/src/cloudflare.js';

import type {CloudWorkflowControl} from '../../../packages/contracts/src/workflow.js';

export interface AppOptions { autonomousCloudProxy?:AutonomousCloudProxy; localExternalService?:AutonomousExternalService; dbPath?: string; operatorToken?: string; workerToken?: string; nativeReporterToken?: string; now?: () => number; repository?: RepositoryPolicy; cloudflare?: CloudControl; workflows?: CloudWorkflowControl }
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
const taskProperties = {title:{...string,maxLength:160},instructions:{...string,maxLength:12000},budgetMicros:{type:'integer',minimum:0,maximum:1000000000},provider:{type:'string',enum:['mock','codex','claude']},runtime:{type:'string',enum:['local','ecs','cloudflare']},repositoryId:{...string,maxLength:120},baseCommit:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},testProfile:{...string,maxLength:120}};
const taskRequired = ['title','instructions','budgetMicros','provider','runtime'];

export function buildApp(options: AppOptions = {}) {
  const operatorToken = options.operatorToken ?? 'local-development-only';
  const workerToken = options.workerToken ?? 'local-worker-only';
  if (!operatorToken.trim() || !workerToken.trim() || equalSecret(operatorToken,workerToken)) throw new Error('Operator and worker tokens must be nonempty and distinct');
  const app = Fastify({bodyLimit:2000000,logger:false,ajv:{customOptions:{coerceTypes:false,removeAdditional:false}}});
  const store = new HiveStore(options.dbPath ?? ':memory:',options.now,options.repository);
  const autonomousStore=createAutonomousStore(options.dbPath ?? ':memory:');
  const autonomousService=createAutonomousApiService(autonomousStore,options.now);
  app.addHook('onClose',async()=>{autonomousStore.close();});
  app.route({method:['GET','POST','PUT','DELETE','PATCH'],url:'/v1/autonomous-tasks',bodyLimit:65536,onRequest:autonomousGuard,handler:autonomous});
  app.route({method:['GET','POST','PUT','DELETE','PATCH'],url:'/v1/autonomous-tasks/*',bodyLimit:65536,onRequest:autonomousGuard,handler:autonomous});
  async function autonomousGuard(request:FastifyRequest,reply:FastifyReply){
    const path=new URL(request.url,'http://local').pathname;
    const workerAction=/^\/v1\/autonomous-tasks\/[^/]+\/(claim|native-start|heartbeat|finish|reserve|settle|worker-state|external-action)\/?$/.test(path);
    const reporterAction=/^\/v1\/autonomous-tasks\/[^/]+\/(native-ready|native-receipt)\/?$/.test(path);
    const reporterToken=options.nativeReporterToken;
    if(reporterAction&&(!reporterToken||/[\s\p{Cc}]/u.test(reporterToken)||equalSecret(reporterToken,operatorToken)||equalSecret(reporterToken,workerToken)))return reply.code(503).send({error:'Reporter authentication unavailable'});
    if(!equalSecret(request.headers.authorization??'',`Bearer ${reporterAction?reporterToken:workerAction?workerToken:operatorToken}`))return reply.code(401).send({error:'Unauthorized'});
  }
  async function autonomous(request:FastifyRequest,reply:FastifyReply){
    const headers=new Headers();
    for(const [key,value] of Object.entries(request.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
    // Fastify parsed the body; shared Web handler owns payload validation.
    headers.delete('content-length');
    const webRequest=new Request('http://local'+request.url,{method:request.method,headers,...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});
    const external=/^\/v1\/autonomous-tasks\/[^/]+\/external-/.test(new URL(webRequest.url).pathname);
    const service={async execute(operation:Parameters<typeof autonomousService.execute>[0],input:Record<string,unknown>){
      if(operation==='cancel'||operation==='revise'){
        if(options.localExternalService){try{await options.localExternalService.beforeCoreMutation(input.id as string,operation);}catch{throw Object.assign(new Error('External bridge unavailable'),{statusCode:503});}}
        else{const task=await autonomousService.execute('get',{id:input.id}) as {spec:{externalProfiles?:string[]};actions:{tool:string;requestId:string}[]};
          const revised=input.spec as {externalProfiles?:string[]}|undefined;
          if(task.spec.externalProfiles?.length||revised?.externalProfiles?.length||task.actions.some(a=>a.tool==='mcp__hivemind__action'||a.requestId.startsWith('external:')))throw Object.assign(new Error('External bridge unavailable'),{statusCode:503});}
      }
      if(operation==='approve'){
        const task=await autonomousService.execute('get',{id:input.id}) as {spec:{externalProfiles?:string[]}};
        if(task.spec.externalProfiles?.length){
          const external=options.localExternalService;
          if(!external?.assertApproval)throw Object.assign(new Error('External bridge unavailable'),{statusCode:503});
          const hashes=input.externalProfileHashes;
          if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)||Object.keys(hashes).length!==task.spec.externalProfiles.length||task.spec.externalProfiles.some(id=>!Object.hasOwn(hashes,id)))throw Object.assign(new Error('External approval conflict'),{statusCode:409});
          try{await external.assertApproval(input.id as string,input.revision as number,hashes as Record<string,string>);}catch(error){const status=(error as {statusCode?:number})?.statusCode;throw Object.assign(new Error('External approval unavailable'),{statusCode:status&&[400,403,404,409,422,503].includes(status)?status:503});}
          const approved=await autonomousService.execute(operation,input);
          try{await external.approve(input.id as string);}catch(error){const status=(error as {statusCode?:number})?.statusCode;throw Object.assign(new Error('External approval unavailable'),{statusCode:status&&[400,403,404,409,422,503].includes(status)?status:503});}
          return approved;
        }
      }
      return autonomousService.execute(operation,input);
    }};
    const response=external?await handleAutonomousExternalApi(webRequest,options.localExternalService?{operatorToken,workerToken,service:options.localExternalService}:undefined):await handleAutonomousApi(webRequest,{operatorToken,workerToken,reporterToken:options.nativeReporterToken,service});
    response.headers.forEach((value,key)=>reply.header(key,value));
    return reply.code(response.status).send(await response.text());
  }
  const cloudPrefix='/api/cloudflare/autonomous-tasks';
  async function cloudOperator(request:FastifyRequest,reply:FastifyReply){
    if(!equalSecret(request.headers.authorization??'',`Bearer ${operatorToken}`))return reply.code(401).send({error:'Unauthorized'});
    try{validateAutonomousCloudRequest(new Request('http://local'+request.url,{method:request.method}));}catch(error){const status=(error as {statusCode?:number})?.statusCode;return reply.code(status===400?400:404).send({error:'Invalid autonomous cloud request'});}
  }
  async function autonomousCloud(request:FastifyRequest,reply:FastifyReply){
    if(!options.autonomousCloudProxy)return reply.code(503).send({error:'Cloudflare autonomous request unavailable'});
    try{
      const response=await options.autonomousCloudProxy.forward(new Request('http://local'+request.url,{method:request.method,...(request.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(request.body)})}));
      const safe=await projectAutonomousCloudResponse(response,[operatorToken,workerToken,...(options.nativeReporterToken?[options.nativeReporterToken]:[])]);
      return reply.type('application/json').code(safe.status).send(await safe.text());
    }catch{return reply.code(503).send({error:'Cloudflare autonomous request unavailable'});}
  }
  for(const url of [cloudPrefix,cloudPrefix+'/*'])app.route({method:['GET','POST','PUT','DELETE','PATCH'],url,bodyLimit:65536,onRequest:cloudOperator,handler:autonomousCloud});
  if (options.cloudflare) app.addHook('onReady', async () => options.cloudflare!.start());
  app.addHook('onClose', async () => { try { await options.cloudflare?.close(); } finally { try { options.workflows?.close(); } finally { store.close(); } } });
  app.addHook('onRequest',async (_request,reply) => {
    reply.header('cache-control','no-store');
    reply.header('x-content-type-options','nosniff');
    reply.header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((error,request,reply) => {
    const path=new URL(request.url,'http://local').pathname;
    if ((path==='/v1/autonomous-tasks'||path.startsWith('/v1/autonomous-tasks/')||path===cloudPrefix||path.startsWith(cloudPrefix+'/')) && error instanceof Error && 'statusCode' in error && typeof error.statusCode==='number' && error.statusCode>=400 && error.statusCode<500) {
      return reply.code(error.statusCode).send({error:error.statusCode===413?'Autonomous request too large':'Invalid autonomous request'});
    }
    if (error instanceof DomainError) return reply.code(error.statusCode).send({error:error.message});
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({error:error.message});
    request.log.error(error); return reply.code(500).send({error:'Internal server error'});
  });
  const guard = (token: string) => async (request: FastifyRequest,reply: FastifyReply) => {
    if (!equalSecret(request.headers.authorization ?? '',`Bearer ${token}`)) return reply.code(401).send({error:'Unauthorized'});
  };
  const operator = guard(operatorToken), worker = guard(workerToken);
  app.get('/health',async () => ({status:'ok',mode:options.cloudflare ? (options.repository ? 'hybrid-workers' : 'cloudflare-bridge') : options.repository ? 'local-workers' : 'mock-local'}));
  app.get('/favicon.ico',async (_request,reply) => reply.code(204).send());
  const staticRoot = new URL('../../../../apps/dashboard/public/',import.meta.url);
  for (const [route,file,mime] of [['/','index.html','text/html'],['/app.js','app.js','application/javascript'],['/styles.css','styles.css','text/css'],['/brand/hivemind-logo.png','brand/hivemind-logo.png','image/png'],['/brand/hivemind-bee.png','brand/hivemind-bee.png','image/png']] as const) {
    app.get(route,async (_request,reply) => reply.type(mime.startsWith('image/') ? mime : mime+'; charset=utf-8').send(await readFile(fileURLToPath(new URL(file,staticRoot)))));
  }
  app.get('/api/capabilities',{preHandler:operator},async () => ({providers:options.repository ? ['mock','codex','claude'] : ['mock'],repository:options.repository ?? null,...(options.cloudflare ? {cloudflare:{...options.cloudflare.capabilities(),...(options.workflows?{workflows:true}:{})}} : {})}));
  app.get('/api/state',{preHandler:operator},async () => ({...store.state(),...(options.cloudflare ? {cloudflare:options.cloudflare.state()} : {})}));
  if (options.cloudflare) {
    const cloudflare = options.cloudflare;
    app.post<{Body:CreateTask}>('/api/cloudflare/tasks',{
      preHandler:operator,schema:body({...taskProperties,provider:{type:'string',enum:['codex','claude']},runtime:{type:'string',const:'cloudflare'}},taskRequired),
    },async (request,reply) => reply.code(201).send(cloudflare.create(request.body)));
    app.post<{Params:{id:string};Body:{decision:string;reason:string}}>('/api/cloudflare/tasks/:id/decision',{
      preHandler:operator,schema:body({decision:{type:'string',enum:['approve','reject']},reason:string}),
    },async request => cloudflare.decision(request.params.id,request.body.decision,request.body.reason));
    app.post<{Params:{id:string};Body:{reason:string}}>('/api/cloudflare/tasks/:id/cancel',{
      preHandler:operator,schema:body({reason:string}),
    },async request => cloudflare.cancel(request.params.id,request.body.reason));
  }
  if (options.workflows) {
    const workflows = options.workflows;
    app.post('/api/cloudflare/workflows',{preHandler:operator},async (request,reply) => reply.code(201).send(await workflows.draft(request.body)));
    app.get('/api/cloudflare/workflows',{preHandler:operator},async () => ({workflows:workflows.list()}));
    app.post<{Params:{id:string}}>('/api/cloudflare/workflows/:id/approve',{
      preHandler:operator,schema:body({contractHash:{type:'string',pattern:'^[a-f0-9]{64}$'}}),
    },async request => workflows.approve(request.params.id,request.body));
    app.get<{Params:{id:string}}>('/api/cloudflare/workflows/:id',{preHandler:operator},
      async request => workflows.read(request.params.id,false,false));
    app.get<{Params:{id:string};Querystring:{diff?:string}}>('/api/cloudflare/workflows/:id/result',{preHandler:operator},
      async request => workflows.read(request.params.id,true,request.query.diff==='1'));
  }
  app.post<{Body:CreateTask}>('/api/tasks',{
    preHandler:operator,
    schema:body(taskProperties,taskRequired),
  },async (request,reply) => reply.code(201).send(store.create(request.body)));
  app.get<{Params:{id:string}}>('/api/tasks/:id',{preHandler:operator},
    async request => store.taskDetail(request.params.id));
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
