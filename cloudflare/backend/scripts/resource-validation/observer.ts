import {cloudClient} from './experiment.ts';
const [id,origin,secrets]=process.argv.slice(2);
if(!id||!/^[a-zA-Z0-9_-]{1,128}$/.test(id)||!origin||!secrets)throw Error('Invalid observer arguments');
try{
 const request=await cloudClient(origin,secrets);
 console.log(JSON.stringify(await request('/v1/workflows/'+id)));
}catch{console.error('Workflow observation failed');process.exitCode=1;}
