"""Independent termination guard. Never logs events, credentials or ownership tags."""
import hashlib
import json
import os
import re
import time
from datetime import datetime

FIELDS = ('accountId','region','workloadId','actionId','ownershipToken','clientToken','parametersHash','expiresAt','maxExposureMicros','configurationHash')
HASH = re.compile(r'^[a-f0-9]{64}$')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def require(condition):
    if not condition:
        raise ValueError('Guard unavailable')

def identity(manifest, group_arn):
    require(isinstance(manifest,dict) and set(manifest)=={'schemaVersion','ownershipMode','registryTableArn','guardArn','validUntil','profiles'} and manifest['schemaVersion']==1 and manifest['ownershipMode']=='broker_uuid_registry_v1')
    match=re.fullmatch(r'arn:aws:events:ap-northeast-2:(\d{12}):rule/[A-Za-z0-9_-]{1,64}',manifest['guardArn'])
    require(match is not None)
    account=match.group(1)
    require(re.fullmatch(r'arn:aws:dynamodb:ap-northeast-2:'+account+r':table/[A-Za-z0-9_-]{3,255}',manifest['registryTableArn']) is not None)
    require(re.fullmatch(r'arn:aws:scheduler:ap-northeast-2:'+account+r':schedule-group/[A-Za-z0-9_-]{1,64}',group_arn) is not None)
    require(isinstance(manifest['profiles'],list) and 0<len(manifest['profiles'])<=16)
    return account,group_arn.replace(':schedule-group/',':schedule/')+'/'

def request_profile(request, manifest, account):
    require(isinstance(request,dict) and set(request)==set(FIELDS))
    require(request['accountId']==account and request['region']=='ap-northeast-2' and isinstance(request['actionId'],str) and 0<len(request['actionId'])<=256)
    require(isinstance(request['ownershipToken'],str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',request['ownershipToken']))
    require(isinstance(request['clientToken'],str) and HASH.fullmatch(request['clientToken']) and isinstance(request['parametersHash'],str) and HASH.fullmatch(request['parametersHash']))
    profiles=[p for p in manifest['profiles'] if p['workloadId']==request['workloadId'] and p['configurationHash']==request['configurationHash'] and p['parameterPolicy']=='opaque_broker_sha256']
    require(len(profiles)==1)
    p=profiles[0]
    require(isinstance(request['expiresAt'],int) and not isinstance(request['expiresAt'],bool) and 0<request['expiresAt']<=min(manifest['validUntil'],p['quote']['validUntil']) and request['maxExposureMicros']==p['quote']['maxExposureMicros'])
    return p

def binding(registry, owner, manifest, account, prefix):
    if not isinstance(owner,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',owner): return None
    item=registry.get_item(TableName=manifest['registryTableArn'].split('/')[-1],Key={'owner':{'S':owner}},ConsistentRead=True).get('Item')
    if not item: return None
    require(set(item)=={'owner','schemaVersion','configurationDigest','bindingHash','requestJson','timerArn'} and item['owner']=={'S':owner} and item['schemaVersion']=={'N':'1'} and item['configurationDigest']=={'S':hashlib.sha256(canonical(manifest).encode()).hexdigest()})
    r=json.loads(item['requestJson']['S']); profile=request_profile(r,manifest,account)
    require(r['ownershipToken']==owner and item['requestJson']['S']==canonical(r))
    digest=hashlib.sha256(json.dumps({key:r[key] for key in FIELDS},separators=(',', ':'),ensure_ascii=False).encode()).hexdigest()
    require(item['bindingHash']=={'S':digest} and item['timerArn']=={'S':prefix+'hm-'+digest[:48]})
    return r,profile,item['timerArn']['S']

def resource_tags(value):
    tags={}
    rows=value.get('Tags')
    if not isinstance(rows,list): return None
    for row in rows:
        if not isinstance(row,dict) or not isinstance(row.get('Key'),str) or not isinstance(row.get('Value'),str) or row['Key'] in tags: return None
        tags[row['Key']]=row['Value']
    return tags

def owned_tags(value, profile, manifest, account, prefix, registry):
    tags=resource_tags(value)
    if tags is None or tags.get('hivemind:guard')!=manifest['guardArn'] or tags.get('hivemind:workload')!=profile['workloadId']: return None
    owned=binding(registry,tags.get('hivemind:owner'),manifest,account,prefix)
    if owned is None or owned[1]!=profile: return None
    r=owned[0]
    expected={'hivemind:owner':r['ownershipToken'],'hivemind:request':r['clientToken'],'hivemind:parameters':r['parametersHash'],'hivemind:workload':r['workloadId'],'hivemind:expires':str(r['expiresAt']),'hivemind:guard':manifest['guardArn'],'hivemind:timer':owned[2]}
    if any(tags.get(key)!=value for key,value in expected.items()): return None
    return owned

def owned_instance_absent(ec2, request, profile, manifest, account, prefix, registry, now_ms):
    # No state filter: shutting-down/active/unknown states must not be mistaken for absence.
    filters=[{'Name':'tag:hivemind:owner','Values':[request['ownershipToken']]},{'Name':'client-token','Values':[request['clientToken']]}]
    token=None;seen=set();count=0
    for _ in range(100):
        query={'Filters':filters,'MaxResults':100}
        if token is not None:query['NextToken']=token
        page=ec2.describe_instances(**query)
        require(isinstance(page,dict) and isinstance(page.get('Reservations'),list))
        for reservation in page['Reservations']:
            if reservation.get('OwnerId')!=account:return False
            require(isinstance(reservation.get('Instances'),list))
            for instance in reservation['Instances']:
                count+=1
                if count>1:return False
                owned=owned_tags(instance,profile,manifest,account,prefix,registry)
                if owned is None or owned[0]!=request or instance.get('ClientToken')!=request['clientToken']:return False
                if instance.get('IamInstanceProfile',{}).get('Arn')!=profile['instanceProfileArn'] or not re.fullmatch(r'ap-northeast-2[a-z]',instance.get('Placement',{}).get('AvailabilityZone','')):return False
                launch=instance.get('LaunchTime')
                if not isinstance(launch,datetime) or launch.tzinfo is None or int(launch.timestamp()*1000)>now_ms+profile['launchHeadroomMs'] or request['expiresAt']-int(launch.timestamp()*1000)>profile['maxLifetimeMs']+profile['launchHeadroomMs']:return False
                if instance.get('State',{}).get('Name')!='terminated':return False
        token=page.get('NextToken')
        if token is None:return True
        require(isinstance(token,str) and 0<len(token)<=2048 and token not in seen);seen.add(token)
    raise ValueError('Guard unavailable')

def deletable_volume(volume, profile, manifest, account, prefix, registry, now_ms, timer_request):
    if not isinstance(volume,dict):return None
    identifier=volume.get('VolumeId')
    if not isinstance(identifier,str) or not re.fullmatch(r'vol-(?:[a-f0-9]{8}|[a-f0-9]{17})',identifier):return None
    if volume.get('State')!='available' or volume.get('Attachments')!=[]:return None
    if volume.get('OwnerId',account)!=account or not re.fullmatch(r'ap-northeast-2[a-z]',volume.get('AvailabilityZone','')):return None
    owned=owned_tags(volume,profile,manifest,account,prefix,registry)
    if owned is None or timer_request is not None and owned[0]!=timer_request:return None
    request=owned[0];created=volume.get('CreateTime')
    if not isinstance(created,datetime) or created.tzinfo is None:return None
    created_at=int(created.timestamp()*1000)
    if created_at>now_ms+profile['launchHeadroomMs'] or now_ms<request['expiresAt'] or request['expiresAt']-created_at>profile['maxLifetimeMs']+profile['launchHeadroomMs']:return None
    return request

def sweep_volumes(ec2, profile, manifest, account, prefix, registry, now_ms, timer_request, requested, budget):
    filters=[{'Name':'tag:hivemind:guard','Values':[manifest['guardArn']]},{'Name':'tag:hivemind:workload','Values':[profile['workloadId']]}]
    if timer_request is not None:
        filters += [{'Name':'tag:hivemind:owner','Values':[timer_request['ownershipToken']]},{'Name':'tag:hivemind:request','Values':[timer_request['clientToken']]},{'Name':'tag:hivemind:parameters','Values':[timer_request['parametersHash']]}]
    token=None;seen=set()
    for _ in range(100):
        query={'Filters':filters,'MaxResults':100}
        if token is not None:query['NextToken']=token
        page=ec2.describe_volumes(**query)
        require(isinstance(page,dict) and isinstance(page.get('Volumes'),list))
        for volume in page['Volumes']:
            budget['count']+=1;require(budget['count']<=10000)
            request=deletable_volume(volume,profile,manifest,account,prefix,registry,now_ms,timer_request)
            if request is None or volume['VolumeId'] in requested:continue
            if not owned_instance_absent(ec2,request,profile,manifest,account,prefix,registry,now_ms):continue
            # Revalidate immediately before DeleteVolume; AWS also rejects attachment races.
            fresh=ec2.describe_volumes(VolumeIds=[volume['VolumeId']])
            require(isinstance(fresh,dict) and isinstance(fresh.get('Volumes'),list))
            if len(fresh['Volumes'])!=1 or fresh['Volumes'][0].get('VolumeId')!=volume['VolumeId']:continue
            if deletable_volume(fresh['Volumes'][0],profile,manifest,account,prefix,registry,now_ms,timer_request)!=request:continue
            ec2.delete_volume(VolumeId=volume['VolumeId'])
            requested.add(volume['VolumeId'])
        token=page.get('NextToken')
        if token is None:return
        require(isinstance(token,str) and 0<len(token)<=2048 and token not in seen);seen.add(token)
    raise ValueError('Guard unavailable')

def enforce(event, manifest, group_arn, ec2, now_ms, registry):
    account,prefix=identity(manifest,group_arn)
    require(isinstance(now_ms,int) and now_ms>=0 and isinstance(event,dict))
    common={'schemaVersion','kind','guardArn','configurationDigest'}
    timer=event.get('kind')=='timer'
    require(set(event)==common|({'timerArn','request'} if timer else set()) and event.get('kind') in ('periodic','timer') and event['schemaVersion']==1 and event['guardArn']==manifest['guardArn'])
    require(event['configurationDigest']==hashlib.sha256(canonical(manifest).encode()).hexdigest())
    profiles=manifest['profiles']
    if timer:
        r=event['request']; profiles=[request_profile(r,manifest,account)]
        request_bytes=json.dumps({key:r[key] for key in FIELDS},separators=(',', ':'),ensure_ascii=False)
        expected=prefix+'hm-'+hashlib.sha256(request_bytes.encode()).hexdigest()[:48]
        require(event['timerArn']==expected)
        owned=binding(registry,r['ownershipToken'],manifest,account,prefix)
        require(owned is not None and owned[0]==r and owned[2]==event['timerArn'])
        if now_ms<r['expiresAt']:
            return {'terminationRequests':0,'volumeDeletionRequests':0,'early':True}
    terminated=set(); inspected=0; volume_requests=set(); volume_budget={'count':0}
    for p in profiles:
        filters=[{'Name':'tag:hivemind:guard','Values':[manifest['guardArn']]},{'Name':'tag:hivemind:workload','Values':[p['workloadId']]},{'Name':'instance-state-name','Values':['pending','running','stopping','stopped']}]
        if timer:
            filters += [{'Name':'tag:hivemind:request','Values':[r['clientToken']]},{'Name':'tag:hivemind:parameters','Values':[r['parametersHash']]},{'Name':'tag:hivemind:timer','Values':[event['timerArn']]}]
        token=None; seen=set()
        for _ in range(100):
            query={'Filters':filters,'MaxResults':100}
            if token is not None: query['NextToken']=token
            page=ec2.describe_instances(**query)
            require(isinstance(page,dict) and isinstance(page.get('Reservations',[]),list))
            for reservation in page.get('Reservations',[]):
                if reservation.get('OwnerId')!=account: continue
                require(isinstance(reservation.get('Instances',[]),list))
                for instance in reservation.get('Instances',[]):
                    inspected+=1; require(inspected<=10000)
                    tags={}; duplicate=False
                    for tag in instance.get('Tags',[]):
                        if tag.get('Key') in tags: duplicate=True
                        tags[tag.get('Key')]=tag.get('Value')
                    if duplicate or tags.get('hivemind:guard')!=manifest['guardArn'] or tags.get('hivemind:workload')!=p['workloadId']:
                        continue
                    owned=binding(registry,tags.get('hivemind:owner'),manifest,account,prefix)
                    if owned is None or owned[1]!=p: continue
                    bound=owned[0]
                    if tags.get('hivemind:request')!=bound['clientToken'] or tags.get('hivemind:parameters')!=bound['parametersHash'] or tags.get('hivemind:timer')!=owned[2] or tags.get('hivemind:expires')!=str(bound['expiresAt']): continue
                    if instance.get('IamInstanceProfile',{}).get('Arn')!=p['instanceProfileArn'] or not re.fullmatch(r'ap-northeast-2[a-z]',instance.get('Placement',{}).get('AvailabilityZone','')): continue
                    client=tags.get('hivemind:request',''); parameters=tags.get('hivemind:parameters',''); timer_tag=tags.get('hivemind:timer',''); expiry=tags.get('hivemind:expires','')
                    if not isinstance(client,str) or not HASH.fullmatch(client) or not isinstance(parameters,str) or not HASH.fullmatch(parameters) or not isinstance(timer_tag,str) or not re.fullmatch(re.escape(prefix)+r'hm-[a-f0-9]{48}',timer_tag) or not isinstance(expiry,str) or not re.fullmatch(r'[1-9][0-9]{0,15}',expiry):
                        continue
                    expires=int(expiry)
                    launch=instance.get('LaunchTime')
                    if not isinstance(launch,datetime) or launch.tzinfo is None or int(launch.timestamp()*1000)>now_ms+p['launchHeadroomMs']: continue
                    if expires>min(manifest['validUntil'],p['quote']['validUntil'],int(launch.timestamp()*1000)+p['maxLifetimeMs']+p['launchHeadroomMs']) or now_ms<expires:
                        continue
                    if timer and (client!=r['clientToken'] or parameters!=r['parametersHash'] or expires!=r['expiresAt'] or timer_tag!=event['timerArn']): continue
                    instance_id=instance.get('InstanceId','')
                    if not isinstance(instance_id,str) or not re.fullmatch(r'i-(?:[a-f0-9]{8}|[a-f0-9]{17})',instance_id) or instance_id in terminated or instance.get('State',{}).get('Name') not in ('pending','running','stopping','stopped'):
                        continue
                    ec2.terminate_instances(InstanceIds=[instance_id])
                    terminated.add(instance_id)
            next_token=page.get('NextToken')
            if next_token is None: break
            require(isinstance(next_token,str) and 0<len(next_token)<=2048 and next_token not in seen)
            seen.add(next_token);token=next_token
        else:
            raise ValueError('Guard unavailable')
        sweep_volumes(ec2,p,manifest,account,prefix,registry,now_ms,r if timer else None,volume_requests,volume_budget)
    return {'terminationRequests':len(terminated),'volumeDeletionRequests':len(volume_requests)}

def handler(event, context):
    # Client creation is lazy; all provider exceptions are sanitized before Lambda logs them.
    try:
        import boto3
        from botocore.config import Config
        manifest=json.loads(os.environ['HIVEMIND_GUARD_MANIFEST'])
        require(os.environ.get('HIVEMIND_GUARD_SCHEMA')=='1' and os.environ.get('HIVEMIND_GUARD_DIGEST')==hashlib.sha256(canonical(manifest).encode()).hexdigest())
        ec2=boto3.client('ec2',region_name='ap-northeast-2',config=Config(connect_timeout=3,read_timeout=5,retries={'max_attempts':3}))
        registry=boto3.client('dynamodb',region_name='ap-northeast-2',config=Config(connect_timeout=3,read_timeout=5,retries={'max_attempts':3}))
        return enforce(event,manifest,os.environ['HIVEMIND_GUARD_SCHEDULE_GROUP_ARN'],ec2,int(time.time()*1000),registry)
    except Exception:
        raise ValueError('Guard unavailable') from None
