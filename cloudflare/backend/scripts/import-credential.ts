// Operator-only: input paths, never credential values, are accepted as arguments.
import {readFile,stat} from 'node:fs/promises';
import {validateAuth} from '../src/crypto.ts';
import type {Provider} from '../src/contracts.ts';
const [provider,id,path,secretsPath]=process.argv.slice(2);
if(!['codex','claude'].includes(provider??'')||!id||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)||!path||!secretsPath)throw new Error('Usage: import-credential.ts codex|claude ID AUTH_FILE CONTROL_SECRETS_FILE');
if(!process.env.HIVEMIND_URL)throw new Error('Set HIVEMIND_URL');
const origin=new URL(process.env.HIVEMIND_URL);
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Use an HTTPS backend origin');
for(const file of [path,secretsPath]){const info=await stat(file);if(!info.isFile()||info.mode&0o077)throw new Error('Credential input files must be private (0600)');}
const auth=validateAuth(provider as Provider,(await readFile(path,'utf8')).trim());
const secrets=JSON.parse(await readFile(secretsPath,'utf8'));
if(typeof secrets.CONTROL_TOKEN!=='string')throw new Error('Control secret is unavailable');
try{
 const response=await fetch(new URL(`/v1/credentials/${id}`,origin),{method:'POST',headers:{authorization:`Bearer ${secrets.CONTROL_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({provider,auth}),redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`Credential import rejected (${response.status})`);
 const record=await response.json() as Record<string,unknown>;
 console.log(JSON.stringify({id:record.id,provider:record.provider,generation:record.generation,quarantined:record.quarantined}));
}catch(error){console.error(error instanceof Error&&/^Credential import rejected \(\d+\)$/.test(error.message)?error.message:'Credential import could not complete');process.exitCode=1;}
