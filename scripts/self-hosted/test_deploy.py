import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("deploy.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def test_archive_validates_every_file_and_exact_commit(self):
        commit = "a" * 40
        files = {name: b"safe code" for name in (*deploy.RUNTIME, "public/index.html")}
        manifest = {"schema": 1, "source_commit": commit,
                    "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "valid.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                for name, data in {**files, "manifest.json": json.dumps(manifest).encode()}.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    tar.addfile(member, io.BytesIO(data))
            good, bad = root / "good", root / "bad"
            good.mkdir()
            bad.mkdir()
            self.assertEqual(deploy.unpack(archive, good, commit), manifest)
            with self.assertRaisesRegex(ValueError, "manifest mismatch"):
                deploy.unpack(archive, bad, "b" * 40)

    def test_bootstrap_keeps_configuration_and_data_outside_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "hub").mkdir()
            (root / "assets").mkdir()
            (root / "assets/index.html").write_text("old assets")
            (root / "hub/hub.capnp").write_text("private host configuration")
            for name in deploy.RUNTIME:
                (root / "hub" / name).write_text(name)
            deploy.bootstrap(root)
            self.assertEqual((root / "assets/index.html").read_text(), "old assets")
            self.assertEqual((root / "hub/hub.capnp").read_text(), "private host configuration")
            self.assertFalse((root / "current/hub.capnp").exists())
            self.assertEqual((root / "hub/worker.js").read_text(), "worker.js")
            deploy.bootstrap(root)  # repeated setup must preserve the same baseline

    def test_failed_activation_restores_previous_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, new = root / "old", root / "new"
            old.mkdir()
            new.mkdir()
            (root / "current").symlink_to(old)
            restarts = []

            def check():
                if (root / "current").resolve() == new:
                    raise RuntimeError("broken candidate")

            with self.assertRaisesRegex(RuntimeError, "previous release restored"):
                deploy.activate(root, new, lambda: restarts.append(True), check, check)
            self.assertEqual((root / "current").resolve(), old)
            self.assertEqual(len(restarts), 2)

    def test_candidate_cannot_reuse_production_database(self):
        config = 'state="/var/lib/fleet/state" listen="127.0.0.1:8787" key="keep-original"'
        candidate = deploy.candidate_config(config, Path("/private/candidate/state"))
        self.assertNotIn("/var/lib/fleet/state", candidate)
        self.assertIn("127.0.0.1:18987", candidate)
        self.assertIn('key="keep-original"', candidate)
        with self.assertRaises(ValueError):
            deploy.candidate_config(config + config, Path("/candidate"))

    def test_archive_rejects_path_escape_links_duplicates_and_missing_manifest(self):
        for kind in ("escape", "link", "duplicate", "missing"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / "test.tgz"
                with tarfile.open(archive, "w:gz") as tar:
                    member = tarfile.TarInfo("public/../../escaped" if kind == "escape" else "worker.js")
                    if kind == "link":
                        member.type = tarfile.SYMTYPE
                        member.linkname = "/etc/shadow"
                    tar.addfile(member, io.BytesIO(b""))
                    if kind == "duplicate":
                        tar.addfile(member, io.BytesIO(b""))
                stage = root / "stage"
                stage.mkdir()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    deploy.unpack(archive, stage, "a" * 40)
                self.assertFalse((root / "escaped").exists())


if __name__ == "__main__":
    unittest.main()
