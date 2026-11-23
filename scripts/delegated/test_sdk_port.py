import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace as Obj
import unittest
from sdk_port import LocalSdkPort

class LocalSdkTests(unittest.TestCase):
    def test_direct_streamed_s3_keeps_exact_version_and_no_credentials_in_result(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"model.bin"; path.write_bytes(b"local weights")
            item={"path":str(path),"size":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"bucket":"approved-models","key":"tasks/t/model.bin","region":"us-east-2","accountId":"123456789012"}
            class Client:
                def put_object(self,**kwargs):
                    self_outer.assertEqual(kwargs["Body"].read(),b"local weights")
                    self_outer.assertEqual(kwargs["IfNoneMatch"],"*")
                    self_outer.assertEqual(kwargs["ExpectedBucketOwner"],item["accountId"])
                    return {"VersionId":"exact-version"}
            self_outer=self
            port=LocalSdkPort(output_root=directory,s3_factory=lambda region,creds:Client())
            self.assertEqual(port.s3_upload(item,{"accessKeyId":"scoped"}),{"versionId":"exact-version"})
            item["sha256"]="0"*64
            with self.assertRaisesRegex(ValueError,"delegated SDK operation denied"):
                port.s3_upload(item,{"accessKeyId":"scoped"})

    def test_missing_empty_or_null_s3_version_cannot_produce_sdk_receipt(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"model.bin";path.write_bytes(b"weights")
            item={"path":str(path),"size":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"bucket":"approved-models","key":"tasks/t/model.bin","region":"us-east-2","accountId":"123456789012"}
            for response in [{},{"VersionId":None},{"VersionId":""},{"VersionId":"null"}]:
                with self.subTest(response=response):
                    client=Obj(put_object=lambda **kwargs:response)
                    port=LocalSdkPort(output_root=directory,s3_factory=lambda region,creds:client)
                    with self.assertRaisesRegex(ValueError,"delegated SDK operation denied"):
                        port.s3_upload(item,{"accessKeyId":"scoped"})

    def test_hf_commit_binds_parent_visibility_and_lfs_metadata(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"model.bin";path.write_bytes(b"local weights")
            token=Path(directory)/"hf-token";token.write_text("hf_private_scoped");token.chmod(0o600)
            artifact={"path":str(path),"name":"model.bin","size":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
            old="a"*40;new="b"*40;calls=[]
            class Api:
                def repo_info(self,**kwargs):
                    calls.append(kwargs)
                    if kwargs.get("files_metadata"):
                        return Obj(id="org/model",sha=new,private=True,siblings=[Obj(rfilename="model.bin",size=artifact["size"],blob_id="c"*40,lfs=Obj(sha256=artifact["sha256"],size=artifact["size"]))])
                    return Obj(id="org/model",sha=old if len(calls)==1 else new,private=True)
                def create_commit(self,**kwargs):
                    self_outer.assertEqual(kwargs["parent_commit"],old)
                    self_outer.assertEqual(kwargs["operations"][0]["path_or_fileobj"].read(),b"local weights")
                    return Obj(oid=new)
            self_outer=self
            port=LocalSdkPort(output_root=directory,hf_factory=lambda token:Api(),operation_factory=lambda **kwargs:kwargs)
            result=port.hf_commit({"repo":"org/model","visibility":"private","artifacts":[artifact],"tokenFile":str(token)})
            self.assertEqual(result["commit"],new);self.assertEqual(result["files"][0]["oid"],"c"*40)

    def test_small_git_blob_metadata_uses_git_object_hash_without_lfs_claim(self):
        with TemporaryDirectory() as directory:
            path=Path(directory)/"config.json";body=b'{"layers":2}';path.write_bytes(body)
            token=Path(directory)/"hf-token";token.write_text("hf_private_scoped");token.chmod(0o600)
            artifact={"path":str(path),"name":"config.json","size":len(body),"sha256":hashlib.sha256(body).hexdigest()}
            oid=hashlib.sha1(b"blob "+str(len(body)).encode()+b"\0"+body).hexdigest();calls=[]
            class Api:
                def repo_info(self,**kwargs):
                    calls.append(kwargs)
                    return Obj(id="org/model",sha="b"*40 if len(calls)>1 else "a"*40,private=True,siblings=[Obj(rfilename="config.json",size=len(body),blob_id=oid,lfs=None)])
                def create_commit(self,**kwargs): return Obj(oid="b"*40)
            port=LocalSdkPort(output_root=directory,hf_factory=lambda token:Api(),operation_factory=lambda **kwargs:kwargs)
            result=port.hf_commit({"repo":"org/model","visibility":"private","artifacts":[artifact],"tokenFile":str(token)})
            self.assertEqual(result["files"][0]["oid"],oid);self.assertNotIn("sha256",result["files"][0])

if __name__=="__main__":
    unittest.main()
