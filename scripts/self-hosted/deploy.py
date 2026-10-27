#!/usr/bin/env python3
"""Pull attested Hub releases; preserve host secrets, namespace IDs and data."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

REPO = "TITOCHAN2023/fleetForAgent"
WORKFLOW = REPO + "/.github/workflows/release-self-hosted-hub.yml"
MAX_BYTES = 64 * 1024 * 1024
RUNTIME = ("worker.js", "entry.mjs", "rate-limit.mjs")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_json(path, value):
    temp = path.with_suffix(".new")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temp, path)


def point(link, target):
    temp = link.with_name(link.name + ".new")
    temp.unlink(missing_ok=True)
    temp.symlink_to(target)
    os.replace(temp, link)


def unpack(archive, destination, commit):
    """No tar extractall: reject paths, links, duplicate entries and excess size."""
    seen, total = set(), 0
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name = member.name
            parts = PurePosixPath(name).parts
            allowed = name in (*RUNTIME, "manifest.json") or name.startswith("public/")
            if (not allowed or not member.isfile() or name in seen or
                    not parts or ".." in parts or name.startswith("/") or
                    "\\" in name or PurePosixPath(name).as_posix() != name):
                raise ValueError("invalid release member")
            seen.add(name)
            total += member.size
            if len(seen) > 4096 or total > MAX_BYTES or member.size < 0:
                raise ValueError("release exceeds size limit")
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output, tar.extractfile(member) as source:
                shutil.copyfileobj(source, output)
            path.chmod(0o644)
    manifest = json.loads((destination / "manifest.json").read_text())
    files = manifest.get("files", {})
    if (manifest.get("schema") != 1 or manifest.get("source_commit") != commit or
            set(files) != seen - {"manifest.json"} or
            not set(RUNTIME).issubset(files) or "public/index.html" not in files):
        raise ValueError("release manifest mismatch")
    for name, expected in files.items():
        if digest(destination / name) != expected:
            raise ValueError("release checksum mismatch")
    return manifest


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


def wait_health(port, process=None):
    for _ in range(40):
        if process is not None and process.poll() is not None:
            raise RuntimeError("candidate runtime exited")
        if healthy(port):
            return
        time.sleep(0.5)
    raise RuntimeError("Hub readiness timed out")


def check_release(commit, manifest):
    wait_health(8787)
    with urllib.request.urlopen("http://127.0.0.1:8787/source", timeout=5) as response:
        if json.load(response).get("source_commit") != commit:
            raise RuntimeError("running Hub source does not match release")
    for name in ("plugin-registry.json", "fleet-tool.tgz"):
        with urllib.request.urlopen("http://127.0.0.1:8788/" + name, timeout=10) as response:
            actual = hashlib.sha256(response.read(MAX_BYTES + 1)).hexdigest()
        if actual != manifest["files"]["public/" + name]:
            raise RuntimeError("served assets do not match release")


def candidate_config(config, state):
    # Only these exact existing production paths may be replaced. Never infer IDs.
    for old in ("/var/lib/fleet/state", "127.0.0.1:8787"):
        if config.count(old) != 1:
            raise ValueError("unexpected production configuration layout")
    return config.replace("/var/lib/fleet/state", str(state)).replace("127.0.0.1:8787", "127.0.0.1:18987")


def preflight(root, release, manifest):
    binary = root / "hub/workerd"
    if digest(binary) != manifest["workerd_sha256"]:
        raise ValueError("workerd version differs from tested release")
    if healthy(18987):
        raise RuntimeError("candidate port is occupied")
    with tempfile.TemporaryDirectory(prefix="preflight-", dir=root) as temp:
        stage = Path(temp)
        state = stage / "state"
        state.mkdir()
        config = candidate_config((root / "hub/hub.capnp").read_text(), state)
        (stage / "hub.capnp").write_text(config)
        (stage / "hub.capnp").chmod(0o600)
        for name in RUNTIME:
            (stage / name).symlink_to(release / name)
        # Never log the config or runtime stderr: both can contain protected values.
        with (stage / "runtime.log").open("wb") as log:
            proc = subprocess.Popen([str(binary), "serve", str(stage / "hub.capnp"), "--experimental"],
                                    cwd=stage, stdout=log, stderr=log)
            try:
                wait_health(18987, proc)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


def restart():
    subprocess.run(["systemctl", "restart", "fleet-hub.service"], check=True)


def activate(root, release, restart_fn=restart, check_fn=lambda: wait_health(8787), rollback_check=lambda: wait_health(8787)):
    current = root / "current"
    previous = current.resolve(strict=True)
    point(current, release)
    try:
        restart_fn()
        check_fn()
    except Exception:
        point(current, previous)
        restart_fn()
        rollback_check()
        raise RuntimeError("new Hub failed readiness; previous release restored")
    point(root / "previous", previous)


def bootstrap(root):
    """One-time layout conversion, preserving an exact rollback copy."""
    if (root / "current").is_symlink():
        return
    if (root / "current").exists() or (root / "assets").is_symlink():
        raise RuntimeError("unexpected release layout")
    saved = root / "assets.before-releases"
    if saved.exists():
        raise RuntimeError("assets backup already exists")
    baseline = root / "releases" / ("baseline-" + str(int(time.time())))
    baseline.mkdir(parents=True)
    for name in RUNTIME:
        shutil.copy2(root / "hub" / name, baseline / name)
        (baseline / name).chmod(0o644)
    shutil.copytree(root / "assets", baseline / "public")
    point(root / "current", baseline)
    for name in RUNTIME:
        point(root / "hub" / name, root / "current" / name)
    os.rename(root / "assets", saved)
    try:
        (root / "assets").symlink_to(root / "current/public")
    except Exception:
        os.rename(saved, root / "assets")
        raise


def verify(root, archive, bundle, commit):
    subprocess.run([str(root / "bin/gh"), "attestation", "verify", str(archive),
                    "--bundle", str(bundle), "--repo", REPO, "--signer-workflow", WORKFLOW,
                    "--source-digest", commit, "--source-ref", "refs/heads/main"],
                   check=True, timeout=120, stdout=subprocess.DEVNULL)


def install(root, archive, bundle, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("exact source commit required")
    verify(root, archive, bundle, commit)
    releases = root / "releases"
    releases.mkdir(exist_ok=True)
    target = releases / commit
    if target.exists():
        raise RuntimeError("release already staged; inspect deployment status before retrying")
    with tempfile.TemporaryDirectory(prefix="stage-", dir=releases) as temp:
        stage = Path(temp)
        manifest = unpack(archive, stage, commit)
        # mkdtemp is private; nginx and the fleet service need read-only traversal.
        stage.chmod(0o755)
        preflight(root, stage, manifest)
        shutil.move(str(stage), target)
    bootstrap(root)
    subprocess.run(["systemctl", "start", "fleet-backup.service"], check=True, timeout=300)
    activate(root, target, check_fn=lambda: check_release(commit, manifest))
    # Backups must restore the code that owns the current durable storage.
    for name in RUNTIME:
        destination = Path("/etc/fleet/recovery") / name
        temp = destination.with_suffix(".new")
        shutil.copyfile(target / name, temp)
        temp.chmod(0o600)
        os.replace(temp, destination)
    atomic_json(root / "deployment.json", {"status": "ok", "source_commit": commit,
                "deployed_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    (root / "deployment-error.json").unlink(missing_ok=True)


def releases():
    request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases?per_page=30",
                                     headers={"User-Agent": "FleetDeploy/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def pull(root):
    candidates = [r for r in releases() if not r["draft"] and not r["prerelease"]
                  and re.fullmatch(r"hub-[0-9a-f]{40}", r["tag_name"])]
    if not candidates:
        return
    release = max(candidates, key=lambda r: r["published_at"])
    commit = release["tag_name"][4:]
    if (root / "current").is_symlink() and (root / "current").resolve().name == commit:
        return
    names = {a["name"]: a["browser_download_url"] for a in release["assets"]}
    with tempfile.TemporaryDirectory(prefix="download-", dir=root) as temp:
        for name in ("fleet-hub.tar.gz", "fleet-hub.sigstore.json"):
            url = names.get(name, "")
            expected = f"https://github.com/{REPO}/releases/download/{release['tag_name']}/{name}"
            if url != expected:
                raise ValueError("release asset is missing or has an unexpected URL")
            subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                            "--proto", "=https", "--proto-redir", "=https", "--retry", "3",
                            "--connect-timeout", "15", "--max-time", "240", "--max-filesize", str(MAX_BYTES),
                            "--output", str(Path(temp) / name), url], check=True, timeout=1000)
        install(root, Path(temp) / "fleet-hub.tar.gz", Path(temp) / "fleet-hub.sigstore.json", commit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/opt/fleet"))
    parser.add_argument("--apply", type=Path)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--commit")
    args = parser.parse_args()
    os.umask(0o022)
    with (args.root / "deploy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.apply:
                if not args.bundle or not args.commit:
                    parser.error("--apply requires --bundle and --commit")
                install(args.root, args.apply.resolve(), args.bundle.resolve(), args.commit)
            else:
                pull(args.root)
        except Exception as error:
            # Do not publish exception bodies that could include runtime settings.
            atomic_json(args.root / "deployment-error.json", {"status": "failed", "error_type": type(error).__name__,
                        "time": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            raise


if __name__ == "__main__":
    main()
