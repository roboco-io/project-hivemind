export interface GuardPaths {home:string;privateDir:string;workspace:string;scriptRoot:string}
export const CLAUDE_GUARD_PATHS:GuardPaths=Object.freeze({home:'/home/node',privateDir:'/home/node/.hivemind-phase0',workspace:'/workspace',scriptRoot:'/opt/hivemind/scripts/phase0'});
export function claudeGuardHome(paths:GuardPaths=CLAUDE_GUARD_PATHS):string{return paths.home+'/.codex-guard';}
export function claudeOuterSandboxSettings(paths:GuardPaths=CLAUDE_GUARD_PATHS,nested=true){
 return {filesystem:{denyRead:['/proc','/runtime',paths.privateDir,paths.home+'/.claude',paths.home+'/.claude.json'],denyWrite:['/runtime',paths.privateDir],allowWrite:[paths.workspace,claudeGuardHome(paths),'/tmp']},network:{allowedDomains:[] as string[],deniedDomains:[] as string[]},enableWeakerNestedSandbox:nested,allowNestedUserNamespaces:true,credentials:{envVars:[{name:'CLAUDE_CODE_OAUTH_TOKEN',mode:'deny'}]}};
}
const excluded=new Set(['CLAUDE_CODE_OAUTH_TOKEN','CONTROL_TOKEN','AUTH_STORAGE_KEY','AUTH_RETURN_PRIVATE_KEY','AUTH_WRAP_KEY','PROBE_TOKEN','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','BASH_ENV','ENV']);
export function filteredEnvironment(source:NodeJS.ProcessEnv):Record<string,string>{
 return Object.fromEntries(Object.entries(source).filter((entry):entry is [string,string]=>entry[1]!==undefined&&!excluded.has(entry[0])&&!/^(OPENAI_|ANTHROPIC_|CLOUDFLARE_|CF_API_|AWS_|CODEX_)/.test(entry[0])));
}
export function claudeGuardEnvironment(source:NodeJS.ProcessEnv,paths:GuardPaths=CLAUDE_GUARD_PATHS):Record<string,string>{
 return {...filteredEnvironment(source),TMPDIR:'/tmp',CODEX_HOME:claudeGuardHome(paths)};
}
