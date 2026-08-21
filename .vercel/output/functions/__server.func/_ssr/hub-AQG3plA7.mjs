//#region node_modules/.nitro/vite/services/ssr/assets/hub-AQG3plA7.js
function makeEnvelope(type, body = {}, corr) {
	const env = {
		v: 1,
		type,
		id: crypto.randomUUID(),
		t: Date.now(),
		body
	};
	if (corr) env.corr = corr;
	return env;
}
var TOOLS = [
	{
		name: "list_computers",
		description: "List every machine in the fleet. Returns id, name, os, location tag, and online state. Never returns IPs.",
		input: {}
	},
	{
		name: "select_computer",
		description: "Bind subsequent run calls to one device. Pass the id from list_computers.",
		input: { id: "string" }
	},
	{
		name: "run",
		description: "Execute a shell command on the currently selected device. Short commands return stdout; long commands return running + corr.",
		input: { command: "string" }
	},
	{
		name: "get_result",
		description: "Fetch a previous run by corr id.",
		input: { corr: "string" }
	}
];
var HUB = {
	slug: "keel-hub",
	name: "KEEL hub",
	overlayIp: "100.64.0.1",
	overlayName: "hub.keel"
};
var SEED_NODES = [
	{
		slug: "mac-mini-home",
		name: "Mac mini",
		os: "darwin",
		arch: "arm64",
		locationTag: "home",
		hostname: "mac-mini-home",
		overlayIp: "100.64.0.11",
		overlayName: "mac-mini-home.keel",
		lanIp: "192.168.10.12",
		lanIface: "en0",
		lanCidr: "192.168.10.0/24",
		gateway: "192.168.10.1",
		overlayIface: "utun0"
	},
	{
		slug: "linux-colo-1",
		name: "机房 Linux",
		os: "linux",
		arch: "x86_64",
		locationTag: "colo",
		hostname: "linux-colo-1",
		overlayIp: "100.64.0.21",
		overlayName: "linux-colo-1.keel",
		lanIp: "10.20.0.21",
		lanIface: "eth0",
		lanCidr: "10.20.0.0/24",
		gateway: "10.20.0.1",
		overlayIface: "keel0"
	},
	{
		slug: "win-cloud-gpu",
		name: "云上 Windows",
		os: "windows",
		arch: "x86_64",
		locationTag: "cloud",
		hostname: "win-cloud-gpu",
		overlayIp: "100.64.0.31",
		overlayName: "win-cloud-gpu.keel",
		lanIp: "10.40.0.31",
		lanIface: "Ethernet",
		lanCidr: "10.40.0.0/24",
		gateway: "10.40.0.1",
		overlayIface: "Keel Tunnel"
	}
];
var LAN_BY_SITE = {
	home: {
		cidr: "192.168.10.0/24",
		prefix: "192.168.10.",
		iface: (os) => os === "windows" ? "Ethernet" : os === "darwin" ? "en0" : "eth0"
	},
	colo: {
		cidr: "10.20.0.0/24",
		prefix: "10.20.0.",
		iface: (os) => os === "windows" ? "Ethernet" : os === "darwin" ? "en0" : "eth0"
	},
	cloud: {
		cidr: "10.40.0.0/24",
		prefix: "10.40.0.",
		iface: (os) => os === "windows" ? "Ethernet" : os === "darwin" ? "en0" : "eth0"
	}
};
function hashSlug(slug) {
	let h = 2166136261;
	for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619);
	return h >>> 0;
}
function resolveNode(input) {
	const known = SEED_NODES.find((n) => n.slug === input.slug);
	if (known) return known;
	const loc = input.locationTag === "colo" || input.locationTag === "cloud" || input.locationTag === "home" ? input.locationTag : "home";
	const site = LAN_BY_SITE[loc];
	const n = hashSlug(input.slug);
	const overlayHost = 40 + n % 200;
	const lanHost = 20 + n % 200;
	return {
		slug: input.slug,
		name: input.name,
		os: input.os,
		arch: input.arch,
		locationTag: loc,
		hostname: input.slug,
		overlayIp: `100.64.0.${overlayHost}`,
		overlayName: `${input.slug}.keel`,
		lanIp: `${site.prefix}${lanHost}`,
		lanIface: site.iface(input.os),
		lanCidr: site.cidr,
		gateway: `${site.prefix}1`,
		overlayIface: input.os === "windows" ? "Keel Tunnel" : input.os === "darwin" ? "utun0" : "keel0"
	};
}
function allNodes(extra = []) {
	const bySlug = /* @__PURE__ */ new Map();
	for (const n of SEED_NODES) bySlug.set(n.slug, n);
	for (const n of extra) bySlug.set(n.slug, n);
	return [...bySlug.values()];
}
function resolvePingTarget(from, token, roster) {
	const t = token.trim().toLowerCase();
	if (!t) return {
		kind: "unknown",
		token
	};
	if (t === HUB.overlayIp || t === HUB.overlayName || t === "hub.keel") return { kind: "hub" };
	if (t === "8.8.8.8" || t === "1.1.1.1") return {
		kind: "wan",
		ip: token.trim()
	};
	for (const n of roster) {
		if (t === n.overlayIp || t === n.overlayName || t === n.hostname || t === n.slug) return {
			kind: "overlay",
			node: n
		};
		if (t === n.lanIp) return {
			kind: "lan",
			node: n,
			sameSite: n.lanCidr === from.lanCidr
		};
	}
	return {
		kind: "unknown",
		token
	};
}
var REFUSED = [
	"rm",
	"rmdir",
	"shutdown",
	"reboot",
	"poweroff",
	"mkfs",
	"format",
	"dd",
	"diskpart",
	"mkfs.ext4"
];
function nodeOf(d) {
	return resolveNode(d);
}
function home$1(d) {
	if (d.os === "windows") return "C:\\Users\\keel";
	if (d.os === "darwin") return "/Users/keel";
	return "/home/keel";
}
function notFound(d, bin) {
	if (d.os === "windows") return {
		exitCode: 1,
		stdout: "",
		stderr: `'${bin}' is not recognized as an internal or external command,\noperable program or batch file.`
	};
	if (d.os === "darwin") return {
		exitCode: 127,
		stdout: "",
		stderr: `zsh: command not found: ${bin}`
	};
	return {
		exitCode: 127,
		stdout: "",
		stderr: `bash: ${bin}: command not found`
	};
}
function noFile(d, path) {
	if (d.os === "windows") return {
		exitCode: 1,
		stdout: "",
		stderr: `The system cannot find the path specified.\n${path}`
	};
	return {
		exitCode: 1,
		stdout: "",
		stderr: `cat: ${path}: No such file or directory`
	};
}
function parse(raw, os) {
	const command = raw.trim();
	const parts = command.split(/\s+/).filter(Boolean);
	const binRaw = parts[0] ?? "";
	return {
		command,
		bin: os === "windows" ? binRaw.toLowerCase() : binRaw.replace(/^.*\//, ""),
		args: parts.slice(1)
	};
}
function rtt(from, kind) {
	if (kind === "hub") return from.locationTag === "home" ? 18 : from.locationTag === "colo" ? 8 : 6;
	if (kind === "lan") return 1;
	if (kind === "overlay") {
		if (from.locationTag === "home") return 14;
		if (from.locationTag === "colo") return 9;
		return 11;
	}
	return 22;
}
function pingUnix(from, hostLabel, ip, ok, ms, count) {
	if (!ok) {
		const lines = [`PING ${hostLabel} (${ip}): 56 data bytes`];
		for (let i = 0; i < count; i++) lines.push(`Request timeout for icmp_seq ${i}`);
		lines.push(`--- ${hostLabel} ping statistics ---`);
		lines.push(`${count} packets transmitted, 0 packets received, 100.0% packet loss`);
		return {
			exitCode: 1,
			stdout: lines.join("\n"),
			stderr: ""
		};
	}
	const lines = [`PING ${hostLabel} (${ip}): 56 data bytes`];
	for (let i = 0; i < count; i++) lines.push(`64 bytes from ${ip}: icmp_seq=${i} ttl=64 time=${(ms + i * .3).toFixed(1)} ms`);
	lines.push(`--- ${hostLabel} ping statistics ---`);
	lines.push(`${count} packets transmitted, ${count} packets received, 0.0% packet loss`);
	return {
		exitCode: 0,
		stdout: lines.join("\n"),
		stderr: ""
	};
}
function pingWindows(hostLabel, ip, ok, ms, count) {
	const lines = [`Pinging ${hostLabel} [${ip}] with 32 bytes of data:`];
	if (!ok) {
		for (let i = 0; i < count; i++) lines.push("Request timed out.");
		lines.push("");
		lines.push(`Ping statistics for ${ip}:`);
		lines.push(`    Packets: Sent = ${count}, Received = 0, Lost = ${count} (100% loss),`);
		return {
			exitCode: 1,
			stdout: lines.join("\n"),
			stderr: ""
		};
	}
	for (let i = 0; i < count; i++) lines.push(`Reply from ${ip}: bytes=32 time=${ms + i}ms TTL=64`);
	lines.push("");
	lines.push(`Ping statistics for ${ip}:`);
	lines.push(`    Packets: Sent = ${count}, Received = ${count}, Lost = 0 (0% loss),`);
	lines.push("Approximate round trip times in milli-seconds:");
	lines.push(`    Minimum = ${ms}ms, Maximum = ${ms + count - 1}ms, Average = ${ms}ms`);
	return {
		exitCode: 0,
		stdout: lines.join("\n"),
		stderr: ""
	};
}
function runPing(d, from, args) {
	let count = d.os === "windows" ? 4 : 1;
	const filtered = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if ((a === "-c" || a === "-n") && args[i + 1]) {
			count = Math.max(1, Math.min(8, Number(args[i + 1]) || count));
			i++;
			continue;
		}
		filtered.push(a);
	}
	const token = filtered[0];
	if (!token) return {
		exitCode: 1,
		stdout: "",
		stderr: d.os === "windows" ? "Bad parameter." : "ping: usage error: Destination address required"
	};
	const target = resolvePingTarget(from, token, allNodes());
	if (target.kind === "unknown") return {
		exitCode: 1,
		stdout: "",
		stderr: d.os === "windows" ? `Ping request could not find host ${token}. Please check the name and try again.` : `ping: cannot resolve ${token}: Unknown host`
	};
	if (target.kind === "lan" && !target.sameSite) {
		const ip = target.node.lanIp;
		return d.os === "windows" ? pingWindows(token, ip, false, 0, count) : pingUnix(from, token, ip, false, 0, count);
	}
	let ip = "";
	let label = token;
	let kind = "overlay";
	if (target.kind === "hub") {
		ip = HUB.overlayIp;
		label = HUB.overlayName;
		kind = "hub";
	} else if (target.kind === "overlay") {
		ip = target.node.overlayIp;
		label = target.node.overlayName;
		kind = "overlay";
	} else if (target.kind === "lan") {
		ip = target.node.lanIp;
		label = target.node.hostname;
		kind = "lan";
	} else {
		ip = target.ip;
		label = target.ip;
		kind = "wan";
	}
	const ms = rtt(from, kind);
	return d.os === "windows" ? pingWindows(label, ip, true, ms, count) : pingUnix(from, label, ip, true, ms, count);
}
function darwinIfconfig(n) {
	return [
		`${n.lanIface}: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500`,
		`\tinet ${n.lanIp} netmask 0xffffff00 broadcast ${n.lanCidr.replace(".0/24", ".255")}`,
		`\tether 58:55:05:aa:10:12`,
		`${n.overlayIface}: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280`,
		`\tinet ${n.overlayIp} --> ${HUB.overlayIp} netmask 0xffffff00`
	].join("\n");
}
function linuxIpAddr(n) {
	return [
		`1: lo: <LOOPBACK,UP> mtu 65536`,
		`    inet 127.0.0.1/8 scope host lo`,
		`2: ${n.lanIface}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500`,
		`    inet ${n.lanIp}/24 brd ${n.lanCidr.replace(".0/24", ".255")} scope global ${n.lanIface}`,
		`3: ${n.overlayIface}: <POINTOPOINT,UP,LOWER_UP> mtu 1280`,
		`    inet ${n.overlayIp}/24 scope global ${n.overlayIface}`
	].join("\n");
}
function windowsIpconfig(n) {
	return [
		"Windows IP Configuration",
		"",
		`Ethernet adapter ${n.lanIface}:`,
		"",
		"   Connection-specific DNS Suffix  . : cloud.internal",
		`   IPv4 Address. . . . . . . . . . . : ${n.lanIp}`,
		"   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
		`   Default Gateway . . . . . . . . . : ${n.gateway}`,
		"",
		`Unknown adapter ${n.overlayIface}:`,
		"",
		`   IPv4 Address. . . . . . . . . . . : ${n.overlayIp}`,
		"   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
		`   Default Gateway . . . . . . . . . : ${HUB.overlayIp}`
	].join("\n");
}
function listing(d) {
	if (d.os === "windows") return [
		" Volume in drive C has no label.",
		" Volume Serial Number is KEEL-WIN1",
		"",
		` Directory of ${home$1(d)}`,
		"",
		"08/21/2026  12:00 AM    <DIR>          Desktop",
		"08/21/2026  12:00 AM    <DIR>          Documents",
		"08/21/2026  12:00 AM    <DIR>          Downloads",
		"08/20/2026  09:14 AM             1,204 NOTES.txt",
		"               1 File(s)          1,204 bytes",
		"               3 Dir(s)     332,000,000,000 bytes free"
	].join("\n");
	if (d.os === "darwin") return "Desktop\nDocuments\nDownloads\nLibrary\nPictures\nNOTES.md";
	return "bin\netc\nhome\nopt\nroot\nusr\nvar\nNOTES.md";
}
function notes(d) {
	const n = nodeOf(d);
	return `keel node ${n.hostname}\nos=${d.os} overlay=${n.overlayIp} lan=${n.lanIp}`;
}
function runSimulated(device, raw) {
	const n = nodeOf(device);
	const { command, bin, args } = parse(raw, device.os);
	if (!command) return {
		exitCode: 0,
		stdout: "",
		stderr: ""
	};
	const joined = args.join(" ");
	if (REFUSED.includes(bin) || command.includes("rm -rf") || command.toLowerCase().includes("del /f") || command.toLowerCase().includes("format c:")) return {
		exitCode: 126,
		stdout: "",
		stderr: "keel: refused by device policy (destructive commands are blocked in v1)"
	};
	if (bin === "help" || bin === "keel") return {
		exitCode: 0,
		stdout: device.os === "windows" ? "KEEL Windows shell. Try: ver, hostname, whoami, dir, ipconfig, ping hub.keel, ping mac-mini-home.keel" : device.os === "darwin" ? "KEEL macOS shell. Try: uname -a, sw_vers, ifconfig, ping -c 1 linux-colo-1.keel, ping -c 1 10.20.0.21" : "KEEL Linux shell. Try: uname -a, cat /etc/os-release, ip addr, ping -c 1 win-cloud-gpu.keel",
		stderr: ""
	};
	if (bin === "echo") {
		if (device.os === "windows") {
			if (joined === "%USERPROFILE%") return {
				exitCode: 0,
				stdout: home$1(device),
				stderr: ""
			};
			if (joined === "%USERNAME%") return {
				exitCode: 0,
				stdout: "keel",
				stderr: ""
			};
			if (joined === "%OS%") return {
				exitCode: 0,
				stdout: "Windows_NT",
				stderr: ""
			};
		} else {
			if (joined === "$HOME") return {
				exitCode: 0,
				stdout: home$1(device),
				stderr: ""
			};
			if (joined === "$USER") return {
				exitCode: 0,
				stdout: "keel",
				stderr: ""
			};
		}
		return {
			exitCode: 0,
			stdout: joined,
			stderr: ""
		};
	}
	if (bin === "hostname") return {
		exitCode: 0,
		stdout: n.hostname,
		stderr: ""
	};
	if (bin === "whoami" || command === "id -un") return {
		exitCode: 0,
		stdout: device.os === "windows" ? "keel\\operator" : "keel",
		stderr: ""
	};
	if (bin === "pwd") return {
		exitCode: 0,
		stdout: home$1(device),
		stderr: ""
	};
	if (bin === "date") {
		if (device.os === "windows") return {
			exitCode: 0,
			stdout: "Fri 08/21/2026",
			stderr: ""
		};
		return {
			exitCode: 0,
			stdout: "Fri Aug 21 01:07:00 UTC 2026",
			stderr: ""
		};
	}
	if (bin === "ping") return runPing(device, n, args);
	if (device.os === "darwin") {
		if (bin === "uname" || bin === "uname.exe") {
			if (args.includes("-s") && !args.includes("-a")) return {
				exitCode: 0,
				stdout: "Darwin",
				stderr: ""
			};
			if (args.includes("-m")) return {
				exitCode: 0,
				stdout: "arm64",
				stderr: ""
			};
			if (args.includes("-a") || args.length === 0 && command.includes("-a")) return {
				exitCode: 0,
				stdout: `Darwin ${n.hostname} 24.3.0 Darwin Kernel Version 24.3.0: Thu Jan  2 20:24:16 PST 2025; root:xnu-11215.81.4~3/RELEASE_ARM64_T8112 arm64`,
				stderr: ""
			};
			if (args.length === 0) return {
				exitCode: 0,
				stdout: "Darwin",
				stderr: ""
			};
		}
		if (command === "uname -a") return {
			exitCode: 0,
			stdout: `Darwin ${n.hostname} 24.3.0 Darwin Kernel Version 24.3.0: Thu Jan  2 20:24:16 PST 2025; root:xnu-11215.81.4~3/RELEASE_ARM64_T8112 arm64`,
			stderr: ""
		};
		if (bin === "sw_vers") return {
			exitCode: 0,
			stdout: "ProductName:		macOS\nProductVersion:		15.3\nBuildVersion:		24D70",
			stderr: ""
		};
		if (command === "sysctl -n hw.model" || command === "sysctl hw.model") return {
			exitCode: 0,
			stdout: "Macmini9,1",
			stderr: ""
		};
		if (command === "scutil --get ComputerName") return {
			exitCode: 0,
			stdout: n.name,
			stderr: ""
		};
		if (bin === "ifconfig") return {
			exitCode: 0,
			stdout: darwinIfconfig(n),
			stderr: ""
		};
		if (bin === "ipconfig" || bin === "ip" || bin === "ver" || bin === "systeminfo" || bin === "dir") return notFound(device, bin);
		if (bin === "ls" || command.startsWith("ls ")) return {
			exitCode: 0,
			stdout: listing(device),
			stderr: ""
		};
		if (bin === "df") return {
			exitCode: 0,
			stdout: "Filesystem     Size   Used  Avail Capacity  Mounted on\n/dev/disk3s1   494Gi  212Gi  260Gi    45%    /System/Volumes/Data",
			stderr: ""
		};
		if (bin === "cat") {
			if (args[0] === "/etc/os-release") return noFile(device, "/etc/os-release");
			if (args[0] === "NOTES.md" || args[0] === `${home$1(device)}/NOTES.md`) return {
				exitCode: 0,
				stdout: notes(device),
				stderr: ""
			};
			return noFile(device, args[0] ?? "");
		}
		if (bin === "id") return {
			exitCode: 0,
			stdout: "uid=501(keel) gid=20(staff) groups=20(staff),12(everyone)",
			stderr: ""
		};
		if (bin === "arch") return {
			exitCode: 0,
			stdout: "arm64",
			stderr: ""
		};
		if (bin === "uptime") return {
			exitCode: 0,
			stdout: "1:07  up 14 days,  3:02, 1 user, load averages: 0.08 0.11 0.09",
			stderr: ""
		};
	}
	if (device.os === "linux") {
		if (bin === "uname") {
			if (args.includes("-s") && !args.includes("-a")) return {
				exitCode: 0,
				stdout: "Linux",
				stderr: ""
			};
			if (args.includes("-m")) return {
				exitCode: 0,
				stdout: "x86_64",
				stderr: ""
			};
			if (args.length === 0) return {
				exitCode: 0,
				stdout: "Linux",
				stderr: ""
			};
		}
		if (command === "uname -a" || bin === "uname" && args.includes("-a")) return {
			exitCode: 0,
			stdout: `Linux ${n.hostname} 6.8.0-41-generic #41-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux`,
			stderr: ""
		};
		if (bin === "sw_vers" || bin === "ipconfig" || bin === "ver" || bin === "systeminfo" || bin === "dir" || bin === "ifconfig") return notFound(device, bin);
		if (bin === "ip" && (args[0] === "addr" || args.join(" ") === "addr show" || args.length === 0)) return {
			exitCode: 0,
			stdout: linuxIpAddr(n),
			stderr: ""
		};
		if (bin === "ip" && args[0] === "route") return {
			exitCode: 0,
			stdout: `default via ${n.gateway} dev ${n.lanIface}\n${n.lanCidr} dev ${n.lanIface} proto kernel src ${n.lanIp}\n100.64.0.0/24 dev ${n.overlayIface} proto kernel src ${n.overlayIp}`,
			stderr: ""
		};
		if (bin === "hostnamectl" || command === "cat /etc/os-release" || bin === "cat" && args[0] === "/etc/os-release") {
			if (bin === "hostnamectl") return {
				exitCode: 0,
				stdout: `Static hostname: ${n.hostname}\nOperating System: Ubuntu 24.04.2 LTS\nKernel: Linux 6.8.0-41-generic\nArchitecture: x86-64`,
				stderr: ""
			};
		}
		if (bin === "cat") {
			if (args[0] === "/etc/os-release") return {
				exitCode: 0,
				stdout: "PRETTY_NAME=\"Ubuntu 24.04.2 LTS\"\nNAME=\"Ubuntu\"\nVERSION=\"24.04.2 LTS (Noble Numbat)\"\nID=ubuntu\nID_LIKE=debian",
				stderr: ""
			};
			if (args[0] === "NOTES.md") return {
				exitCode: 0,
				stdout: notes(device),
				stderr: ""
			};
			return noFile(device, args[0] ?? "");
		}
		if (bin === "ls") return {
			exitCode: 0,
			stdout: listing(device),
			stderr: ""
		};
		if (bin === "df") return {
			exitCode: 0,
			stdout: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       1.8T  640G  1.1T  37% /",
			stderr: ""
		};
		if (bin === "id") return {
			exitCode: 0,
			stdout: "uid=1000(keel) gid=1000(keel) groups=1000(keel),27(sudo)",
			stderr: ""
		};
		if (bin === "arch") return {
			exitCode: 0,
			stdout: "x86_64",
			stderr: ""
		};
		if (bin === "uptime") return {
			exitCode: 0,
			stdout: " 01:07:00 up 14 days,  3:02,  1 user,  load average: 0.08, 0.11, 0.09",
			stderr: ""
		};
		if (bin === "lsb_release") return {
			exitCode: 0,
			stdout: "Distributor ID:	Ubuntu\nDescription:	Ubuntu 24.04.2 LTS\nRelease:	24.04\nCodename:	noble",
			stderr: ""
		};
	}
	if (device.os === "windows") {
		if (bin === "ver") return {
			exitCode: 0,
			stdout: "Microsoft Windows [Version 10.0.26100.1742]",
			stderr: ""
		};
		if (bin === "systeminfo") return {
			exitCode: 0,
			stdout: [
				"Host Name:                 WIN-CLOUD-GPU",
				"OS Name:                   Microsoft Windows 11 Pro",
				"OS Version:                10.0.26100 N/A Build 26100",
				"OS Manufacturer:           Microsoft Corporation",
				"System Type:               x64-based PC",
				`IP overlay:                ${n.overlayIp}`
			].join("\n"),
			stderr: ""
		};
		if (bin === "ipconfig") return {
			exitCode: 0,
			stdout: windowsIpconfig(n),
			stderr: ""
		};
		if (bin === "dir") return {
			exitCode: 0,
			stdout: listing(device),
			stderr: ""
		};
		if (bin === "type") {
			if ((args[0] ?? "").toLowerCase() === "notes.txt") return {
				exitCode: 0,
				stdout: notes(device),
				stderr: ""
			};
			return {
				exitCode: 1,
				stdout: "",
				stderr: "The system cannot find the file specified."
			};
		}
		if (bin === "uname") {
			if (args.includes("-s") && !args.includes("-a")) return {
				exitCode: 0,
				stdout: "Windows_NT",
				stderr: ""
			};
			if (args.includes("-m")) return {
				exitCode: 0,
				stdout: "x86_64",
				stderr: ""
			};
			if (args.length === 0) return {
				exitCode: 0,
				stdout: "Windows_NT",
				stderr: ""
			};
		}
		if (command === "uname -a" || bin === "uname" && args.includes("-a")) return {
			exitCode: 0,
			stdout: `Windows_NT ${n.hostname} 10.0.26100 Microsoft Windows 11 Pro x86_64`,
			stderr: ""
		};
		if (bin === "sw_vers" || bin === "ifconfig" || bin === "ip" || bin === "cat" || bin === "ls" || bin === "lsb_release") return notFound(device, bin);
		if (bin === "arch") return {
			exitCode: 0,
			stdout: "x86_64",
			stderr: ""
		};
	}
	return notFound(device, bin || command);
}
var LAB_DEVICES = SEED_NODES.map((n) => ({
	name: n.name,
	slug: n.slug,
	os: n.os,
	arch: n.arch,
	locationTag: n.locationTag
}));
function home(device) {
	return resolveNode(device).os === "windows" ? "C:\\Users\\keel" : device.os === "darwin" ? "/Users/keel" : "/home/keel";
}
function dispatchRun(opts) {
	const corr = crypto.randomUUID();
	const events = [];
	const runEnv = makeEnvelope("run", {
		command: opts.command,
		timeout_ms: 25e3,
		cwd: home(opts.device)
	}, corr);
	events.push({
		direction: "down",
		envelope: runEnv
	});
	if (!opts.online) {
		const off = makeEnvelope("result", {
			ok: false,
			error: "offline"
		}, corr);
		events.push({
			direction: "up",
			envelope: off
		});
		return {
			corr,
			status: "offline",
			exitCode: 1,
			stdout: "",
			stderr: `${opts.device.name} is offline`,
			events
		};
	}
	const result = runSimulated(opts.device, opts.command);
	if (result.stdout) events.push({
		direction: "up",
		envelope: makeEnvelope("chunk", {
			stream: "stdout",
			data: result.stdout
		}, corr)
	});
	if (result.stderr) events.push({
		direction: "up",
		envelope: makeEnvelope("chunk", {
			stream: "stderr",
			data: result.stderr
		}, corr)
	});
	events.push({
		direction: "up",
		envelope: makeEnvelope("result", {
			ok: result.exitCode === 0,
			exit_code: result.exitCode
		}, corr)
	});
	return {
		corr,
		status: result.exitCode === 0 ? "ok" : "error",
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		events
	};
}
function dispatchHello(device) {
	const node = resolveNode(device);
	const hello = makeEnvelope("hello", {
		os: device.os,
		arch: device.arch,
		hostname: node.hostname,
		overlay_ip: node.overlayIp,
		caps: ["shell"],
		agent_ver: "0.1.0"
	});
	const ok = makeEnvelope("hello_ok", {
		session_id: device.slug,
		heartbeat_s: 25
	}, hello.id);
	return [{
		direction: "up",
		envelope: hello
	}, {
		direction: "down",
		envelope: ok
	}];
}
//#endregion
export { dispatchHello as a, resolveNode as c, TOOLS as i, runSimulated as l, LAB_DEVICES as n, dispatchRun as o, SEED_NODES as r, makeEnvelope as s, HUB as t };
