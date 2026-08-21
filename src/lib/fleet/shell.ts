import type { OsKind } from "./protocol";
import {
  HUB,
  SEED_NODES,
  allNodes,
  resolveNode,
  resolvePingTarget,
  type NetNode,
} from "./world";

export type ShellDevice = {
  name: string;
  slug: string;
  os: OsKind;
  arch: string;
  locationTag: string;
};

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const REFUSED = [
  "rm",
  "rmdir",
  "shutdown",
  "reboot",
  "poweroff",
  "mkfs",
  "format",
  "dd",
  "diskpart",
  "mkfs.ext4",
];

function nodeOf(d: ShellDevice): NetNode {
  return resolveNode(d);
}

function home(d: ShellDevice) {
  if (d.os === "windows") return "C:\\Users\\keel";
  if (d.os === "darwin") return "/Users/keel";
  return "/home/keel";
}

function notFound(d: ShellDevice, bin: string): ShellResult {
  if (d.os === "windows") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `'${bin}' is not recognized as an internal or external command,\noperable program or batch file.`,
    };
  }
  if (d.os === "darwin") {
    return { exitCode: 127, stdout: "", stderr: `zsh: command not found: ${bin}` };
  }
  return { exitCode: 127, stdout: "", stderr: `bash: ${bin}: command not found` };
}

function noFile(d: ShellDevice, path: string): ShellResult {
  if (d.os === "windows") {
    return { exitCode: 1, stdout: "", stderr: `The system cannot find the path specified.\n${path}` };
  }
  return { exitCode: 1, stdout: "", stderr: `cat: ${path}: No such file or directory` };
}

function parse(raw: string, os: OsKind) {
  const command = raw.trim();
  const parts = command.split(/\s+/).filter(Boolean);
  const binRaw = parts[0] ?? "";
  const bin = os === "windows" ? binRaw.toLowerCase() : binRaw.replace(/^.*\//, "");
  const args = parts.slice(1);
  return { command, bin, args };
}

function rtt(from: NetNode, kind: string) {
  if (kind === "hub") return from.locationTag === "home" ? 28 : from.locationTag === "colo" ? 12 : 9;
  return 18;
}

function pingUnix(from: NetNode, hostLabel: string, ip: string, ok: boolean, ms: number, count: number) {
  if (!ok) {
    const lines = [`PING ${hostLabel} (${ip}): 56 data bytes`];
    for (let i = 0; i < count; i++) lines.push(`Request timeout for icmp_seq ${i}`);
    lines.push(`--- ${hostLabel} ping statistics ---`);
    lines.push(`${count} packets transmitted, 0 packets received, 100.0% packet loss`);
    return { exitCode: 1, stdout: lines.join("\n"), stderr: "" };
  }
  const lines = [`PING ${hostLabel} (${ip}): 56 data bytes`];
  for (let i = 0; i < count; i++) {
    lines.push(`64 bytes from ${ip}: icmp_seq=${i} ttl=54 time=${(ms + i * 0.3).toFixed(1)} ms`);
  }
  lines.push(`--- ${hostLabel} ping statistics ---`);
  lines.push(`${count} packets transmitted, ${count} packets received, 0.0% packet loss`);
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

function pingWindows(hostLabel: string, ip: string, ok: boolean, ms: number, count: number) {
  const lines = [`Pinging ${hostLabel} [${ip}] with 32 bytes of data:`];
  if (!ok) {
    for (let i = 0; i < count; i++) lines.push("Request timed out.");
    lines.push("");
    lines.push(`Ping statistics for ${ip}:`);
    lines.push(`    Packets: Sent = ${count}, Received = 0, Lost = ${count} (100% loss),`);
    return { exitCode: 1, stdout: lines.join("\n"), stderr: "" };
  }
  for (let i = 0; i < count; i++) {
    lines.push(`Reply from ${ip}: bytes=32 time=${ms + i}ms TTL=64`);
  }
  lines.push("");
  lines.push(`Ping statistics for ${ip}:`);
  lines.push(`    Packets: Sent = ${count}, Received = ${count}, Lost = 0 (0% loss),`);
  lines.push("Approximate round trip times in milli-seconds:");
  lines.push(`    Minimum = ${ms}ms, Maximum = ${ms + count - 1}ms, Average = ${ms}ms`);
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

function runPing(d: ShellDevice, from: NetNode, args: string[]): ShellResult {
  let count = d.os === "windows" ? 4 : 1;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === "-c" || a === "-n") && args[i + 1]) {
      count = Math.max(1, Math.min(8, Number(args[i + 1]) || count));
      i++;
      continue;
    }
    filtered.push(a);
  }
  const token = filtered[0];
  if (!token) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: d.os === "windows" ? "Bad parameter." : "ping: usage error: Destination address required",
    };
  }
  const roster = allNodes();
  const target = resolvePingTarget(from, token, roster);
  if (target.kind === "unknown" || target.kind === "peer") {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        d.os === "windows"
          ? `Ping request could not find host ${token}. Please check the name and try again.`
          : `ping: cannot resolve ${token}: Unknown host`,
    };
  }
  if (target.kind === "private") {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        d.os === "windows"
          ? `Destination host unreachable.`
          : `connect: Network is unreachable`,
    };
  }
  const ip = target.kind === "hub" ? HUB.publicIp : target.ip;
  const label = target.kind === "hub" ? HUB.host : ip;
  const kind = target.kind === "hub" ? "hub" : "wan";
  const ms = rtt(from, kind);
  return d.os === "windows" ? pingWindows(label, ip, true, ms, count) : pingUnix(from, label, ip, true, ms, count);
}

function darwinIfconfig(n: NetNode) {
  return [
    `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384`,
    `\tinet 127.0.0.1 netmask 0xff000000`,
    `${n.egressIface}: flags=8843<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500`,
    `\tstatus: internet-only NAT`,
    `\tinet: none (no intranet address)`,
  ].join("\n");
}

function linuxIpAddr(n: NetNode) {
  return [
    `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536`,
    `    inet 127.0.0.1/8 scope host lo`,
    `2: ${n.egressIface}: <BROADCAST,UP,LOWER_UP> mtu 1500`,
    `    link/ether 02:00:00:00:00:01`,
    `    inet none  (no ClusterIP, NAT egress only)`,
  ].join("\n");
}

function windowsIpconfig(_n: NetNode) {
  return [
    "Windows IP Configuration",
    "",
    "Ethernet adapter Ethernet:",
    "",
    "   Media State . . . . . . . . . . . : Media disconnected",
    "   Intranet IPv4 Address . . . . . . : None",
    "",
    "PPP adapter Internet:",
    "",
    "   Connection-specific DNS Suffix  . :",
    "   IPv4 Address. . . . . . . . . . . : (NAT, hidden)",
    "   Intranet IPv4 Address . . . . . . : None",
    "   Default Gateway . . . . . . . . . : Internet",
  ].join("\n");
}

function listing(d: ShellDevice) {
  if (d.os === "windows") {
    return [
      " Volume in drive C has no label.",
      " Volume Serial Number is KEEL-WIN1",
      "",
      ` Directory of ${home(d)}`,
      "",
      "08/21/2026  12:00 AM    <DIR>          Desktop",
      "08/21/2026  12:00 AM    <DIR>          Documents",
      "08/21/2026  12:00 AM    <DIR>          Downloads",
      "08/20/2026  09:14 AM             1,204 NOTES.txt",
      "               1 File(s)          1,204 bytes",
      "               3 Dir(s)     332,000,000,000 bytes free",
    ].join("\n");
  }
  if (d.os === "darwin") {
    return "Desktop\nDocuments\nDownloads\nLibrary\nPictures\nNOTES.md";
  }
  return "bin\netc\nhome\nopt\nroot\nusr\nvar\nNOTES.md";
}

function notes(d: ShellDevice) {
  const n = nodeOf(d);
  return `keel node ${n.hostname}\npod=${n.podId} os=${d.os} egress=internet-only no-intranet-ip`;
}

export function runSimulated(device: ShellDevice, raw: string): ShellResult {
  const n = nodeOf(device);
  const { command, bin, args } = parse(raw, device.os);
  if (!command) return { exitCode: 0, stdout: "", stderr: "" };

  const joined = args.join(" ");
  if (
    REFUSED.includes(bin) ||
    command.includes("rm -rf") ||
    command.toLowerCase().includes("del /f") ||
    command.toLowerCase().includes("format c:")
  ) {
    return {
      exitCode: 126,
      stdout: "",
      stderr: "keel: refused by device policy (destructive commands are blocked in v1)",
    };
  }

  if (bin === "help" || bin === "keel") {
    return {
      exitCode: 0,
      stdout:
        device.os === "windows"
          ? "KEEL Windows shell. Try: ver, hostname, whoami, dir, ipconfig, ping hub.keel, ping 8.8.8.8"
          : device.os === "darwin"
            ? "KEEL macOS shell. Try: uname -a, sw_vers, ifconfig, ping -c 1 hub.keel, ping -c 1 8.8.8.8"
            : "KEEL Linux shell. Try: uname -a, cat /etc/os-release, ip addr, ping -c 1 hub.keel, ping -c 1 linux-colo-1",
      stderr: "",
    };
  }

  if (bin === "echo") {
    if (device.os === "windows") {
      if (joined === "%USERPROFILE%") return { exitCode: 0, stdout: home(device), stderr: "" };
      if (joined === "%USERNAME%") return { exitCode: 0, stdout: "keel", stderr: "" };
      if (joined === "%OS%") return { exitCode: 0, stdout: "Windows_NT", stderr: "" };
    } else {
      if (joined === "$HOME") return { exitCode: 0, stdout: home(device), stderr: "" };
      if (joined === "$USER") return { exitCode: 0, stdout: "keel", stderr: "" };
    }
    return { exitCode: 0, stdout: joined, stderr: "" };
  }

  if (bin === "hostname") return { exitCode: 0, stdout: n.hostname, stderr: "" };

  if (bin === "whoami" || command === "id -un") {
    return {
      exitCode: 0,
      stdout: device.os === "windows" ? "keel\\operator" : "keel",
      stderr: "",
    };
  }

  if (bin === "pwd") return { exitCode: 0, stdout: home(device), stderr: "" };

  if (bin === "date") {
    if (device.os === "windows") {
      return { exitCode: 0, stdout: "Fri 08/21/2026", stderr: "" };
    }
    return { exitCode: 0, stdout: "Fri Aug 21 01:07:00 UTC 2026", stderr: "" };
  }

  if (bin === "ping") return runPing(device, n, args);

  // --- darwin ---
  if (device.os === "darwin") {
    if (bin === "uname" || bin === "uname.exe") {
      if (args.includes("-s") && !args.includes("-a")) return { exitCode: 0, stdout: "Darwin", stderr: "" };
      if (args.includes("-m")) return { exitCode: 0, stdout: "arm64", stderr: "" };
      if (args.includes("-a") || args.length === 0 && command.includes("-a")) {
        return {
          exitCode: 0,
          stdout: `Darwin ${n.hostname} 24.3.0 Darwin Kernel Version 24.3.0: Thu Jan  2 20:24:16 PST 2025; root:xnu-11215.81.4~3/RELEASE_ARM64_T8112 arm64`,
          stderr: "",
        };
      }
      if (args.length === 0) return { exitCode: 0, stdout: "Darwin", stderr: "" };
    }
    if (command === "uname -a") {
      return {
        exitCode: 0,
        stdout: `Darwin ${n.hostname} 24.3.0 Darwin Kernel Version 24.3.0: Thu Jan  2 20:24:16 PST 2025; root:xnu-11215.81.4~3/RELEASE_ARM64_T8112 arm64`,
        stderr: "",
      };
    }
    if (bin === "sw_vers") {
      return {
        exitCode: 0,
        stdout: "ProductName:		macOS\nProductVersion:		15.3\nBuildVersion:		24D70",
        stderr: "",
      };
    }
    if (command === "sysctl -n hw.model" || command === "sysctl hw.model") {
      return { exitCode: 0, stdout: "Macmini9,1", stderr: "" };
    }
    if (command === "scutil --get ComputerName") {
      return { exitCode: 0, stdout: n.name, stderr: "" };
    }
    if (bin === "ifconfig") return { exitCode: 0, stdout: darwinIfconfig(n), stderr: "" };
    if (bin === "ipconfig" || bin === "ip" || bin === "ver" || bin === "systeminfo" || bin === "dir") {
      return notFound(device, bin);
    }
    if (bin === "ls" || command.startsWith("ls ")) return { exitCode: 0, stdout: listing(device), stderr: "" };
    if (bin === "df") {
      return {
        exitCode: 0,
        stdout: "Filesystem     Size   Used  Avail Capacity  Mounted on\n/dev/disk3s1   494Gi  212Gi  260Gi    45%    /System/Volumes/Data",
        stderr: "",
      };
    }
    if (bin === "cat") {
      if (args[0] === "/etc/os-release") return noFile(device, "/etc/os-release");
      if (args[0] === "NOTES.md" || args[0] === `${home(device)}/NOTES.md`) {
        return { exitCode: 0, stdout: notes(device), stderr: "" };
      }
      return noFile(device, args[0] ?? "");
    }
    if (bin === "id") {
      return { exitCode: 0, stdout: "uid=501(keel) gid=20(staff) groups=20(staff),12(everyone)", stderr: "" };
    }
    if (bin === "arch") return { exitCode: 0, stdout: "arm64", stderr: "" };
    if (bin === "uptime") {
      return { exitCode: 0, stdout: "1:07  up 14 days,  3:02, 1 user, load averages: 0.08 0.11 0.09", stderr: "" };
    }
  }

  // --- linux ---
  if (device.os === "linux") {
    if (bin === "uname") {
      if (args.includes("-s") && !args.includes("-a")) return { exitCode: 0, stdout: "Linux", stderr: "" };
      if (args.includes("-m")) return { exitCode: 0, stdout: "x86_64", stderr: "" };
      if (args.length === 0) return { exitCode: 0, stdout: "Linux", stderr: "" };
    }
    if (command === "uname -a" || (bin === "uname" && args.includes("-a"))) {
      return {
        exitCode: 0,
        stdout: `Linux ${n.hostname} 6.8.0-41-generic #41-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux`,
        stderr: "",
      };
    }
    if (bin === "sw_vers" || bin === "ipconfig" || bin === "ver" || bin === "systeminfo" || bin === "dir" || bin === "ifconfig") {
      return notFound(device, bin);
    }
    if (bin === "ip" && (args[0] === "addr" || args.join(" ") === "addr show" || args.length === 0)) {
      return { exitCode: 0, stdout: linuxIpAddr(n), stderr: "" };
    }
    if (bin === "ip" && args[0] === "route") {
      return {
        exitCode: 0,
        stdout: `default via 0.0.0.0 dev ${n.egressIface} proto dhcp metric 100\n# no intranet routes`,
        stderr: "",
      };
    }
    if (bin === "hostnamectl" || command === "cat /etc/os-release" || (bin === "cat" && args[0] === "/etc/os-release")) {
      if (bin === "hostnamectl") {
        return {
          exitCode: 0,
          stdout: `Static hostname: ${n.hostname}\nOperating System: Ubuntu 24.04.2 LTS\nKernel: Linux 6.8.0-41-generic\nArchitecture: x86-64`,
          stderr: "",
        };
      }
    }
    if (bin === "cat") {
      if (args[0] === "/etc/os-release") {
        return {
          exitCode: 0,
          stdout: 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nNAME="Ubuntu"\nVERSION="24.04.2 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian',
          stderr: "",
        };
      }
      if (args[0] === "NOTES.md") return { exitCode: 0, stdout: notes(device), stderr: "" };
      return noFile(device, args[0] ?? "");
    }
    if (bin === "ls") return { exitCode: 0, stdout: listing(device), stderr: "" };
    if (bin === "df") {
      return {
        exitCode: 0,
        stdout: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       1.8T  640G  1.1T  37% /",
        stderr: "",
      };
    }
    if (bin === "id") {
      return { exitCode: 0, stdout: "uid=1000(keel) gid=1000(keel) groups=1000(keel),27(sudo)", stderr: "" };
    }
    if (bin === "arch") return { exitCode: 0, stdout: "x86_64", stderr: "" };
    if (bin === "uptime") {
      return { exitCode: 0, stdout: " 01:07:00 up 14 days,  3:02,  1 user,  load average: 0.08, 0.11, 0.09", stderr: "" };
    }
    if (bin === "lsb_release") {
      return { exitCode: 0, stdout: "Distributor ID:\tUbuntu\nDescription:\tUbuntu 24.04.2 LTS\nRelease:\t24.04\nCodename:\tnoble", stderr: "" };
    }
  }

  // --- windows ---
  if (device.os === "windows") {
    if (bin === "ver") {
      return { exitCode: 0, stdout: "Microsoft Windows [Version 10.0.26100.1742]", stderr: "" };
    }
    if (bin === "systeminfo") {
      return {
        exitCode: 0,
        stdout: [
          "Host Name:                 WIN-CLOUD-GPU",
          "OS Name:                   Microsoft Windows 11 Pro",
          "OS Version:                10.0.26100 N/A Build 26100",
          "OS Manufacturer:           Microsoft Corporation",
          "System Type:               x64-based PC",
          "Network:                   Internet NAT only (no intranet IP)",
        ].join("\n"),
        stderr: "",
      };
    }
    if (bin === "ipconfig") return { exitCode: 0, stdout: windowsIpconfig(n), stderr: "" };
    if (bin === "dir") return { exitCode: 0, stdout: listing(device), stderr: "" };
    if (bin === "type") {
      if ((args[0] ?? "").toLowerCase() === "notes.txt") {
        return { exitCode: 0, stdout: notes(device), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "The system cannot find the file specified." };
    }
    if (bin === "uname") {
      if (args.includes("-s") && !args.includes("-a")) return { exitCode: 0, stdout: "Windows_NT", stderr: "" };
      if (args.includes("-m")) return { exitCode: 0, stdout: "x86_64", stderr: "" };
      if (args.length === 0) return { exitCode: 0, stdout: "Windows_NT", stderr: "" };
    }
    if (command === "uname -a" || (bin === "uname" && args.includes("-a"))) {
      return {
        exitCode: 0,
        stdout: `Windows_NT ${n.hostname} 10.0.26100 Microsoft Windows 11 Pro x86_64`,
        stderr: "",
      };
    }
    if (
      bin === "sw_vers" ||
      bin === "ifconfig" ||
      bin === "ip" ||
      bin === "cat" ||
      bin === "ls" ||
      bin === "lsb_release"
    ) {
      return notFound(device, bin);
    }
    if (bin === "arch") return { exitCode: 0, stdout: "x86_64", stderr: "" };
  }

  return notFound(device, bin || command);
}

export const LAB_DEVICES: ShellDevice[] = SEED_NODES.map((n) => ({
  name: n.name,
  slug: n.slug,
  os: n.os,
  arch: n.arch,
  locationTag: n.locationTag,
}));
