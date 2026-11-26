import json
import unittest
from unittest.mock import patch
from imds_locator import discover_instance_locator,discover_and_sign_bootstrap

TAGS={'task':'task-1','revision':'2','profile':'train-profile','descriptor':'d'*64,'input':'e'*64}
ID='i-0123456789abcdef0'
class LocatorTests(unittest.TestCase):
    def fixture(self,alter=None):
        calls=[]
        def request(method,path,headers,timeout):
            calls.append((method,path,dict(headers)))
            if path=='/latest/api/token':
                self.assertEqual(method,'PUT');self.assertEqual(headers,{'X-aws-ec2-metadata-token-ttl-seconds':'60'});return 200,b'private_imds_token'
            self.assertEqual(method,'GET');self.assertEqual(headers,{'X-aws-ec2-metadata-token':'private_imds_token'})
            if path=='/latest/meta-data/instance-id':body=ID
            elif path=='/latest/dynamic/instance-identity/document':body=json.dumps({'accountId':'123456789012','region':'us-east-2','instanceId':ID})
            else:body=TAGS[path.rsplit(':',1)[1]]
            return alter(path,body) if alter else (200,body.encode())
        return request,calls
    def test_fixed_imdsv2_locator_never_exposes_token_or_treats_iid_as_auth(self):
        request,calls=self.fixture();locator=discover_instance_locator(request=request)
        self.assertEqual(locator,{'taskId':'task-1','revision':2,'profileId':'train-profile','descriptorHash':'d'*64,'inputManifestDigest':'e'*64,'instanceId':ID,'accountId':'123456789012','region':'us-east-2'})
        self.assertEqual(len(calls),8);self.assertNotIn('private_imds_token',str(locator))
    def test_redirect_and_invalid_tag_never_become_locator(self):
        for alter in [lambda p,b:(302,b'attacker'),lambda p,b:(200,b'../evil') if p.endswith(':task') else (200,b.encode()),lambda p,b:(200,b'x'*16385),lambda p,b:(200,b'0') if p.endswith(':revision') else (200,b.encode())]:
            request,calls=self.fixture(alter)
            with self.assertRaisesRegex(ValueError,'instance discovery unavailable'):discover_instance_locator(request=request)
            self.assertLessEqual(len(calls),8)
    def test_discovery_calls_private_challenge_then_official_signer_for_bootstrap(self):
        request,calls=self.fixture();seen=[]
        def challenge(locator,purpose,thumbprint):
            seen.append((locator,purpose,thumbprint));return {'id':'challenge','nonce':'n'*43,'audience':'central','purpose':purpose,'keyThumbprint':thumbprint}
        result=discover_and_sign_bootstrap(challenge_for_locator=challenge,credentials={'accessKeyId':'ASIA123456789EXAMPLE','secretAccessKey':'s'*40,'sessionToken':'session'},key_thumbprint='k'*43,request=request)
        self.assertEqual(result['challengeId'],'challenge');self.assertEqual(seen[0][1:],('bootstrap','k'*43))
        self.assertEqual(result['request']['url'],'https://sts.us-east-2.amazonaws.com/');self.assertNotIn('s'*40,str(result));self.assertNotIn('private_imds_token',str(result))

    def test_default_transport_uses_fixed_host_without_proxy_or_redirect_following(self):
        request,calls=self.fixture();hosts=[]
        class Connection:
            sock=None
            def __init__(self,host,timeout):hosts.append(host);self.timeout=timeout
            def request(self,method,path,headers):self.reply=request(method,path,headers,self.timeout)
            def getresponse(self):
                code,body=self.reply
                class Reply:
                    status=code
                    def read1(self,size):
                        nonlocal body
                        result=body[:size];body=body[size:];return result
                return Reply()
            def close(self):pass
        with patch('http.client.HTTPConnection',Connection),patch.dict('os.environ',{'HTTP_PROXY':'http://attacker.example','AWS_EC2_METADATA_SERVICE_ENDPOINT':'http://attacker.example'}):
            self.assertEqual(discover_instance_locator()['instanceId'],ID)
        self.assertEqual(hosts,['169.254.169.254']*8)

    def test_token_failure_does_not_fall_back_to_imdsv1(self):
        calls=[]
        def denied(method,path,headers,timeout):calls.append((method,path));return 401,b'denied'
        with self.assertRaisesRegex(ValueError,'instance discovery unavailable'):discover_instance_locator(request=denied)
        self.assertEqual(calls,[('PUT','/latest/api/token')])
