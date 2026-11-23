import unittest
import guard
import test_guard as f

class DelegatedManifestTests(unittest.TestCase):
    def test_optional_compact_upload_manifest_preserves_identity(self):
        legacy=f.manifest();expected=guard.identity(legacy,f.GROUP)
        manifest=f.manifest();manifest['delegatedUpload']={'bucket':'approved-models','prefix':'tasks/t1/','maxScopedSeconds':60}
        self.assertEqual(guard.identity(manifest,f.GROUP),expected)
    def test_invalid_scope_and_duration_are_refused(self):
        for option in [None,{'bucket':'*','prefix':'tasks/','maxScopedSeconds':120},{'bucket':'approved-models','prefix':'../','maxScopedSeconds':120},{'bucket':'approved-models','prefix':'tasks/','maxScopedSeconds':121},{'bucket':'approved-models','prefix':'tasks/','maxScopedSeconds':True}]:
            manifest=f.manifest();manifest['delegatedUpload']=option
            with self.assertRaises(ValueError):guard.identity(manifest,f.GROUP)
