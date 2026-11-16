export const bashCategories=['npm-install','prisma','git','build','test','server','inspect','other'] as const;
export type BashCategory=typeof bashCategories[number];
const rules:[RegExp,string][]=[
 [/certificate verification failed|unable to (?:get|verify).*certificate|self.signed certificate|SSL certificate problem/i,'TLS certificate verification failed'],
 [/command not found|ENOENT.*(?:spawn|exec)/i,'Command executable was not found'],
 [/permission denied|operation not permitted|EACCES|EPERM/i,'Filesystem or process permission denied'],
 [/could not resolve|ENOTFOUND|EAI_AGAIN/i,'DNS resolution failed'],
 [/ECONNREFUSED|connection refused|failed to connect/i,'Connection to server failed'],
 [/EADDRINUSE|address already in use/i,'Server port is already in use'],
 [/Command timed out after \d+ seconds$/m,'Command reached its timeout'],
 [/Command aborted$/m,'Command was cancelled'],
 [/not a git repository/i,'Git repository was not initialized'],
 [/nothing to commit/i,'Git found no changes to commit'],
 [/fatal:.*(?:authentication|could not read username)|HTTP.*(?:401|403)/i,'Remote service rejected the request'],
 [/error TS\d+|TypeScript.*error/i,'TypeScript compilation failed'],
 [/Prisma.*(?:error|validation)|PrismaClient.*Error|Error code: P\d+/is,'Prisma command or database validation failed'],
 [/Failed files:\s*[1-9]|AssertionError|assertion.*failed|test.*failed/i,'Test or assertion failed'],
 [/npm error|npm ERR!/i,'npm command failed'],
];
export interface BashDiagnostic {categories:BashCategory[];exitCode:number|null;message:string}
export function classifyBash(command:unknown):BashCategory[]{
 if(typeof command!=='string')return ['other'];
 const s=command.slice(0,65536), categories:BashCategory[]=[];
 if(/\b(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+add)\b/.test(s))categories.push('npm-install');
 if(/\b(?:prisma|npm\s+run\s+db:)/.test(s))categories.push('prisma');
 if(/\bgit\s+(?:init|clone|fetch|status|add|commit|diff|log|show|checkout|rev-parse|ls-remote)\b/.test(s))categories.push('git');
 if(/\b(?:tsc|npm\s+run\s+(?:build|typecheck))\b/.test(s))categories.push('build');
 if(/\bhurl\b|\bnpm\s+(?:test|run\s+test)\b|run-hurl-tests/.test(s))categories.push('test');
 if(/\bnpm\s+run\s+(?:dev|start)\b|\bcurl\b.*localhost|\bsleep\s+\d/.test(s))categories.push('server');
 if(/(?:^|[;&|\n])\s*(?:ls|cat|head|tail|sed|rg|grep|find|pwd)\b/.test(s))categories.push('inspect');
 return categories.length?categories:['other'];
}
export function bashDiagnostic(categories:BashCategory[],result:unknown,isError:boolean):BashDiagnostic {
 const value=result as {content?:Array<{type?:string;text?:string}>;details?:{exitCode?:unknown}}|undefined;
 const text=(value?.content??[]).filter(x=>x.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n').slice(-32768);
 const match=/Command exited with code (\d+)\s*$/.exec(text);
 const detail=value?.details?.exitCode;
 const parsed=typeof detail==='number'?detail:match?Number(match[1]):isError?null:0;
 const exitCode=parsed!==null&&Number.isSafeInteger(parsed)&&parsed>=0&&parsed<=255?parsed:null;
 const message=isError?(rules.find(([pattern])=>pattern.test(text))?.[1]??'Command failed; diagnostic text omitted'):'';
 return {categories,exitCode,message};
}
export function validBashDiagnostic(value:unknown):value is BashDiagnostic {
 const x=value as BashDiagnostic;
 return !!x&&Array.isArray(x.categories)&&x.categories.length>0&&x.categories.length<=bashCategories.length&&
  x.categories.every(c=>bashCategories.includes(c))&&(x.exitCode===null||(Number.isInteger(x.exitCode)&&x.exitCode>=0&&x.exitCode<=255))&&
  (x.message===''||x.message==='Command failed; diagnostic text omitted'||rules.some(([,m])=>m===x.message));
}
