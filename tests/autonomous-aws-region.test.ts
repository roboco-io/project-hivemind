import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAwsRegion,awsPlacement,assertAwsPlacement} from '../packages/adapters/src/autonomous-aws-region.js';
test('server region allowlist defaults to Seoul, never guesses another region',()=>{
 assertAwsRegion('ap-northeast-2');assert.throws(()=>assertAwsRegion('us-east-2'));assertAwsRegion('us-east-2',['us-east-2']);
 for(const list of [[],['us-east-2','us-east-2'],['us-east-2','bad.*']])assert.throws(()=>assertAwsRegion('us-east-2',list));
});
test('AZ ID placement requires observed region and exact approved physical zone',()=>{
 assert.deepEqual(awsPlacement('us-east-2','use2-az2'),{AvailabilityZoneId:'use2-az2'});assert.deepEqual(awsPlacement('ap-northeast-2'),{});
 assertAwsPlacement('us-east-2',{availabilityZone:'us-east-2b',availabilityZoneId:'use2-az2'},'use2-az2');
 for(const p of [{availabilityZone:'ap-northeast-2a',availabilityZoneId:'use2-az2'},{availabilityZone:'us-east-2b'},{availabilityZone:'us-east-2b',availabilityZoneId:'use2-az1'},{}])assert.throws(()=>assertAwsPlacement('us-east-2',p,'use2-az2'));
 assert.throws(()=>awsPlacement('us-east-2','apne2-az1'));assert.throws(()=>awsPlacement('us-west-2','use2-az2'));
});
