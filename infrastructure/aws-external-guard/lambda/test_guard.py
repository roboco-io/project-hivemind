import unittest
from datetime import datetime, timezone
import hashlib
import json
import guard
import types
from unittest.mock import patch
ACCOUNT = '111111111111'  # FIXTURE only. No boto3 auth/network discovery.
ARN = f'arn:aws:events:ap-northeast-2:{ACCOUNT}:rule/fixture-hivemind'
GROUP = f'arn:aws:scheduler:ap-northeast-2:{ACCOUNT}:schedule-group/fixture-hivemind'
NOW = 1795132800000
REQUEST = dict(accountId=ACCOUNT, region='ap-northeast-2', workloadId='fixture-workload', actionId='fixture-action', ownershipToken='12345678-1234-4234-8234-123456789abc', clientToken='a'*64, parametersHash='b'*64, expiresAt=NOW, maxExposureMicros=100, configurationHash='c'*64)
def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def manifest():
    return dict(schemaVersion=1, ownershipMode='broker_uuid_registry_v1',registryTableArn=f'arn:aws:dynamodb:ap-northeast-2:{ACCOUNT}:table/fixture-hivemind-bindings',guardArn=ARN, validUntil=NOW+86400000, profiles=[dict(workloadId='fixture-workload', configurationHash='c'*64,parameterPolicy='opaque_broker_sha256',launchHeadroomMs=30000, instanceProfileArn=f'arn:aws:iam::{ACCOUNT}:instance-profile/fixture-workload', maxLifetimeMs=3600000, quote=dict(source='SYNTHETIC user quote', maxExposureMicros=100, validUntil=NOW+86400000))])
def timer_arn():
    digest = hashlib.sha256(json.dumps(REQUEST,separators=(',', ':')).encode()).hexdigest()
    return GROUP.replace(':schedule-group/', ':schedule/') + '/hm-' + digest[:48]
def event(kind='periodic'):
    result = dict(schemaVersion=1, kind=kind, guardArn=ARN, configurationDigest=hashlib.sha256(canonical(manifest()).encode()).hexdigest())
    if kind == 'timer': result.update(timerArn=timer_arn(), request=REQUEST.copy())
    return result

def instance(expiry=NOW, **changes):
    tags = {'hivemind:owner':REQUEST['ownershipToken'],'hivemind:request':'a'*64,'hivemind:parameters':'b'*64,'hivemind:workload':'fixture-workload','hivemind:expires':str(expiry),'hivemind:guard':ARN,'hivemind:timer':timer_arn()}
    tags.update(changes)
    return {'InstanceId':'i-0123456789abcdef0','ClientToken':REQUEST['clientToken'],'State':{'Name':'running'},'IamInstanceProfile':{'Arn':manifest()['profiles'][0]['instanceProfileArn']},'Placement':{'AvailabilityZone':'ap-northeast-2a'},'LaunchTime':datetime.fromtimestamp((NOW-60000)/1000,timezone.utc),'Tags':[{'Key':k,'Value':v} for k,v in tags.items()]}
class FakeEc2:
    def __init__(self, pages, volume_pages=None): self.pages=pages; self.queries=[]; self.terminated=[]; self.volume_pages=volume_pages or [{'Volumes':[]}]; self.volume_queries=[]; self.deleted=[]; self.volume_readback=None
    def describe_instances(self, **kwargs):
        self.queries.append(kwargs)
        return self.pages[int(kwargs.get('NextToken','0'))]
    def terminate_instances(self, **kwargs): self.terminated.append(kwargs['InstanceIds']); return {}
    def describe_volumes(self, **kwargs):
        self.volume_queries.append(kwargs)
        if 'VolumeIds' in kwargs:
            rows=[v for page in self.volume_pages for v in page.get('Volumes',[]) if v['VolumeId'] in kwargs['VolumeIds']]
            return {'Volumes':self.volume_readback if self.volume_readback is not None else rows}
        return self.volume_pages[int(kwargs.get('NextToken','0'))]
    def delete_volume(self, **kwargs): self.deleted.append(kwargs); return {}

def page(*instances, token=None):
    value={'Reservations':[{'OwnerId':ACCOUNT,'Instances':list(instances)}]}
    if token is not None: value['NextToken']=token
    return value
class FakeRegistry:
    def get_item(self, **kwargs):
        r=REQUEST
        if kwargs['Key']['owner']['S']!=r['ownershipToken']: return {}
        digest=hashlib.sha256(json.dumps(r,separators=(',', ':')).encode()).hexdigest()
        return {'Item':{'owner':{'S':r['ownershipToken']},'schemaVersion':{'N':'1'},'configurationDigest':{'S':hashlib.sha256(canonical(manifest()).encode()).hexdigest()},'bindingHash':{'S':digest},'requestJson':{'S':canonical(r)},'timerArn':{'S':timer_arn()}}}
def run_guard(event, config, group, ec2, now):
    return guard.enforce(event,config,group,ec2,now,FakeRegistry())
def volume(**changes):
    value={'VolumeId':'vol-0123456789abcdef0','State':'available','Attachments':[], 'AvailabilityZone':'ap-northeast-2a','CreateTime':datetime.fromtimestamp((NOW-60000)/1000,timezone.utc),'Tags':instance()['Tags']}
    value.update(changes)
    return value
class GuardTests(unittest.TestCase):
    def test_owned_expired_instance_is_terminated(self):
        ec2=FakeEc2([page(instance())]); result=run_guard(event(),manifest(),GROUP,ec2,NOW)
        self.assertEqual(ec2.terminated,[['i-0123456789abcdef0']]); self.assertEqual(result['terminationRequests'],1)
    def test_private_ownership_and_profile_filters(self):
        for key,value in [('hivemind:owner','other'),('hivemind:parameters','d'*64),('hivemind:guard','other'),('hivemind:request','bad'),('hivemind:timer','arn:aws:scheduler:ap-northeast-2:222222222222:schedule/evil/x')]:
            ec2=FakeEc2([page(instance(**{key:value}))]); run_guard(event(),manifest(),GROUP,ec2,NOW); self.assertEqual(ec2.terminated,[])
    def test_pagination_late_create_and_early_skip(self):
        late=instance(); late['InstanceId']='i-abcdef01234567890'; late['LaunchTime']=datetime.fromtimestamp((NOW+1000)/1000,timezone.utc)
        ec2=FakeEc2([page(instance(NOW+1000),token='1'),page(late)])
        run_guard(event(),manifest(),GROUP,ec2,NOW+1000); self.assertEqual(len(ec2.queries),2); self.assertEqual(len(ec2.terminated),1)
        early=FakeEc2([page(instance(NOW+1000))]); run_guard(event(),manifest(),GROUP,early,NOW); self.assertEqual(early.terminated,[])
    def test_expired_timer_and_periodic_after_timer_missed_creation(self):
        absent=FakeEc2([page()]); run_guard(event('timer'),manifest(),GROUP,absent,NOW); self.assertEqual(absent.terminated,[])
        late=FakeEc2([page(instance())]); run_guard(event(),manifest(),GROUP,late,NOW+60000); self.assertEqual(len(late.terminated),1)
    def test_bad_timer_and_configuration_fail_before_describe(self):
        for change in [dict(configurationDigest='0'*64),dict(timerArn=timer_arn()+'bad'),dict(guardArn=ARN+'bad')]:
            ec2=FakeEc2([page(instance())]); e=event('timer');e.update(change)
            with self.assertRaises(ValueError): run_guard(e,manifest(),GROUP,ec2,NOW)
            self.assertEqual(ec2.queries,[])
    def test_early_timer_and_cancelled_resource_are_idempotent(self):
        ec2=FakeEc2([page(instance())]); run_guard(event('timer'),manifest(),GROUP,ec2,NOW-1); self.assertEqual(ec2.queries,[])
        gone=FakeEc2([page()]); run_guard(event('timer'),manifest(),GROUP,gone,NOW+1); self.assertEqual(gone.terminated,[])
    def test_production_handler_uses_only_fake_boto3_and_fixed_region(self):
        ec2=FakeEc2([page(instance())]); calls=[]
        boto=types.ModuleType('boto3'); boto.client=lambda *args,**kwargs: (calls.append((args,kwargs)) or (ec2 if args[0]=='ec2' else FakeRegistry()))
        botocore=types.ModuleType('botocore'); settings=types.ModuleType('botocore.config'); settings.Config=lambda **kwargs:kwargs
        env={'HIVEMIND_GUARD_SCHEMA':'1','HIVEMIND_GUARD_MANIFEST':canonical(manifest()),'HIVEMIND_GUARD_DIGEST':hashlib.sha256(canonical(manifest()).encode()).hexdigest(),'HIVEMIND_GUARD_SCHEDULE_GROUP_ARN':GROUP}
        with patch.dict('sys.modules',{'boto3':boto,'botocore':botocore,'botocore.config':settings}), patch.dict('os.environ',env,clear=True), patch.object(guard.time,'time',return_value=NOW/1000):
            self.assertEqual(guard.handler(event(),None)['terminationRequests'],1)
        self.assertEqual(calls[0][0],('ec2',)); self.assertEqual(calls[0][1]['region_name'],'ap-northeast-2')
    def test_role_boundary_tags_and_ttl_bounds_are_independently_checked(self):
        ec2=FakeEc2([page(instance(NOW+7200000))]); run_guard(event(),manifest(),GROUP,ec2,NOW+7200000); self.assertEqual(ec2.terminated,[])
        filters=ec2.queries[0]['Filters']; self.assertIn({'Name':'tag:hivemind:guard','Values':[ARN]},filters)
        missing=instance(); missing['Tags']=[t for t in missing['Tags'] if t['Key']!='hivemind:timer']
        ec2=FakeEc2([page(missing)]); run_guard(event(),manifest(),GROUP,ec2,NOW); self.assertEqual(ec2.terminated,[])
    def test_actual_instance_profile_account_region_and_launch_bounds_are_mandatory(self):
        variants=[]
        wrong_profile=instance(); wrong_profile['IamInstanceProfile']['Arn']='arn:aws:iam::111111111111:instance-profile/other'; variants.append(page(wrong_profile))
        wrong_zone=instance(); wrong_zone['Placement']['AvailabilityZone']='us-east-1a'; variants.append(page(wrong_zone))
        wrong_account=page(instance()); wrong_account['Reservations'][0]['OwnerId']='222222222222'; variants.append(wrong_account)
        old=instance(); old['LaunchTime']=datetime.fromtimestamp((NOW-7200000)/1000,timezone.utc); variants.append(page(old))
        for value in variants:
            ec2=FakeEc2([value]); run_guard(event(),manifest(),GROUP,ec2,NOW); self.assertEqual(ec2.terminated,[])
    def test_registry_owner_request_marker_and_parameter_binding_cannot_be_forged(self):
        ec2=FakeEc2([page(instance(**{'hivemind:owner':'87654321-4321-4321-8321-cba987654321'}))]); run_guard(event(),manifest(),GROUP,ec2,NOW); self.assertEqual(ec2.terminated,[])
        for key in ['hivemind:request','hivemind:parameters']:
            ec2=FakeEc2([page(instance(**{key:'d'*64}))]); run_guard(event(),manifest(),GROUP,ec2,NOW); self.assertEqual(ec2.terminated,[])
    def test_dynamic_manifest_capability_is_required(self):
        value=manifest(); del value['ownershipMode']; ec2=FakeEc2([page(instance())])
        with self.assertRaises(ValueError): run_guard(event(),value,GROUP,ec2,NOW)
        self.assertEqual(ec2.queries,[])
    def test_R11_owned_residual_volume_is_delete_requested_after_instance_absence(self):
        ec2=FakeEc2([page()], [{'Volumes':[volume()]}])
        result=run_guard(event(),manifest(),GROUP,ec2,NOW)
        self.assertEqual(ec2.deleted,[{'VolumeId':'vol-0123456789abcdef0'}])
        self.assertEqual(result['volumeDeletionRequests'],1); self.assertNotIn('cleaned',result)
        self.assertEqual(ec2.volume_queries[-1],{'VolumeIds':['vol-0123456789abcdef0']})
    def test_R11_owned_terminated_instance_allows_available_volume_delete_request(self):
        i=instance();i['State']={'Name':'terminated'}
        ec2=FakeEc2([page(i)],[{'Volumes':[volume()]}]);run_guard(event(),manifest(),GROUP,ec2,NOW)
        self.assertEqual(ec2.terminated,[]);self.assertEqual(ec2.deleted,[{'VolumeId':'vol-0123456789abcdef0'}])
    def test_R11_source_instance_or_volume_creation_ttl_violation_is_not_deleted(self):
        i=instance();i['State']={'Name':'terminated'};i['LaunchTime']=datetime.fromtimestamp((NOW-7200000)/1000,timezone.utc)
        ec2=FakeEc2([page(i)],[{'Volumes':[volume()]}]);run_guard(event(),manifest(),GROUP,ec2,NOW);self.assertEqual(ec2.deleted,[])
        v=volume(CreateTime=datetime.fromtimestamp((NOW-7200000)/1000,timezone.utc))
        ec2=FakeEc2([page()],[{'Volumes':[v]}]);run_guard(event(),manifest(),GROUP,ec2,NOW);self.assertEqual(ec2.deleted,[])
    def test_R11_next_periodic_finds_volume_after_instance_has_vanished(self):
        ec2=FakeEc2([page(instance())],[{'Volumes':[volume()]}])
        run_guard(event(),manifest(),GROUP,ec2,NOW)
        self.assertEqual(len(ec2.terminated),1); self.assertEqual(ec2.deleted,[])
        ec2.pages=[page()]
        run_guard(event(),manifest(),GROUP,ec2,NOW+60000)
        self.assertEqual(len(ec2.deleted),1)
    def test_R11_attached_unowned_or_unbound_volume_is_never_deleted(self):
        variants=[volume(State='in-use',Attachments=[{'InstanceId':'i-abcdef01234567890'}]),volume(Attachments=[{'InstanceId':'i-abcdef01234567890'}]),volume(Attachments=None),volume(AvailabilityZone='us-east-1a')]
        for key,value in [('hivemind:owner','87654321-4321-4321-8321-cba987654321'),('hivemind:parameters','d'*64),('hivemind:request','d'*64),('hivemind:guard',ARN+'other'),('hivemind:timer',timer_arn()+'bad')]:
            v=volume(); v['Tags']=instance(**{key:value})['Tags']; variants.append(v)
        for v in variants:
            ec2=FakeEc2([page()],[{'Volumes':[v]}]);run_guard(event(),manifest(),GROUP,ec2,NOW);self.assertEqual(ec2.deleted,[])
    def test_R11_recheck_prevents_deletion_when_volume_was_reused(self):
        ec2=FakeEc2([page()],[{'Volumes':[volume()]}]);ec2.volume_readback=[volume(State='in-use',Attachments=[{'InstanceId':'i-abcdef01234567890'}])]
        run_guard(event(),manifest(),GROUP,ec2,NOW);self.assertEqual(ec2.deleted,[])
    def test_R11_timer_scope_early_ttl_and_volume_pagination(self):
        ec2=FakeEc2([page()],[{'Volumes':[],'NextToken':'1'},{'Volumes':[volume()]}]);run_guard(event('timer'),manifest(),GROUP,ec2,NOW);self.assertEqual(len(ec2.deleted),1)
        ec2=FakeEc2([page()],[{'Volumes':[volume()]}]);run_guard(event('timer'),manifest(),GROUP,ec2,NOW-1);self.assertEqual(ec2.volume_queries,[])
        loop=FakeEc2([page()],[{'Volumes':[],'NextToken':'0'}])
        with self.assertRaises(ValueError):run_guard(event(),manifest(),GROUP,loop,NOW)
    def test_R11_shutting_down_or_mismatched_instance_does_not_prove_absence(self):
        for patch in [{'State':{'Name':'shutting-down'}},{'State':{'Name':'terminated'},'IamInstanceProfile':{'Arn':'arn:aws:iam::111111111111:instance-profile/other'}}]:
            i=instance();i.update(patch);ec2=FakeEc2([page(i)],[{'Volumes':[volume()]}]);run_guard(event(),manifest(),GROUP,ec2,NOW);self.assertEqual(ec2.deleted,[])
    def test_pagination_loop_is_bounded(self):
        ec2=FakeEc2([page(token='0')])
        with self.assertRaises(ValueError): run_guard(event(),manifest(),GROUP,ec2,NOW)
        self.assertLessEqual(len(ec2.queries),2)
if __name__=='__main__': unittest.main()
