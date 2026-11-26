import unittest
from unittest.mock import patch
import test_guard as f
import guard

class RegionTests(unittest.TestCase):
    def test_ohio_exact_region_zone_binding(self):
        original=f.manifest
        def ohio():
            m=original();m['guardArn']=m['guardArn'].replace('ap-northeast-2','us-east-2');m['registryTableArn']=m['registryTableArn'].replace('ap-northeast-2','us-east-2')
            m.update(region='us-east-2',allowedRegions=['us-east-2']);m['profiles'][0]['availabilityZoneId']='use2-az2';return m
        request={**f.REQUEST,'region':'us-east-2'}
        with patch.object(f,'manifest',ohio),patch.object(f,'REQUEST',request),patch.object(f,'ARN',f.ARN.replace('ap-northeast-2','us-east-2')),patch.object(f,'GROUP',f.GROUP.replace('ap-northeast-2','us-east-2')):
            for zone,id,expected in [('us-east-2b','use2-az2',1),('ap-northeast-2a','use2-az2',0),('us-east-2b','use2-az1',0),('us-east-2b',None,0)]:
                instance=f.instance();instance['Placement']={'AvailabilityZone':zone,'AvailabilityZoneId':id}
                ec2=f.FakeEc2([f.page(instance)])
                result=f.run_guard(f.event(),f.manifest(),f.GROUP,ec2,f.NOW)
                self.assertEqual(result['terminationRequests'],expected)
            for zone,id,expected in [('us-east-2b','use2-az2',1),('us-east-2b','use2-az1',0),('ap-northeast-2a','use2-az2',0)]:
                volume=f.volume(AvailabilityZone=zone,AvailabilityZoneId=id)
                ec2=f.FakeEc2([f.page()],volume_pages=[{'Volumes':[volume]}])
                self.assertEqual(f.run_guard(f.event(),f.manifest(),f.GROUP,ec2,f.NOW)['volumeDeletionRequests'],expected)
            import types
            ec2=f.FakeEc2([f.page()]);calls=[]
            boto=types.ModuleType('boto3');boto.client=lambda name,**kwargs:(calls.append((name,kwargs['region_name'])) or (ec2 if name=='ec2' else f.FakeRegistry()))
            settings=types.ModuleType('botocore.config');settings.Config=lambda **kwargs:kwargs
            env={'HIVEMIND_GUARD_SCHEMA':'1','HIVEMIND_GUARD_MANIFEST':f.canonical(ohio()),'HIVEMIND_GUARD_DIGEST':f.hashlib.sha256(f.canonical(ohio()).encode()).hexdigest(),'HIVEMIND_GUARD_SCHEDULE_GROUP_ARN':f.GROUP}
            with patch.dict('sys.modules',{'boto3':boto,'botocore':types.ModuleType('botocore'),'botocore.config':settings}),patch.dict('os.environ',env,clear=True):
                guard.handler(f.event(),None)
            self.assertEqual(calls,[('ec2','us-east-2'),('dynamodb','us-east-2')])
            m=ohio();m['allowedRegions']=['ap-northeast-2']
            with self.assertRaises(ValueError):guard.identity(m,f.GROUP)
            m=ohio();m['registryTableArn']=m['registryTableArn'].replace('us-east-2','us-west-2')
            with self.assertRaises(ValueError):guard.identity(m,f.GROUP)

    def test_foreign_client_rejected_before_reads(self):
        import types
        ec2=f.FakeEc2([f.page(f.instance())]);ec2.meta=types.SimpleNamespace(region_name='us-east-2')
        registry=f.FakeRegistry();registry.meta=types.SimpleNamespace(region_name='ap-northeast-2')
        with self.assertRaises(ValueError):guard.enforce(f.event(),f.manifest(),f.GROUP,ec2,f.NOW,registry)
        self.assertEqual(ec2.queries,[])
