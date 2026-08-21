import { dispatchHello, dispatchRun } from "./hub";
import { LAB_DEVICES, runSimulated, type ShellDevice } from "./shell";
import { HUB, SEED_NODES } from "./world";

export type LabCheck = {
  id: string;
  group: "darwin" | "linux" | "windows" | "net" | "hub";
  title: string;
  ok: boolean;
  detail: string;
};

function device(os: ShellDevice["os"]): ShellDevice {
  return LAB_DEVICES.find((d) => d.os === os)!;
}

function sh(os: ShellDevice["os"], cmd: string) {
  return runSimulated(device(os), cmd);
}

function check(
  id: string,
  group: LabCheck["group"],
  title: string,
  ok: boolean,
  detail: string,
): LabCheck {
  return { id, group, title, ok, detail };
}

export function runLabSuite(): { passed: number; failed: number; checks: LabCheck[] } {
  const checks: LabCheck[] = [];

  const macUnameS = sh("darwin", "uname -s");
  checks.push(
    check("d-uname-s", "darwin", "uname -s is Darwin", macUnameS.stdout.trim() === "Darwin", macUnameS.stdout || macUnameS.stderr),
  );
  const macUnameA = sh("darwin", "uname -a");
  checks.push(
    check(
      "d-uname-a",
      "darwin",
      "uname -a fingerprints mac mini arm64",
      macUnameA.exitCode === 0 &&
        macUnameA.stdout.includes("Darwin") &&
        macUnameA.stdout.includes("mac-mini-home") &&
        macUnameA.stdout.includes("arm64") &&
        !macUnameA.stdout.includes("Linux") &&
        !macUnameA.stdout.includes("Windows"),
      macUnameA.stdout,
    ),
  );
  const sw = sh("darwin", "sw_vers");
  checks.push(
    check("d-swvers", "darwin", "sw_vers reports macOS 15.3", sw.stdout.includes("macOS") && sw.stdout.includes("15.3"), sw.stdout),
  );
  const macHome = sh("darwin", "pwd");
  checks.push(check("d-pwd", "darwin", "home is /Users/keel", macHome.stdout.trim() === "/Users/keel", macHome.stdout));
  const macWho = sh("darwin", "whoami");
  checks.push(check("d-who", "darwin", "whoami is keel", macWho.stdout.trim() === "keel", macWho.stdout));
  const macOsrel = sh("darwin", "cat /etc/os-release");
  checks.push(
    check("d-osrel", "darwin", "/etc/os-release does not exist", macOsrel.exitCode !== 0 && macOsrel.stderr.toLowerCase().includes("no such file"), macOsrel.stderr),
  );
  const macIpconfig = sh("darwin", "ipconfig");
  checks.push(
    check("d-no-ipconfig", "darwin", "ipconfig is not a macOS command", macIpconfig.exitCode !== 0 && macIpconfig.stderr.includes("command not found"), macIpconfig.stderr),
  );
  const macIf = sh("darwin", "ifconfig");
  checks.push(
    check(
      "d-ifconfig",
      "darwin",
      "ifconfig has loopback only, no intranet IP",
      macIf.stdout.includes("127.0.0.1") &&
        macIf.stdout.includes("inet: none") &&
        !macIf.stdout.includes("192.168.") &&
        !macIf.stdout.includes("100.64."),
      macIf.stdout,
    ),
  );
  const macModel = sh("darwin", "sysctl -n hw.model");
  checks.push(check("d-model", "darwin", "hw.model is Macmini9,1", macModel.stdout.trim() === "Macmini9,1", macModel.stdout));
  const macLs = sh("darwin", "ls");
  checks.push(check("d-ls", "darwin", "ls includes Library", macLs.stdout.includes("Library"), macLs.stdout));
  const macVer = sh("darwin", "ver");
  checks.push(check("d-no-ver", "darwin", "ver is not a macOS command", macVer.exitCode !== 0, macVer.stderr));

  const linUnameS = sh("linux", "uname -s");
  checks.push(check("l-uname-s", "linux", "uname -s is Linux", linUnameS.stdout.trim() === "Linux", linUnameS.stdout));
  const linUnameA = sh("linux", "uname -a");
  checks.push(
    check(
      "l-uname-a",
      "linux",
      "uname -a fingerprints Ubuntu colo x86_64",
      linUnameA.stdout.includes("Linux") &&
        linUnameA.stdout.includes("linux-colo-1") &&
        linUnameA.stdout.includes("x86_64") &&
        linUnameA.stdout.includes("GNU/Linux") &&
        !linUnameA.stdout.includes("Darwin"),
      linUnameA.stdout,
    ),
  );
  const osrel = sh("linux", "cat /etc/os-release");
  checks.push(
    check("l-osrel", "linux", "/etc/os-release is Ubuntu 24.04", osrel.exitCode === 0 && osrel.stdout.includes("Ubuntu") && osrel.stdout.includes("24.04"), osrel.stdout),
  );
  const linHome = sh("linux", "pwd");
  checks.push(check("l-pwd", "linux", "home is /home/keel", linHome.stdout.trim() === "/home/keel", linHome.stdout));
  const linSw = sh("linux", "sw_vers");
  checks.push(check("l-no-swvers", "linux", "sw_vers is not a Linux command", linSw.exitCode !== 0 && linSw.stderr.includes("command not found"), linSw.stderr));
  const linIpc = sh("linux", "ipconfig");
  checks.push(check("l-no-ipconfig", "linux", "ipconfig is not a Linux command", linIpc.exitCode !== 0, linIpc.stderr));
  const linIp = sh("linux", "ip addr");
  checks.push(
    check(
      "l-ip",
      "linux",
      "ip addr has no ClusterIP / no intranet",
      linIp.stdout.includes("127.0.0.1") &&
        linIp.stdout.includes("inet none") &&
        linIp.stdout.includes("no ClusterIP") &&
        !linIp.stdout.includes("10.20.0.") &&
        !linIp.stdout.includes("100.64."),
      linIp.stdout,
    ),
  );
  const linDir = sh("linux", "dir");
  checks.push(check("l-no-dir", "linux", "dir is not a Linux command", linDir.exitCode !== 0, linDir.stderr));
  const linId = sh("linux", "id");
  checks.push(check("l-id", "linux", "id is uid=1000(keel)", linId.stdout.includes("uid=1000(keel)"), linId.stdout));

  const winVer = sh("windows", "ver");
  checks.push(
    check("w-ver", "windows", "ver is Windows 10.0.26100", winVer.exitCode === 0 && winVer.stdout.includes("Windows") && winVer.stdout.includes("10.0.26100"), winVer.stdout),
  );
  const winUnameA = sh("windows", "uname -a");
  checks.push(
    check(
      "w-uname-a",
      "windows",
      "uname -a fingerprints Windows_NT cloud box",
      winUnameA.stdout.includes("Windows_NT") &&
        winUnameA.stdout.includes("win-cloud-gpu") &&
        !winUnameA.stdout.includes("Darwin") &&
        !winUnameA.stdout.includes("GNU/Linux"),
      winUnameA.stdout,
    ),
  );
  const winWho = sh("windows", "whoami");
  checks.push(check("w-who", "windows", "whoami is keel\\operator", winWho.stdout.includes("keel") && winWho.stdout.includes("\\"), winWho.stdout));
  const winPwd = sh("windows", "pwd");
  checks.push(check("w-pwd", "windows", "home is C:\\Users\\keel", winPwd.stdout.includes("C:\\Users\\keel"), winPwd.stdout));
  const winSw = sh("windows", "sw_vers");
  checks.push(
    check("w-no-swvers", "windows", "sw_vers is not recognized", winSw.exitCode !== 0 && winSw.stderr.toLowerCase().includes("not recognized"), winSw.stderr),
  );
  const winCat = sh("windows", "cat /etc/os-release");
  checks.push(
    check("w-no-cat", "windows", "cat is not a cmd builtin", winCat.exitCode !== 0 && winCat.stderr.toLowerCase().includes("not recognized"), winCat.stderr),
  );
  const winIf = sh("windows", "ifconfig");
  checks.push(check("w-no-ifconfig", "windows", "ifconfig is not recognized", winIf.exitCode !== 0, winIf.stderr));
  const winIp = sh("windows", "ipconfig");
  checks.push(
    check(
      "w-ipconfig",
      "windows",
      "ipconfig has no intranet IPv4",
      winIp.stdout.includes("Windows IP Configuration") &&
        winIp.stdout.includes("Intranet IPv4 Address") &&
        winIp.stdout.includes("None") &&
        winIp.stdout.includes("Media disconnected") &&
        !winIp.stdout.includes("10.40.0.") &&
        !winIp.stdout.includes("100.64."),
      winIp.stdout,
    ),
  );
  const winDir = sh("windows", "dir");
  checks.push(check("w-dir", "windows", "dir lists NOTES.txt", winDir.stdout.includes("NOTES.txt") && winDir.stdout.includes("Directory of"), winDir.stdout));
  const winSys = sh("windows", "systeminfo");
  checks.push(check("w-sys", "windows", "systeminfo is Windows 11 Pro", winSys.stdout.includes("Windows 11 Pro") && winSys.stdout.includes("26100"), winSys.stdout));

  const macPingLin = sh("darwin", "ping -c 1 linux-colo-1");
  checks.push(
    check(
      "n-mac-linux-isolated",
      "net",
      "Mac cannot resolve Linux (no intranet DNS)",
      macPingLin.exitCode !== 0 && macPingLin.stderr.toLowerCase().includes("unknown host"),
      macPingLin.stderr,
    ),
  );
  const linPingWin = sh("linux", "ping -c 1 win-cloud-gpu");
  checks.push(
    check(
      "n-linux-win-isolated",
      "net",
      "Linux cannot resolve Windows",
      linPingWin.exitCode !== 0 && linPingWin.stderr.includes("Unknown host"),
      linPingWin.stderr,
    ),
  );
  const winPingMac = sh("windows", "ping -n 1 mac-mini-home");
  checks.push(
    check(
      "n-win-mac-isolated",
      "net",
      "Windows cannot find Mac host",
      winPingMac.exitCode !== 0 && winPingMac.stderr.toLowerCase().includes("could not find host"),
      winPingMac.stderr,
    ),
  );
  const macPingLan = sh("darwin", "ping -c 1 10.20.0.21");
  checks.push(
    check(
      "n-mac-rfc1918-blocked",
      "net",
      "Mac has no route to RFC1918",
      macPingLan.exitCode !== 0 && macPingLan.stderr.toLowerCase().includes("unreachable"),
      macPingLan.stderr,
    ),
  );
  const linPingMacLan = sh("linux", "ping -c 1 192.168.10.12");
  checks.push(
    check(
      "n-linux-rfc1918-blocked",
      "net",
      "Linux has no route to home LAN",
      linPingMacLan.exitCode !== 0 && linPingMacLan.stderr.includes("unreachable"),
      linPingMacLan.stderr,
    ),
  );
  const macHub = sh("darwin", "ping -c 1 hub.keel");
  checks.push(
    check(
      "n-mac-hub",
      "net",
      "Mac reaches hub only via internet",
      macHub.exitCode === 0 && macHub.stdout.includes(HUB.publicIp),
      macHub.stdout,
    ),
  );
  const linDns = sh("linux", "ping -c 1 8.8.8.8");
  checks.push(
    check("n-linux-wan", "net", "Linux can ping 8.8.8.8", linDns.exitCode === 0 && linDns.stdout.includes("8.8.8.8"), linDns.stdout),
  );
  const winHub = sh("windows", "ping -n 1 hub.keel");
  checks.push(
    check(
      "n-win-hub",
      "net",
      "Windows reaches hub.keel via internet",
      winHub.exitCode === 0 && winHub.stdout.includes("0% loss") && winHub.stdout.includes(HUB.publicIp),
      winHub.stdout,
    ),
  );
  const winWan = sh("windows", "ping -n 1 8.8.8.8");
  checks.push(check("n-win-wan", "net", "Windows can ping 8.8.8.8", winWan.exitCode === 0, winWan.stdout));
  const unknown = sh("linux", "ping -c 1 no-such-host.keel");
  checks.push(check("n-unknown", "net", "unknown host fails", unknown.exitCode !== 0, unknown.stderr));
  const overlayGone = sh("linux", "ping -c 1 100.64.0.1");
  checks.push(
    check(
      "n-no-overlay",
      "net",
      "CGNAT overlay is not a path",
      overlayGone.exitCode !== 0 && overlayGone.stderr.includes("unreachable"),
      overlayGone.stderr,
    ),
  );
  const linRoute = sh("linux", "ip route");
  checks.push(
    check(
      "n-linux-default-only",
      "net",
      "Linux routing table is default egress only",
      linRoute.stdout.includes("default") && linRoute.stdout.includes("no intranet") && !linRoute.stdout.includes("10.20.0.0"),
      linRoute.stdout,
    ),
  );

  for (const os of ["darwin", "linux", "windows"] as const) {
    const denied = sh(os, "rm -rf /");
    checks.push(check(`p-${os}-rm`, os, "destructive rm is refused", denied.exitCode === 126 && denied.stderr.includes("refused"), denied.stderr));
  }

  const hello = dispatchHello(device("linux"));
  checks.push(
    check(
      "h-hello",
      "hub",
      "worker hello / hello_ok pair",
      hello.length === 2 && hello[0]!.envelope.type === "hello" && hello[1]!.envelope.type === "hello_ok" && hello[0]!.envelope.v === 1,
      JSON.stringify(hello.map((e) => e.envelope.type)),
    ),
  );
  const online = dispatchRun({ device: device("darwin"), online: true, command: "uname -s" });
  const types = online.events.map((e) => e.envelope.type);
  checks.push(
    check(
      "h-run-mac",
      "hub",
      "worker run on Mac returns Darwin through envelopes",
      online.status === "ok" &&
        online.stdout.trim() === "Darwin" &&
        types[0] === "run" &&
        types.includes("chunk") &&
        types.at(-1) === "result" &&
        online.events[0]!.direction === "down",
      `${types.join(" > ")} :: ${online.stdout}`,
    ),
  );
  const winRun = dispatchRun({ device: device("windows"), online: true, command: "ver" });
  checks.push(
    check("h-run-win", "hub", "worker run on Windows returns ver via hub", winRun.status === "ok" && winRun.stdout.includes("10.0.26100") && winRun.events[0]!.envelope.body.cwd === "C:\\Users\\keel", winRun.stdout),
  );
  const linRun = dispatchRun({ device: device("linux"), online: true, command: "cat /etc/os-release" });
  checks.push(
    check("h-run-lin", "hub", "worker run on Linux returns Ubuntu", linRun.status === "ok" && linRun.stdout.includes("Ubuntu"), linRun.stdout.slice(0, 180)),
  );
  const offline = dispatchRun({ device: device("windows"), online: false, command: "ver" });
  checks.push(
    check(
      "h-offline",
      "hub",
      "offline device never executes shell",
      offline.status === "offline" &&
        !offline.stdout.includes("Windows") &&
        offline.events.some((e) => e.envelope.type === "result" && e.envelope.body.error === "offline"),
      offline.stderr,
    ),
  );
  const cwdMac = dispatchRun({ device: device("darwin"), online: true, command: "pwd" });
  checks.push(
    check("h-cwd-mac", "hub", "Mac run cwd is /Users/keel", String(cwdMac.events[0]!.envelope.body.cwd) === "/Users/keel", String(cwdMac.events[0]!.envelope.body.cwd)),
  );

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return { passed, failed, checks };
}

export function labTopology() {
  return {
    hub: HUB,
    nodes: SEED_NODES,
  };
}
