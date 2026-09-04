#!/usr/bin/env python3
"""Talk to fleet-hub with Bearer token. No fleet-tool / flt_1 handshake."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request


def rpc(url: str, token: str, path: str, body: dict, timeout: float = 25.0) -> dict:
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={
            "authorization": "Bearer " + token,
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def wait_two(url: str, token: str, deadline: float) -> list:
    last: dict = {}
    while time.time() < deadline:
        try:
            last = rpc(url, token, "/v1/list_computers", {})
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last = {"error": str(err)}
            time.sleep(1)
            continue
        comps = [c for c in last.get("computers") or [] if c.get("online")]
        names = {c.get("name") for c in comps}
        if "pod-a" in names and "pod-b" in names:
            return comps
        time.sleep(1)
    raise SystemExit("timeout waiting for pod-a and pod-b: " + json.dumps(last)[:800])


def run(url: str, token: str, device_id: str, command: str) -> dict:
    return rpc(
        url,
        token,
        "/v1/run",
        {"device_id": device_id, "command": command, "wait_ms": 20000},
        timeout=25,
    )


def main(argv: list[str]) -> int:
    url, token = argv[1], argv[2]
    comps = wait_two(url, token, time.time() + 45)
    by_name = {c.get("name"): c for c in comps}
    out = {}
    for name in ("pod-a", "pod-b"):
        row = run(url, token, by_name[name]["id"], 'printf %s "$HOSTNAME"')
        stdout = str(row.get("stdout") or "").strip()
        if row.get("ok") is not True and not stdout:
            raise SystemExit(name + " run failed: " + json.dumps(row)[:800])
        out[name] = stdout or str(row)
    if out["pod-a"] == out["pod-b"]:
        raise SystemExit("hostnames not distinct: %r" % (out,))
    print(json.dumps({"ok": True, "pod-a": out["pod-a"], "pod-b": out["pod-b"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
