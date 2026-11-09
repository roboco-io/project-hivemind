import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessClaudeBoundary} from '../scripts/phase0/claude-boundary-probe.ts';
test('nested compatibility boundary requires process, files and credential restrictions together',()=>{
 const report={uid:1000,toolUid:1000,exitCode:0,timedOut:false,captureLimit:false,guardAbi:3,guardApplied:true,pidNamespaceDifferent:true,parentReadlinksDenied:true,threadAliasesDenied:true,siblingAliasesDenied:true,privateHardlinkDenied:true,devNullWritable:true,ignoredSpawnWorks:true,noNewPrivileges:'1',capabilities:{CapInh:'0000',CapEff:'0000',CapPrm:'0000',CapAmb:'0000',CapBnd:'0000'},workspaceWrite:true,outsideWriteDenied:true,privateReadDenied:true,runtimeInputReadDenied:true,procReadDenied:true,parentEnvironmentDenied:true,parentProcessInfoDenied:true,parentRootAliasDenied:true,parentMemoryDenied:true,fixtureCredentialAbsent:true,managementCredentialsAbsent:true,networkDenied:true};
 assert.equal(assessClaudeBoundary(report).passed,true);
 for(const k of ['parentProcessInfoDenied','parentRootAliasDenied','parentMemoryDenied','parentEnvironmentDenied','fixtureCredentialAbsent','outsideWriteDenied','networkDenied'])assert.equal(assessClaudeBoundary({...report,[k]:false}).passed,false);
 assert.equal(assessClaudeBoundary({...report,capabilities:{CapEff:'0001'}}).passed,false);
 assert.equal(assessClaudeBoundary({...report,capabilities:{}}).passed,false);
 assert.equal(assessClaudeBoundary({...report,exitCode:1}).passed,false);
 assert.equal(assessClaudeBoundary({...report,toolUid:0}).passed,false);
});
