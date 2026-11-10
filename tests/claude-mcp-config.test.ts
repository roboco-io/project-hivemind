import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configureHivemindClaude } from '../scripts/configure-hivemind-claude.js';
function fixture():string {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'hive-claude-')));
  execFileSync('git',['init','-q',root]);mkdirSync(join(root,'dist/apps/mcp-server/src'),{recursive:true});writeFileSync(join(root,'dist/apps/mcp-server/src/main.js'),'// fixture');return root;
}
const options=(projectRoot:string)=>({projectRoot,nodePath:process.execPath});
const read=(root:string,path='.mcp.json')=>readFileSync(join(root,path),'utf8');
function withRoot(run:(root:string)=>void):void {const root=fixture();try{run(root);}finally{rmSync(root,{recursive:true,force:true});}}

test('Claude registration preserves existing JSON values and writes private native launch settings',()=>withRoot(root=>{
  const original='{"unknown":{"large":90071992547409931234,"negative":-0},"mcpServers":{"other":{"env":{"KEY":"private-other"}}}}';
  writeFileSync(join(root,'.mcp.json'),original);const tokenFile=join(root,'operator.json');writeFileSync(tokenFile,'SECRET');
  const result=configureHivemindClaude({...options(root),apiUrl:'https://example.invalid',operatorTokenFile:tokenFile});
  const source=read(root),entry=JSON.parse(source).mcpServers.hivemind;
  assert.equal(result.configPath,join(root,'.mcp.json'));assert.equal(result.changed,true);
  assert.ok(source.includes('"large":90071992547409931234,"negative":-0'));
  assert.deepEqual(entry,{command:process.execPath,args:[join(root,'dist/apps/mcp-server/src/main.js')],env:{HIVEMIND_API_URL:'https://example.invalid',HIVEMIND_OPERATOR_TOKEN_FILE:tokenFile}});
  assert.ok(!source.includes('SECRET'));assert.equal(statSync(join(root,'.mcp.json')).mode&0o777,0o600);
  assert.equal(statSync(join(root,'.claude/hivemind-mcp.local.json')).mode&0o777,0o600);
  for(const path of ['.mcp.json','.claude/hivemind-mcp.local.json'])assert.equal(execFileSync('git',['-C',root,'check-ignore',path],{encoding:'utf8'}).trim(),path);
  assert.equal(configureHivemindClaude({...options(root),apiUrl:'https://example.invalid',operatorTokenFile:tokenFile}).changed,false);
  configureHivemindClaude({...options(root),apiUrl:'http://localhost:4312'});assert.equal(JSON.parse(read(root)).mcpServers.hivemind.env.HIVEMIND_API_URL,'http://localhost:4312');
}));

test('duplicate keys at every nesting level and malformed JSON are refused unchanged',()=>{
  for(const source of ['{"mcpServers":{},"mcpServers":{}}','{"mcpServers":{"x":{},"\\u0078":{}}}','{"extra":[{"a":1,"a":2}]}','{"mcpServers":[]}','[]','{bad'])withRoot(root=>{
    writeFileSync(join(root,'.mcp.json'),source);const exclude=read(root,'.git/info/exclude');
    assert.throws(()=>configureHivemindClaude(options(root)));assert.equal(read(root),source);assert.equal(read(root,'.git/info/exclude'),exclude);assert.equal(existsSync(join(root,'.claude')),false);
  });
});
test('unmanaged server and user edits to managed entry are refused',()=>withRoot(root=>{
  writeFileSync(join(root,'.mcp.json'),'{"mcpServers":{"hivemind":{"command":"custom"}}}');
  assert.throws(()=>configureHivemindClaude(options(root)));rmSync(join(root,'.mcp.json'));configureHivemindClaude(options(root));
  const edited=read(root).replace('http://127.0.0.1:4310','http://localhost:4999');writeFileSync(join(root,'.mcp.json'),edited);
  assert.throws(()=>configureHivemindClaude(options(root)));assert.equal(read(root),edited);
}));
test('tracked local configuration or marker is refused',()=>{
  for(const target of ['.mcp.json','.claude/hivemind-mcp.local.json'])withRoot(root=>{
    mkdirSync(join(root,'.claude'));writeFileSync(join(root,target),'{}');execFileSync('git',['-C',root,'add','--',target]);
    assert.throws(()=>configureHivemindClaude(options(root)));assert.equal(read(root,target),'{}');
  });
});
test('symlink config, marker, parent and exclude paths are refused',()=>{
  for(const target of ['.mcp.json','.claude','.claude/hivemind-mcp.local.json','.git/info/exclude'])withRoot(root=>{
    const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'file'),'{}');
    if(target.includes('hivemind-mcp'))mkdirSync(join(root,'.claude'));
    if(target==='.git/info/exclude')rmSync(join(root,target));
    symlinkSync(target==='.claude'?outside:join(outside,'file'),join(root,target));
    assert.throws(()=>configureHivemindClaude(options(root)));assert.equal(readFileSync(join(outside,'file'),'utf8'),'{}');
  });
});
test('invalid URLs, missing build, and overriding ignore rules cannot partially install',()=>{
  for(const scenario of ['url','build','ignore-config','ignore-marker'])withRoot(root=>{
    const exclude=read(root,'.git/info/exclude');
    if(scenario==='build')rmSync(join(root,'dist/apps/mcp-server/src/main.js'));
    if(scenario.startsWith('ignore'))writeFileSync(join(root,'.gitignore'),scenario==='ignore-config'?'!/.mcp.json\n':'!/.claude/hivemind-mcp.local.json\n');
    assert.throws(()=>configureHivemindClaude({...options(root),...(scenario==='url'?{apiUrl:'http://remote.invalid'}:{})}));
    assert.equal(existsSync(join(root,'.mcp.json')),false);assert.equal(existsSync(join(root,'.claude/hivemind-mcp.local.json')),false);assert.equal(read(root,'.git/info/exclude'),exclude);
  });
});
test('native TypeScript CLI accepts the documented common flags',()=>withRoot(root=>{
  const tokenFile=join(root,'operator.json');writeFileSync(tokenFile,'not-copied');
  execFileSync(process.execPath,[resolve('scripts/configure-hivemind-claude.ts'),'--project-root',root,'--node-path',process.execPath,'--api-url','https://example.invalid','--operator-token-file',tokenFile],{encoding:'utf8'});
  assert.equal(JSON.parse(read(root)).mcpServers.hivemind.env.HIVEMIND_OPERATOR_TOKEN_FILE,tokenFile);
}));

function withGitStub(root:string,body:string,run:()=>void):void {
  const original=process.env.PATH,realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(),bin=join(root,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'git'),'#!'+process.execPath+'\n'+`const {execFileSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\n${body}\ntry { process.stdout.write(execFileSync(${JSON.stringify(realGit)},args,{env:process.env,stdio:['ignore','pipe','ignore']})); } catch(error) { process.exitCode=error.status||1; }\n`,{mode:0o700});
  process.env.PATH=bin+':'+original;try{run();}finally{if(original===undefined)delete process.env.PATH;else process.env.PATH=original;}
}
test('a concurrent config edit is preserved and earlier exclude writes roll back',()=>withRoot(root=>{
  writeFileSync(join(root,'.mcp.json'),'{}');const exclude=read(root,'.git/info/exclude');
  withGitStub(root,`if(args.includes('check-ignore'))fs.writeFileSync(${JSON.stringify(join(root,'.mcp.json'))},'{"concurrent":true}');`,()=>{
    assert.throws(()=>configureHivemindClaude(options(root)),/Concurrent/);
  });
  assert.equal(read(root),'{"concurrent":true}');assert.equal(read(root,'.git/info/exclude'),exclude);assert.equal(existsSync(join(root,markerNameForTest)),false);
}));
const markerNameForTest='.claude/hivemind-mcp.local.json';
test('a concurrent exclude edit refuses completion and leaves private recovery evidence',()=>withRoot(root=>{
  const excludePath=join(root,'.git/info/exclude');
  withGitStub(root,`if(args.includes('check-ignore'))fs.appendFileSync(${JSON.stringify(excludePath)},'# concurrent edit\\n');`,()=>{
    assert.throws(()=>configureHivemindClaude(options(root)),/recovery/);
  });
  assert.ok(read(root,'.git/info/exclude').includes('# concurrent edit'));
  assert.ok(existsSync(join(root,'.claude/hivemind-mcp.transaction.local/manifest.json')));
}));
test('Git receives no inherited provider or operator secrets',()=>withRoot(root=>{
  const capture=join(root,'git-env.jsonl'),previous=process.env.HIVEMIND_OPERATOR_TOKEN;process.env.HIVEMIND_OPERATOR_TOKEN='DO-NOT-INHERIT';
  try{withGitStub(root,`fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,env:process.env})+'\\n');`,()=>configureHivemindClaude(options(root)));
    for(const line of read(root,'git-env.jsonl').trim().split('\n')){
      const call=JSON.parse(line);assert.equal(call.env.HIVEMIND_OPERATOR_TOKEN,undefined);assert.equal(call.env.HOME,undefined);assert.equal(call.env.GIT_CONFIG_NOSYSTEM,'1');assert.ok(call.args.includes('core.fsmonitor=false'));
    }
  }finally{if(previous===undefined)delete process.env.HIVEMIND_OPERATOR_TOKEN;else process.env.HIVEMIND_OPERATOR_TOKEN=previous;}
}));
test('linked worktrees use the shared Git exclude without changing Codex files',()=>withRoot(root=>{
  const linked=join(root,'linked');
  execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
  execFileSync('git',['-C',root,'worktree','add','--detach','-q',linked]);mkdirSync(join(linked,'dist/apps/mcp-server/src'),{recursive:true});writeFileSync(join(linked,'dist/apps/mcp-server/src/main.js'),'// fixture');
  mkdirSync(join(linked,'.codex'));writeFileSync(join(linked,'.codex/config.toml'),'original-codex');configureHivemindClaude(options(linked));
  assert.ok(read(root,'.git/info/exclude').includes('/.mcp.json'));assert.equal(read(linked,'.codex/config.toml'),'original-codex');
}));
