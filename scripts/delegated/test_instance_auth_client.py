from datetime import datetime, timezone
import unittest
from unittest.mock import patch
from instance_auth_client import sign_instance_challenge

class InstanceSigningTests(unittest.TestCase):
    def test_official_botocore_signs_fixed_identity_request_and_bound_key(self):
        challenge={"nonce":"n"*43,"audience":"central","purpose":"bootstrap","keyThumbprint":"k"*43}
        credentials={"accessKeyId":"ASIA123456789EXAMPLE","secretAccessKey":"s"*40,"sessionToken":"private-temporary-session"}
        with patch('botocore.auth.get_current_datetime',return_value=datetime(2026,11,23,1,0,0,tzinfo=timezone.utc)):
            request=sign_instance_challenge(challenge,"us-east-2",credentials)
        self.assertEqual(request["url"],"https://sts.us-east-2.amazonaws.com/")
        self.assertEqual(request["method"],"POST")
        self.assertEqual(request["body"],"Action=GetCallerIdentity&Version=2011-06-15")
        header=request["headers"]
        self.assertEqual(header["x-hivemind-key-thumbprint"],challenge["keyThumbprint"])
        self.assertEqual(header["x-amz-date"],"20261123T010000Z")
        self.assertIn("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-hivemind-audience;x-hivemind-key-thumbprint;x-hivemind-nonce;x-hivemind-purpose",header["authorization"])
        self.assertNotIn(credentials["secretAccessKey"],str(request))

if __name__=='__main__':
    unittest.main()
