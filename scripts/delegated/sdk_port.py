"""Trusted uploader-only official SDK adapters. No CLI, login cache, or central data proxy."""
import base64
import hashlib
import os
from pathlib import Path
import re
import stat


def require(condition):
    if not condition:
        raise ValueError("delegated SDK operation denied")


class LocalSdkPort:
    def __init__(self, *, output_root="/outputs", s3_factory=None, hf_factory=None, operation_factory=None):
        self.root = Path(output_root).absolute()
        self.real_root = self.root.resolve()
        self.s3_factory, self.hf_factory, self.operation_factory = s3_factory, hf_factory, operation_factory

    def _artifact(self, item):
        path = Path(item["path"])
        require(path.is_absolute() and ".." not in path.parts and path.is_relative_to(self.root) and path.resolve().is_relative_to(self.real_root))
        cursor = path
        while cursor != self.root:
            require(not cursor.is_symlink())
            cursor = cursor.parent
        file = os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb")
        try:
            info = os.fstat(file.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_size == item["size"] and 0 < info.st_size <= 5*1024**3)
            require(hashlib.file_digest(file, "sha256").hexdigest() == item["sha256"])
            file.seek(0)
            return file
        except BaseException:
            file.close()
            raise

    def s3_upload(self, item, credentials):
        try:
            require(re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", item["region"]) and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", item["bucket"]) and re.fullmatch(r"\d{12}", item["accountId"]))
            require(re.fullmatch(r"[A-Za-z0-9_./-]{1,512}",item["key"]) and ".." not in item["key"] and not item["key"].startswith("/"))
            if self.s3_factory:
                client=self.s3_factory(item["region"],credentials)
            else:
                import boto3
                from botocore.config import Config
                client=boto3.client("s3",region_name=item["region"],endpoint_url="https://s3."+item["region"]+".amazonaws.com",
                    aws_access_key_id=credentials["accessKeyId"],aws_secret_access_key=credentials["secretAccessKey"],aws_session_token=credentials["sessionToken"],
                    config=Config(signature_version="s3v4",retries={"total_max_attempts":1}))
            with self._artifact(item) as file:
                result=client.put_object(Bucket=item["bucket"],Key=item["key"],Body=file,ContentLength=item["size"],
                    ChecksumSHA256=base64.b64encode(bytes.fromhex(item["sha256"])).decode("ascii"),ExpectedBucketOwner=item["accountId"],IfNoneMatch="*")
            version=result.get("VersionId")
            require(isinstance(version,str) and version and version!="null" and len(version)<=256)
            return {"versionId":version}
        except Exception:
            raise ValueError("delegated SDK operation denied") from None

    def hf_commit(self,item):
        opened=[]
        try:
            require(re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+",item["repo"]) and item["visibility"] in ("private","public"))
            with os.fdopen(os.open(item["tokenFile"],os.O_RDONLY|os.O_NOFOLLOW),"rb") as secret:
                info=os.fstat(secret.fileno())
                require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode)==0o600 and info.st_uid==os.getuid())
                token=secret.read(129).decode("ascii")
                require(re.fullmatch(r"hf_[A-Za-z0-9_]{5,125}",token))
            if self.hf_factory:
                api=self.hf_factory(token)
            else:
                from huggingface_hub import HfApi
                api=HfApi(endpoint="https://huggingface.co",token=token)
            before=api.repo_info(repo_id=item["repo"],repo_type="model")
            require(before.id==item["repo"] and before.private==(item["visibility"]=="private") and re.fullmatch(r"[a-f0-9]{40}",before.sha))
            require(1<=len(item["artifacts"])<=256)
            if self.operation_factory:
                make=self.operation_factory
            else:
                from huggingface_hub import CommitOperationAdd
                make=CommitOperationAdd
            operations=[]
            for item_file in item["artifacts"]:
                require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,255}",item_file["name"]) and ".." not in item_file["name"])
                file=self._artifact(item_file);opened.append(file)
                operations.append(make(path_in_repo=item_file["name"],path_or_fileobj=file))
            commit=api.create_commit(repo_id=item["repo"],repo_type="model",operations=operations,revision="main",parent_commit=before.sha,commit_message="Approved delegated model artifacts")
            require(re.fullmatch(r"[a-f0-9]{40}",commit.oid))
            pinned=api.repo_info(repo_id=item["repo"],repo_type="model",revision=commit.oid,files_metadata=True)
            after=api.repo_info(repo_id=item["repo"],repo_type="model")
            require(pinned.id==item["repo"] and pinned.sha==commit.oid and pinned.private==before.private and after.id==item["repo"] and after.sha==commit.oid and after.private==before.private)
            receipts=[]
            for item_file in item["artifacts"]:
                entries=[f for f in pinned.siblings if f.rfilename==item_file["name"]]
                require(len(entries)==1)
                entry=entries[0]
                require(entry.size==item_file["size"] and re.fullmatch(r"[a-f0-9]{40}",entry.blob_id))
                receipt={"path":item_file["name"],"size":entry.size,"oid":entry.blob_id}
                if entry.lfs:
                    require(entry.lfs.sha256==item_file["sha256"] and entry.lfs.size==item_file["size"])
                    receipt["sha256"]=entry.lfs.sha256
                else:
                    with self._artifact(item_file) as file:
                        digest=hashlib.sha1(b"blob "+str(entry.size).encode("ascii")+b"\0")
                        for block in iter(lambda:file.read(1024*1024),b""):
                            digest.update(block)
                    require(digest.hexdigest()==entry.blob_id)
                receipts.append(receipt)
            return {"commit":commit.oid,"files":receipts}
        except Exception:
            raise ValueError("delegated SDK operation denied") from None
        finally:
            for file in opened:
                file.close()
