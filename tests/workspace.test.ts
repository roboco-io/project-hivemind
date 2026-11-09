import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, collectWorkspaceDiff } from '../packages/adapters/src/workspace.js';
const signal = () => new AbortController().signal;
const git = (cwd:string,...args:string[]) => execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'hivemind-workspace-')),repo=join(dir,'repo'); mkdirSync(repo);
  git(repo,'init'); writeFileSync(join(repo,'tracked.txt'),'base\n'); writeFileSync(join(repo,'deleted.txt'),'delete me\n');
  git(repo,'add','.'); git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  return {dir,repo,baseCommit:git(repo,'rev-parse','HEAD'),worktreeRoot:join(dir,'worktrees')};
}
test('detached worktrees preserve dirty primary files and index; actual diff includes additions and deletions',async()=>{
  const f=fixture();
  try {
    writeFileSync(join(f.repo,'tracked.txt'),'primary dirty\n'); git(f.repo,'add','tracked.txt');
    const index=git(f.repo,'diff','--cached','--binary');
    const a=await createWorkspace({...f,repositoryPath:f.repo,runId:'first'},signal());
    const b=await createWorkspace({...f,repositoryPath:f.repo,runId:'second'},signal());
    assert.notEqual(a.path,b.path); assert.equal(readFileSync(join(a.path,'tracked.txt'),'utf8'),'base\n');
    writeFileSync(join(a.path,'tracked.txt'),'changed\n'); writeFileSync(join(a.path,'new file.txt'),'new\n');
    writeFileSync(join(a.path,'binary.bin'),Buffer.from([0,1,2,255])); rmSync(join(a.path,'deleted.txt'));
    const result=await collectWorkspaceDiff(a,signal());
    assert.match(result.diff,/\+changed/); assert.match(result.diff,/new file.txt/); assert.match(result.diff,/deleted file mode/); assert.match(result.diff,/GIT binary patch/);
    assert.equal(result.headCommit,f.baseCommit); assert.equal(result.diffTruncated,false);
    assert.equal(git(f.repo,'diff','--cached','--binary'),index);
    assert.equal(readFileSync(join(f.repo,'tracked.txt'),'utf8'),'primary dirty\n');
    assert.equal(readFileSync(join(b.path,'tracked.txt'),'utf8'),'base\n');
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('workspaces reject unsafe run IDs, invalid commits and duplicate directory reuse',async()=>{
  const f=fixture();
  try {
    await assert.rejects(createWorkspace({...f,repositoryPath:f.repo,runId:'../escape'},signal()),/run|invalid/i);
    await assert.rejects(createWorkspace({...f,repositoryPath:f.repo,runId:'safe',baseCommit:'HEAD'},signal()),/commit|invalid/i);
    await assert.rejects(createWorkspace({...f,repositoryPath:f.repo,runId:'safe',baseCommit:'a'.repeat(40)},signal()),/commit|git/i);
    const options={...f,repositoryPath:f.repo,runId:'safe'};
    await createWorkspace(options,signal()); await assert.rejects(createWorkspace(options,signal()),/exist|reuse/i);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('unchanged worktree produces an empty real diff',async()=>{
  const f=fixture();
  try { const workspace=await createWorkspace({...f,repositoryPath:f.repo,runId:'empty'},signal()); assert.equal((await collectWorkspaceDiff(workspace,signal())).diff,''); }
  finally {rmSync(f.dir,{recursive:true,force:true});}
});
