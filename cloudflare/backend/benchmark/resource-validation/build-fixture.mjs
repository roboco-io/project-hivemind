import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const destination=process.argv[2]&&resolve(process.argv[2]);
if(!destination||destination===root||destination.startsWith(root+'/'))throw Error('Pass an output directory outside the fixture source');
const paths=[];
async function walk(dir=''){
 for(const entry of await readdir(join(root,dir),{withFileTypes:true})){
  const path=dir?dir+'/'+entry.name:entry.name;
  if(entry.name==='manifest.json'||entry.name==='build-fixture.mjs'||entry.name==='README.md')continue;
  if(entry.isSymbolicLink()||entry.name.startsWith('.')||['node_modules','dist'].includes(entry.name))throw Error('Unexpected fixture path');
  if(entry.isDirectory())await walk(path);else paths.push(path);
 }
}
await walk();
const records=[];let bytes=0;
await mkdir(destination,{recursive:false,mode:0o700});
for(const path of paths.sort()){
 const content=await readFile(join(root,path));bytes+=content.length;
 if(bytes>4*1024*1024||records.length>=1000)throw Error('Fixture exceeds snapshot limits');
 await mkdir(dirname(join(destination,path)),{recursive:true});await cp(join(root,path),join(destination,path));
 records.push({path,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
}
const manifest={version:1,source:'carbon-linux-fixture',sourceSnapshot:'08534edd2d6174e5cd9aaf97eb8c3a20697e86067ae58874f3a0763ce9cc86c2',files:records,totalBytes:bytes};
await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({directory:destination,totalBytes:bytes,files:records.length,manifestSha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}));
