import {command,fixtureRoot} from './fixture-runtime.mjs';
const stages=[];
for(const args of [['acceptance.mjs','all'],['run-shard.mjs','all']]){
 const result=await command([process.execPath,...args],fixtureRoot,process.env,600000);
 let evidence;
 try{evidence=JSON.parse(result.out.trim().split('\n').at(-1))}catch{}
 const passed=result.code===0&&evidence?.passed===true;
 stages.push({command:args,passed,ms:result.ms,evidence});
 if(!passed){console.log(JSON.stringify({passed:false,stages}));process.exitCode=1;break;}
}
if(stages.length===2&&stages.every(stage=>stage.passed))console.log(JSON.stringify({passed:true,stages}));
