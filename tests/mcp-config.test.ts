import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { configureHivemindMcp } from '../scripts/configure-hivemind-mcp.js';
function fixture():string {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'hive-mcp-config-')));
  execFileSync('git',['init','-q',root]);mkdirSync(join(root,'dist/apps/mcp-server/src'),{recursive:true});writeFileSync(join(root,'dist/apps/mcp-server/src/main.js'),'// test fixture');return root;
}
function config(root:string):string {return readFileSync(join(root,'.codex/config.toml'),'utf8');}
const options=(projectRoot:string)=>({projectRoot,nodePath:process.execPath});

test('project installer preserves unrelated config and writes only local safe launch settings',()=>{
  const root=fixture();try {
    mkdirSync(join(root,'.codex'));const original='model = "example-model"\n\n[mcp_servers.other]\ncommand = "other"\n';writeFileSync(join(root,'.codex/config.toml'),original);writeFileSync(join(root,'.gitignore'),'keep-this\n');
    const tokenFile=join(root,'private-operator.json');writeFileSync(tokenFile,'{"OPERATOR_TOKEN":"DO-NOT-COPY-TOKEN"}',{mode:0o600});
    configureHivemindMcp({...options(root),apiUrl:'http://127.0.0.1:4311',operatorTokenFile:tokenFile});
    const output=config(root);assert.ok(output.startsWith(original));assert.match(output,/\[mcp_servers\.hivemind\]/);assert.ok(output.includes('command = '+JSON.stringify(process.execPath)));assert.ok(output.includes(JSON.stringify(join(root,'dist/apps/mcp-server/src/main.js'))));assert.ok(output.includes('cwd = '+JSON.stringify(root)));assert.match(output,/default_tools_approval_mode = "writes"/);assert.match(output,/HIVEMIND_API_URL = "http:\/\/127\.0\.0\.1:4311"/);assert.ok(output.includes('HIVEMIND_OPERATOR_TOKEN_FILE = '+JSON.stringify(tokenFile)));assert.ok(!output.includes('DO-NOT-COPY-TOKEN'));assert.equal(statSync(join(root,'.codex/config.toml')).mode&0o777,0o600);
    assert.equal(readFileSync(join(root,'.gitignore'),'utf8'),'keep-this\n');assert.equal(execFileSync('git',['-C',root,'check-ignore','.codex/config.toml'],{encoding:'utf8'}).trim(),'.codex/config.toml');
    const before=statSync(join(root,'.codex/config.toml')).mtimeMs;configureHivemindMcp({...options(root),apiUrl:'http://127.0.0.1:4311',operatorTokenFile:tokenFile});assert.equal(config(root),output);assert.equal(statSync(join(root,'.codex/config.toml')).mtimeMs,before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('managed updates retain unrelated settings before and after the block',()=>{
  const root=fixture();try {
    configureHivemindMcp(options(root));const initial=config(root);writeFileSync(join(root,'.codex/config.toml'),'# before\n'+initial+'\n[unrelated]\nvalue = "preserve"\n');
    configureHivemindMcp({...options(root),apiUrl:'http://localhost:4311'});const updated=config(root);assert.ok(updated.startsWith('# before\n'));assert.ok(updated.endsWith('\n[unrelated]\nvalue = "preserve"\n'));assert.match(updated,/HIVEMIND_API_URL = "http:\/\/localhost:4311"/);assert.equal(updated.match(/\[mcp_servers\.hivemind\]/g)?.length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unmanaged hivemind entries and malformed managed markers fail without changing files',()=>{
  for (const existing of ['[mcp_servers.hivemind]\ncommand="custom"\n','[mcp_servers."hivemind".env]\nX="Y"\n','mcp_servers.hivemind = {command="custom"}\n','[mcp_servers]\nhivemind = {command="custom"}\n','# BEGIN HIVEMIND MCP (managed)\n']) {
    const root=fixture();try {mkdirSync(join(root,'.codex'));writeFileSync(join(root,'.codex/config.toml'),existing);assert.throws(()=>configureHivemindMcp(options(root)));assert.equal(config(root),existing);} finally {rmSync(root,{recursive:true,force:true});}
  }
});

test('installer refuses symlinked config directories, config files, and Git exclude files',()=>{
  for(const target of ['directory','config','exclude']) {
    const root=fixture(),outside=realpathSync(mkdtempSync(join(tmpdir(),'hive-mcp-outside-')));try {
      if(target==='directory') symlinkSync(outside,join(root,'.codex'),'dir');
      if(target==='config') {mkdirSync(join(root,'.codex'));writeFileSync(join(outside,'config.toml'),'# untouched');symlinkSync(join(outside,'config.toml'),join(root,'.codex/config.toml'));}
      if(target==='exclude') {rmSync(join(root,'.git/info/exclude'));writeFileSync(join(outside,'exclude'),'# untouched');symlinkSync(join(outside,'exclude'),join(root,'.git/info/exclude'));}
      assert.throws(()=>configureHivemindMcp(options(root)));assert.equal(existsSync(join(outside,'hivemind-created')),false);if(target==='config')assert.equal(readFileSync(join(outside,'config.toml'),'utf8'),'# untouched');if(target==='exclude')assert.equal(readFileSync(join(outside,'exclude'),'utf8'),'# untouched');
    } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
  }
});

test('linked worktrees use their common Git info exclude',()=>{
  const root=fixture(),worktree=join(dirname(root),root.split('/').at(-1)+'-linked');try {
    execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);execFileSync('git',['-C',root,'worktree','add','--detach','-q',worktree]);mkdirSync(join(worktree,'dist/apps/mcp-server/src'),{recursive:true});writeFileSync(join(worktree,'dist/apps/mcp-server/src/main.js'),'// fixture');
    configureHivemindMcp(options(worktree));assert.ok(readFileSync(join(root,'.git/info/exclude'),'utf8').includes('/.codex/config.toml'));assert.equal(execFileSync('git',['-C',worktree,'check-ignore','.codex/config.toml'],{encoding:'utf8'}).trim(),'.codex/config.toml');assert.equal(lstatSync(join(worktree,'.git')).isFile(),true);
  } finally {rmSync(worktree,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});

test('invalid URLs and missing built entry leave project config absent',()=>{
  const root=fixture();try {
    for(const apiUrl of ['http://remote.example.invalid','https://user:password@example.invalid','http://127.0.0.1:4310/?token=secret']) assert.throws(()=>configureHivemindMcp({...options(root),apiUrl}));
    rmSync(join(root,'dist/apps/mcp-server/src/main.js'));assert.throws(()=>configureHivemindMcp(options(root)));assert.equal(existsSync(join(root,'.codex')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('native TypeScript CLI configures a fixture without requiring compiled installer code',()=>{
  const root=fixture();try {
    const script=resolve('scripts/configure-hivemind-mcp.ts');const output=execFileSync(process.execPath,[script,'--project-root',root,'--api-url','http://127.0.0.1:4311'],{cwd:root,encoding:'utf8'});assert.match(output,/HIVEMIND MCP/);assert.match(config(root),/4311/);chmodSync(join(root,'.codex/config.toml'),0o644);configureHivemindMcp({...options(root),apiUrl:'http://127.0.0.1:4311'});assert.equal(statSync(join(root,'.codex/config.toml')).mode&0o777,0o600);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('inherited Git routing cannot redirect project configuration or ignore rules',()=>{
  const root=fixture(),foreign=fixture(),oldDir=process.env.GIT_DIR,oldWorktree=process.env.GIT_WORK_TREE;
  try {
    const foreignExclude=readFileSync(join(foreign,'.git/info/exclude'),'utf8');process.env.GIT_DIR=join(foreign,'.git');process.env.GIT_WORK_TREE=foreign;
    configureHivemindMcp(options(root));assert.match(config(root),/mcp_servers\.hivemind/);assert.equal(readFileSync(join(foreign,'.git/info/exclude'),'utf8'),foreignExclude);assert.equal(existsSync(join(foreign,'.codex')),false);
  } finally {if(oldDir===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=oldDir;if(oldWorktree===undefined)delete process.env.GIT_WORK_TREE;else process.env.GIT_WORK_TREE=oldWorktree;rmSync(root,{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true});}
});

test('an overriding Git unignore rule prevents writing machine-specific config',()=>{
  const root=fixture();try {
    writeFileSync(join(root,'.gitignore'),'!/.codex/config.toml\n');assert.throws(()=>configureHivemindMcp(options(root)));assert.equal(existsSync(join(root,'.codex/config.toml')),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});


test('Git subprocesses receive only a minimal environment and disabled configuration hooks',()=>{
  const root=fixture(),originalEnv=process.env,bin=join(root,'stub-bin'),capture=join(root,'git-calls.jsonl');
  try {
    mkdirSync(bin);writeFileSync(join(bin,'git'),'#!'+process.execPath+'\n'+`
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,env:process.env})+'\\n',{mode:0o600});
if(args.includes('--show-toplevel'))process.stdout.write(${JSON.stringify(root)}+'\\n');
else if(args.includes('--git-common-dir'))process.stdout.write(${JSON.stringify(join(root,'.git'))}+'\\n');
else if(args.includes('ls-files'))process.exitCode=1;
else if(!args.includes('check-ignore'))process.exitCode=2;
`,{mode:0o700});
    process.env={PATH:bin+delimiter+(originalEnv.PATH??''),LANG:'C',LC_ALL:'C',TMPDIR:root,HOME:join(root,'fake-home'),NODE_OPTIONS:'--no-warnings',HIVEMIND_OPERATOR_TOKEN:'synthetic-operator',HIVEMIND_CLOUDFLARE_CONTROL_TOKEN:'synthetic-control',AWS_ACCESS_KEY_ID:'synthetic-aws-key',AWS_SECRET_ACCESS_KEY:'synthetic-aws-secret',OPENAI_API_KEY:'synthetic-openai',ANTHROPIC_API_KEY:'synthetic-anthropic',GIT_CONFIG_SYSTEM:'/poison-system-config'};
    configureHivemindMcp(options(root));
    const calls=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line) as {args:string[];env:Record<string,string>});assert.ok(calls.length>=4);
    for(const call of calls) {
      for(const key of ['HIVEMIND_OPERATOR_TOKEN','HIVEMIND_CLOUDFLARE_CONTROL_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','HOME','NODE_OPTIONS'])assert.equal(call.env[key],undefined,key+' must not reach Git');
      assert.equal(call.env.PATH,process.env.PATH);assert.equal(call.env.LANG,'C');assert.equal(call.env.LC_ALL,'C');assert.equal(call.env.TMPDIR,root);
      const nullDevice=process.platform==='win32'?'NUL':'/dev/null';assert.equal(call.env.GIT_CONFIG_GLOBAL,nullDevice);assert.equal(call.env.GIT_CONFIG_SYSTEM,nullDevice);assert.equal(call.env.GIT_CONFIG_NOSYSTEM,'1');assert.ok(call.args.includes('core.hooksPath='+nullDevice));assert.ok(call.args.includes('core.fsmonitor=false'));
    }
  } finally {process.env=originalEnv;rmSync(root,{recursive:true,force:true});}
});
