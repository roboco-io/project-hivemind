"""Private trusted bootstrap signing. The signed request is not a public receipt."""
import re


def sign_instance_challenge(challenge, region, credentials):
    try:
        if not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", region) or challenge["purpose"] not in ("bootstrap", "report", "hf-token"):
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge["nonce"]) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}", challenge["audience"]):
            raise ValueError()
        if challenge["purpose"] in ("bootstrap", "hf-token") and not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge.get("keyThumbprint", "")):
            raise ValueError()
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.credentials import Credentials
        url="https://sts."+region+".amazonaws.com/"
        headers={"host":"sts."+region+".amazonaws.com","content-type":"application/x-www-form-urlencoded",
                 "x-hivemind-audience":challenge["audience"],"x-hivemind-nonce":challenge["nonce"],"x-hivemind-purpose":challenge["purpose"]}
        if challenge.get("keyThumbprint"):
            headers["x-hivemind-key-thumbprint"]=challenge["keyThumbprint"]
        body="Action=GetCallerIdentity&Version=2011-06-15"
        request=AWSRequest(method="POST",url=url,data=body,headers=headers)
        # Explicit callback-held instance session. No SDK environment/profile fallback here.
        SigV4Auth(Credentials(credentials["accessKeyId"],credentials["secretAccessKey"],credentials["sessionToken"]),"sts",region).add_auth(request)
        return {"method":"POST","url":url,"body":body,"headers":{name.lower():value for name,value in request.headers.items()}}
    except Exception:
        raise ValueError("instance signing unavailable") from None
