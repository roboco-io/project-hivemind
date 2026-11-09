import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Snapshot, SourceFile } from './contracts.ts';

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_FILES = 1000;
const privateDirectories = new Set(['.git','.codex','.claude','.hivemind','.wrangler','.playwright-mcp','node_modules','dist','reports','.ssh','.aws','.azure','.docker']);
const privateNames = new Set(['auth.json','.credentials.json','credentials.json','secrets.json','cloudflare-secrets.json','.npmrc','.pypirc','.netrc','.git-credentials','.gitconfig','id_rsa','id_dsa','id_ecdsa','id_ed25519']);
export function excludedSourcePath(path: string): boolean {
  return path.split('/').some(segment => {
    const name = segment.toLowerCase();
    return privateDirectories.has(name) || privateNames.has(name) || name.startsWith('.env') || name.startsWith('.dev.vars') || /\.(pem|key|p12|pfx)$/.test(name);
  });
}
export function canonicalSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('\\') || /^[a-z]:/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid source path');
  const path=value.normalize('NFC');
  if (path.length > 512 || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid source path');
  if (excludedSourcePath(path)) throw new Error('Reserved source path is excluded');
  return path;
}
export const sha256 = (bytes: string|Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function checkedFiles(value: unknown): SourceFile[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_FILES) throw new Error('Source file count limit exceeded');
  let bytes=0;
  const names=new Set<string>();
  const files=value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source file');
    const f=item as Record<string,unknown>,path=canonicalSourcePath(f.path),key=path.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate source path collision');
    names.add(key);
    if (typeof f.content !== 'string' || f.content.length > Math.ceil(MAX_SOURCE_BYTES/3)*4 || f.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(f.content)) throw new Error('Invalid base64 source content or size limit');
    const content=Buffer.from(f.content,'base64');
    if (content.toString('base64') !== f.content) throw new Error('Invalid canonical base64 source content');
    bytes+=content.length;
    if (bytes > MAX_SOURCE_BYTES) throw new Error('Source byte size limit exceeded');
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || sha256(content) !== f.sha256) throw new Error('Source content hash mismatch');
    if (typeof f.executable !== 'boolean') throw new Error('Invalid source executable flag');
    return {path,content:f.content,sha256:f.sha256,executable:f.executable};
  }).sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for(const file of files){const parts=file.path.toLowerCase().split('/');parts.pop();while(parts.length){if(names.has(parts.join('/')))throw new Error('Source ancestor path collision');parts.pop();}}
  return files;
}
function digest(files:SourceFile[]):string {
  return sha256(JSON.stringify({version:1,files:files.map(f=>({path:f.path,sha256:f.sha256,executable:f.executable}))}));
}
export function snapshotDigest(files:SourceFile[]):string {return digest(checkedFiles(files));}
export function createSnapshot(files:SourceFile[]):Snapshot {const checked=checkedFiles(files);return {version:1,digest:digest(checked),files:checked};}
export function validateSnapshot(value:unknown):Snapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot');
  const snapshot=value as Record<string,unknown>;
  if (snapshot.version !== 1) throw new Error('Unsupported snapshot version');
  const checked=createSnapshot(snapshot.files as SourceFile[]);
  if (snapshot.digest !== checked.digest) throw new Error('Snapshot digest mismatch');
  return checked;
}
