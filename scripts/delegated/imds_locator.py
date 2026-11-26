"""Trusted boot discovery only. IMDS tags/IID are locators, never central authorization."""
import http.client
import json
import re
import time

_TAGS=('task','revision','profile','descriptor','input')
_PATHS=('/latest/meta-data/instance-id','/latest/dynamic/instance-identity/document')+tuple('/latest/meta-data/tags/instance/hivemind:'+name for name in _TAGS)


def _fixed_request(method,path,headers,timeout):
    if not (method=='PUT' and path=='/latest/api/token' or method=='GET' and path in _PATHS):
        raise ValueError('instance discovery unavailable')
    # Direct connection ignores HTTP_PROXY and does not implement redirect following.
    connection=http.client.HTTPConnection('169.254.169.254',timeout=timeout)
    deadline=time.monotonic()+timeout
    try:
        connection.request(method,path,headers=headers)
        response=connection.getresponse()
        if response.status!=200:
            raise ValueError('instance discovery unavailable')
        result=bytearray()
        while True:
            left=deadline-time.monotonic()
            if left<=0:
                raise ValueError('instance discovery unavailable')
            if connection.sock is not None:
                connection.sock.settimeout(left)
            block=response.read1(4096)
            if not block:
                break
            result.extend(block)
            if len(result)>16384:
                raise ValueError('instance discovery unavailable')
        return response.status,bytes(result)
    finally:
        connection.close()


def discover_instance_locator(*,request=None):
    transport=request or _fixed_request
    deadline=time.monotonic()+5
    total=0
    def read(method,path,headers):
        nonlocal total
        remaining=deadline-time.monotonic()
        if remaining<=0:
            raise ValueError()
        status,body=transport(method,path,headers,min(2,remaining))
        if status!=200 or not isinstance(body,bytes) or len(body)>16384 or time.monotonic()>deadline:
            raise ValueError()
        total+=len(body)
        if total>32768:
            raise ValueError()
        return body.decode('utf-8')
    try:
        token=read('PUT','/latest/api/token',{'X-aws-ec2-metadata-token-ttl-seconds':'60'})
        if not re.fullmatch(r'[\x21-\x7e]{1,1024}',token):
            raise ValueError()
        headers={'X-aws-ec2-metadata-token':token}
        instance=read('GET',_PATHS[0],headers)
        identity=json.loads(read('GET',_PATHS[1],headers))
        tags={name:read('GET','/latest/meta-data/tags/instance/hivemind:'+name,headers) for name in _TAGS}
        if not re.fullmatch(r'i-[a-f0-9]{17}',instance) or identity.get('instanceId')!=instance or not re.fullmatch(r'\d{12}',identity.get('accountId','')) or not re.fullmatch(r'[a-z]{2}-[a-z]+-[0-9]+',identity.get('region','')):
            raise ValueError()
        if not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}',tags[key]) for key in ('task','profile')) or not re.fullmatch(r'[1-9][0-9]{0,15}',tags['revision']) or int(tags['revision'])>2**53-1 or not all(re.fullmatch(r'[a-f0-9]{64}',tags[key]) for key in ('descriptor','input')):
            raise ValueError()
        return {'taskId':tags['task'],'revision':int(tags['revision']),'profileId':tags['profile'],'descriptorHash':tags['descriptor'],'inputManifestDigest':tags['input'],'instanceId':instance,'accountId':identity['accountId'],'region':identity['region']}
    except Exception:
        raise ValueError('instance discovery unavailable') from None


def discover_and_sign_bootstrap(*,challenge_for_locator,credentials,key_thumbprint,request=None):
    """Return private API input only; the caller still submits publicKeyJwk to the bootstrap route."""
    try:
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}',key_thumbprint):
            raise ValueError()
        locator=discover_instance_locator(request=request)
        challenge=challenge_for_locator(dict(locator),'bootstrap',key_thumbprint)
        if challenge.get('purpose')!='bootstrap' or challenge.get('keyThumbprint')!=key_thumbprint or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',challenge.get('id','')):
            raise ValueError()
        from instance_auth_client import sign_instance_challenge
        signed=sign_instance_challenge(challenge,locator['region'],credentials)
        return {'locator':locator,'challengeId':challenge['id'],'request':signed}
    except Exception:
        raise ValueError('instance discovery unavailable') from None
