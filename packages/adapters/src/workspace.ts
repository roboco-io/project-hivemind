import { mkdir, realpath, lstat, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runProcess, processEnvironment } from './process.js';

export interface Workspace { path: string; artifactPath: string; repositoryPath: string; baseCommit: string }
export interface WorkspaceOptions { repositoryPath: string; worktreeRoot: string; runId: string; baseCommit: string }

async function git(cwd: string, args: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, maximum = 64000) {
  const result = await runProcess(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,signal,timeoutMs:30000,env,maxOutputBytes:maximum});
  if (result.status !== 'passed') throw new Error(`Git ${args[0]} failed: ${result.stderr.slice(0,2000)}`);
  return result;
}

export async function createWorkspace(options: WorkspaceOptions, signal: AbortSignal): Promise<Workspace> {
  signal.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(options.runId)) throw new Error('Invalid run ID');
  if (!/^[0-9a-f]{40}$/i.test(options.baseCommit)) throw new Error('Invalid fixed base commit');
  const repositoryPath = await realpath(options.repositoryPath);
  const root = resolve(options.worktreeRoot);
  await mkdir(root,{recursive:true});
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot,options.runId);
  try { await lstat(path); throw new Error('Worktree directory already exists; reuse is not allowed'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const artifactPath = join(canonicalRoot,'.artifacts',options.runId);
  await mkdir(join(artifactPath,'home'),{recursive:true});
  const environment = processEnvironment(join(artifactPath,'home'));
  const top = (await git(repositoryPath,['rev-parse','--show-toplevel'],signal,environment)).stdout.trim();
  if (await realpath(top) !== repositoryPath) throw new Error('Configured repository path must be its Git root');
  const type = (await git(repositoryPath,['cat-file','-t',options.baseCommit],signal,environment)).stdout.trim();
  if (type !== 'commit') throw new Error('Base object is not a Git commit');
  await git(repositoryPath,['worktree','add','--detach',path,options.baseCommit],signal,environment);
  return {path,artifactPath,repositoryPath,baseCommit:options.baseCommit.toLowerCase()};
}

export async function collectWorkspaceDiff(workspace: Workspace, signal: AbortSignal): Promise<{diff:string;diffTruncated:boolean;headCommit:string}> {
  const environment = processEnvironment(join(workspace.artifactPath,'home'));
  const headCommit = (await git(workspace.path,['rev-parse','HEAD'],signal,environment)).stdout.trim();
  const temporary = await mkdtemp(join(workspace.artifactPath,'index-'));
  try {
    const isolatedIndex = {...environment,GIT_INDEX_FILE:join(temporary,'index')};
    await git(workspace.path,['read-tree',workspace.baseCommit],signal,isolatedIndex);
    await git(workspace.path,['add','--all'],signal,isolatedIndex);
    const result = await git(workspace.path,['diff','--cached','--binary','--no-ext-diff','--no-textconv',workspace.baseCommit,'--'],signal,isolatedIndex,720000);
    const diff = result.stdout.slice(0,180000);
    return {diff,diffTruncated:result.truncated || result.stdout.length > diff.length,headCommit};
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
