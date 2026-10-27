#!/usr/bin/env python3
"""Package public Hub code/assets only. Runtime configuration stays on the host."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
WORKERD_SHA256 = "11bbebfd6ad1a86693a4378d93fcd08a2052bcda02658b9adfbb42c41a2b5883"


def package(worker, commit, output):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("exact source commit required")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() != commit:
        raise ValueError("checkout does not match source commit")
    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp)
        shutil.copyfile(worker, stage / "worker.js")
        for name in ("entry.mjs", "rate-limit.mjs"):
            shutil.copyfile(ROOT / "scripts/self-hosted" / name, stage / name)
        entry = stage / "entry.mjs"
        metadata = {
            "SOURCE_COMMIT": commit, "SOURCE_TAG": "hub-" + commit,
            "SOURCE_REPO": "https://github.com/TITOCHAN2023/fleetForAgent",
            "SOURCE_BUNDLE_SHA256": hashlib.sha256((stage / "worker.js").read_bytes()).hexdigest(),
            "SOURCE_WORKFLOW_RUN": os.environ.get("GITHUB_SERVER_URL", "https://github.com") +
                "/TITOCHAN2023/fleetForAgent/actions/runs/" + os.environ.get("GITHUB_RUN_ID", "0"),
        }
        source = entry.read_text()
        if source.count("const releaseSource = {};") != 1:
            raise ValueError("release metadata placeholder missing")
        entry.write_text(source.replace("const releaseSource = {};", "const releaseSource = " + json.dumps(metadata) + ";"))
        shutil.copytree(ROOT / "packages/fleet-worker/public", stage / "public")
        hashes = {}
        for path in sorted(stage.rglob("*")):
            if path.is_symlink():
                raise ValueError("release cannot contain symlinks")
            if path.is_file():
                hashes[path.relative_to(stage).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        (stage / "manifest.json").write_text(json.dumps({
            "schema": 1, "source_commit": commit, "workerd_sha256": WORKERD_SHA256,
            "files": hashes,
        }, indent=2) + "\n")
        with tarfile.open(output, "w:gz") as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.add(path, arcname=path.relative_to(stage).as_posix(), recursive=False)


if __name__ == "__main__":
    package(*sys.argv[1:])
