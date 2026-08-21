import { o as __toESM } from "../_runtime.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { a as require_jsx_runtime } from "../_libs/react+tanstack__react-query.mjs";
import { a as dispatchHello, c as resolveNode, l as runSimulated, n as LAB_DEVICES, o as dispatchRun, r as SEED_NODES, t as HUB } from "./hub-AQG3plA7.mjs";
import { n as cn, t as Button } from "./button-BNn1q7XL.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/lab-panel-BtzTN40-.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function Badge({ className, tone = "muted", children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums", {
			muted: "text-muted bg-elevated border-border",
			ok: "text-ok bg-ok/10 border-ok/20",
			warn: "text-warn bg-warn/10 border-warn/20",
			bad: "text-bad bg-bad/10 border-bad/20",
			fg: "text-fg bg-elevated border-border"
		}[tone], className),
		children
	});
}
function device(os) {
	return LAB_DEVICES.find((d) => d.os === os);
}
function sh(os, cmd) {
	return runSimulated(device(os), cmd);
}
function check(id, group, title, ok, detail) {
	return {
		id,
		group,
		title,
		ok,
		detail
	};
}
function runLabSuite() {
	const checks = [];
	const macUnameS = sh("darwin", "uname -s");
	checks.push(check("d-uname-s", "darwin", "uname -s is Darwin", macUnameS.stdout.trim() === "Darwin", macUnameS.stdout || macUnameS.stderr));
	const macUnameA = sh("darwin", "uname -a");
	checks.push(check("d-uname-a", "darwin", "uname -a fingerprints mac mini arm64", macUnameA.exitCode === 0 && macUnameA.stdout.includes("Darwin") && macUnameA.stdout.includes("mac-mini-home") && macUnameA.stdout.includes("arm64") && !macUnameA.stdout.includes("Linux") && !macUnameA.stdout.includes("Windows"), macUnameA.stdout));
	const sw = sh("darwin", "sw_vers");
	checks.push(check("d-swvers", "darwin", "sw_vers reports macOS 15.3", sw.stdout.includes("macOS") && sw.stdout.includes("15.3"), sw.stdout));
	const macHome = sh("darwin", "pwd");
	checks.push(check("d-pwd", "darwin", "home is /Users/keel", macHome.stdout.trim() === "/Users/keel", macHome.stdout));
	const macWho = sh("darwin", "whoami");
	checks.push(check("d-who", "darwin", "whoami is keel", macWho.stdout.trim() === "keel", macWho.stdout));
	const macOsrel = sh("darwin", "cat /etc/os-release");
	checks.push(check("d-osrel", "darwin", "/etc/os-release does not exist", macOsrel.exitCode !== 0 && macOsrel.stderr.toLowerCase().includes("no such file"), macOsrel.stderr));
	const macIpconfig = sh("darwin", "ipconfig");
	checks.push(check("d-no-ipconfig", "darwin", "ipconfig is not a macOS command", macIpconfig.exitCode !== 0 && macIpconfig.stderr.includes("command not found"), macIpconfig.stderr));
	const macIf = sh("darwin", "ifconfig");
	const macNode = resolveNode(device("darwin"));
	checks.push(check("d-ifconfig", "darwin", "ifconfig shows en0 + utun0 overlay", macIf.stdout.includes("en0") && macIf.stdout.includes("utun0") && macIf.stdout.includes(macNode.lanIp) && macIf.stdout.includes(macNode.overlayIp), macIf.stdout));
	const macModel = sh("darwin", "sysctl -n hw.model");
	checks.push(check("d-model", "darwin", "hw.model is Macmini9,1", macModel.stdout.trim() === "Macmini9,1", macModel.stdout));
	const macLs = sh("darwin", "ls");
	checks.push(check("d-ls", "darwin", "ls includes Library", macLs.stdout.includes("Library"), macLs.stdout));
	const macVer = sh("darwin", "ver");
	checks.push(check("d-no-ver", "darwin", "ver is not a macOS command", macVer.exitCode !== 0, macVer.stderr));
	const linUnameS = sh("linux", "uname -s");
	checks.push(check("l-uname-s", "linux", "uname -s is Linux", linUnameS.stdout.trim() === "Linux", linUnameS.stdout));
	const linUnameA = sh("linux", "uname -a");
	checks.push(check("l-uname-a", "linux", "uname -a fingerprints Ubuntu colo x86_64", linUnameA.stdout.includes("Linux") && linUnameA.stdout.includes("linux-colo-1") && linUnameA.stdout.includes("x86_64") && linUnameA.stdout.includes("GNU/Linux") && !linUnameA.stdout.includes("Darwin"), linUnameA.stdout));
	const osrel = sh("linux", "cat /etc/os-release");
	checks.push(check("l-osrel", "linux", "/etc/os-release is Ubuntu 24.04", osrel.exitCode === 0 && osrel.stdout.includes("Ubuntu") && osrel.stdout.includes("24.04"), osrel.stdout));
	const linHome = sh("linux", "pwd");
	checks.push(check("l-pwd", "linux", "home is /home/keel", linHome.stdout.trim() === "/home/keel", linHome.stdout));
	const linSw = sh("linux", "sw_vers");
	checks.push(check("l-no-swvers", "linux", "sw_vers is not a Linux command", linSw.exitCode !== 0 && linSw.stderr.includes("command not found"), linSw.stderr));
	const linIpc = sh("linux", "ipconfig");
	checks.push(check("l-no-ipconfig", "linux", "ipconfig is not a Linux command", linIpc.exitCode !== 0, linIpc.stderr));
	const linIp = sh("linux", "ip addr");
	const linNode = resolveNode(device("linux"));
	checks.push(check("l-ip", "linux", "ip addr shows eth0 + keel0 overlay", linIp.stdout.includes("eth0") && linIp.stdout.includes("keel0") && linIp.stdout.includes(linNode.lanIp) && linIp.stdout.includes(linNode.overlayIp), linIp.stdout));
	const linDir = sh("linux", "dir");
	checks.push(check("l-no-dir", "linux", "dir is not a Linux command", linDir.exitCode !== 0, linDir.stderr));
	const linId = sh("linux", "id");
	checks.push(check("l-id", "linux", "id is uid=1000(keel)", linId.stdout.includes("uid=1000(keel)"), linId.stdout));
	const winVer = sh("windows", "ver");
	checks.push(check("w-ver", "windows", "ver is Windows 10.0.26100", winVer.exitCode === 0 && winVer.stdout.includes("Windows") && winVer.stdout.includes("10.0.26100"), winVer.stdout));
	const winUnameA = sh("windows", "uname -a");
	checks.push(check("w-uname-a", "windows", "uname -a fingerprints Windows_NT cloud box", winUnameA.stdout.includes("Windows_NT") && winUnameA.stdout.includes("win-cloud-gpu") && !winUnameA.stdout.includes("Darwin") && !winUnameA.stdout.includes("GNU/Linux"), winUnameA.stdout));
	const winWho = sh("windows", "whoami");
	checks.push(check("w-who", "windows", "whoami is keel\\operator", winWho.stdout.includes("keel") && winWho.stdout.includes("\\"), winWho.stdout));
	const winPwd = sh("windows", "pwd");
	checks.push(check("w-pwd", "windows", "home is C:\\Users\\keel", winPwd.stdout.includes("C:\\Users\\keel"), winPwd.stdout));
	const winSw = sh("windows", "sw_vers");
	checks.push(check("w-no-swvers", "windows", "sw_vers is not recognized", winSw.exitCode !== 0 && winSw.stderr.toLowerCase().includes("not recognized"), winSw.stderr));
	const winCat = sh("windows", "cat /etc/os-release");
	checks.push(check("w-no-cat", "windows", "cat is not a cmd builtin", winCat.exitCode !== 0 && winCat.stderr.toLowerCase().includes("not recognized"), winCat.stderr));
	const winIf = sh("windows", "ifconfig");
	checks.push(check("w-no-ifconfig", "windows", "ifconfig is not recognized", winIf.exitCode !== 0, winIf.stderr));
	const winIp = sh("windows", "ipconfig");
	const winNode = resolveNode(device("windows"));
	checks.push(check("w-ipconfig", "windows", "ipconfig shows Ethernet + overlay", winIp.stdout.includes("Ethernet") && winIp.stdout.includes(winNode.lanIp) && winIp.stdout.includes(winNode.overlayIp) && winIp.stdout.includes("Windows IP Configuration"), winIp.stdout));
	const winDir = sh("windows", "dir");
	checks.push(check("w-dir", "windows", "dir lists NOTES.txt", winDir.stdout.includes("NOTES.txt") && winDir.stdout.includes("Directory of"), winDir.stdout));
	const winSys = sh("windows", "systeminfo");
	checks.push(check("w-sys", "windows", "systeminfo is Windows 11 Pro", winSys.stdout.includes("Windows 11 Pro") && winSys.stdout.includes("26100"), winSys.stdout));
	const macPingLin = sh("darwin", "ping -c 1 linux-colo-1.keel");
	checks.push(check("n-mac-linux-overlay", "net", "Mac overlay ping to Linux succeeds", macPingLin.exitCode === 0 && macPingLin.stdout.includes("0.0% packet loss") && macPingLin.stdout.includes("100.64.0.21"), macPingLin.stdout));
	const linPingWin = sh("linux", "ping -c 1 win-cloud-gpu.keel");
	checks.push(check("n-linux-win-overlay", "net", "Linux overlay ping to Windows succeeds", linPingWin.exitCode === 0 && linPingWin.stdout.includes("100.64.0.31"), linPingWin.stdout));
	const winPingMac = sh("windows", "ping -n 1 mac-mini-home.keel");
	checks.push(check("n-win-mac-overlay", "net", "Windows overlay ping to Mac succeeds", winPingMac.exitCode === 0 && winPingMac.stdout.includes("0% loss") && winPingMac.stdout.includes("100.64.0.11"), winPingMac.stdout));
	const macPingLan = sh("darwin", "ping -c 1 10.20.0.21");
	checks.push(check("n-mac-linux-lan-blocked", "net", "Mac cannot ping Linux colo LAN (NAT)", macPingLan.exitCode !== 0 && macPingLan.stdout.includes("100.0% packet loss"), macPingLan.stdout));
	const linPingMacLan = sh("linux", "ping -c 1 192.168.10.12");
	checks.push(check("n-linux-mac-lan-blocked", "net", "Linux cannot ping home LAN", linPingMacLan.exitCode !== 0 && linPingMacLan.stdout.includes("100.0% packet loss"), linPingMacLan.stdout));
	const macHub = sh("darwin", "ping -c 1 hub.keel");
	checks.push(check("n-mac-hub", "net", "Mac can ping simulated worker hub", macHub.exitCode === 0 && macHub.stdout.includes(HUB.overlayIp), macHub.stdout));
	const linHub = sh("linux", "ping -c 1 100.64.0.1");
	checks.push(check("n-linux-hub", "net", "Linux can ping hub overlay IP", linHub.exitCode === 0, linHub.stdout));
	const winHub = sh("windows", "ping -n 1 hub.keel");
	checks.push(check("n-win-hub", "net", "Windows can ping hub.keel", winHub.exitCode === 0 && winHub.stdout.includes("0% loss"), winHub.stdout));
	const unknown = sh("linux", "ping -c 1 no-such-host.keel");
	checks.push(check("n-unknown", "net", "unknown host fails", unknown.exitCode !== 0, unknown.stderr));
	const sameLan = sh("linux", `ping -c 1 ${linNode.lanIp}`);
	checks.push(check("n-self-lan", "net", "Linux can ping its own LAN IP", sameLan.exitCode === 0, sameLan.stdout));
	for (const os of [
		"darwin",
		"linux",
		"windows"
	]) {
		const denied = sh(os, "rm -rf /");
		checks.push(check(`p-${os}-rm`, os, "destructive rm is refused", denied.exitCode === 126 && denied.stderr.includes("refused"), denied.stderr));
	}
	const hello = dispatchHello(device("linux"));
	checks.push(check("h-hello", "hub", "worker hello / hello_ok pair", hello.length === 2 && hello[0].envelope.type === "hello" && hello[1].envelope.type === "hello_ok" && hello[0].envelope.v === 1, JSON.stringify(hello.map((e) => e.envelope.type))));
	const online = dispatchRun({
		device: device("darwin"),
		online: true,
		command: "uname -s"
	});
	const types = online.events.map((e) => e.envelope.type);
	checks.push(check("h-run-mac", "hub", "worker run on Mac returns Darwin through envelopes", online.status === "ok" && online.stdout.trim() === "Darwin" && types[0] === "run" && types.includes("chunk") && types.at(-1) === "result" && online.events[0].direction === "down", `${types.join(" > ")} :: ${online.stdout}`));
	const winRun = dispatchRun({
		device: device("windows"),
		online: true,
		command: "ver"
	});
	checks.push(check("h-run-win", "hub", "worker run on Windows returns ver via hub", winRun.status === "ok" && winRun.stdout.includes("10.0.26100") && winRun.events[0].envelope.body.cwd === "C:\\Users\\keel", winRun.stdout));
	const linRun = dispatchRun({
		device: device("linux"),
		online: true,
		command: "cat /etc/os-release"
	});
	checks.push(check("h-run-lin", "hub", "worker run on Linux returns Ubuntu", linRun.status === "ok" && linRun.stdout.includes("Ubuntu"), linRun.stdout.slice(0, 180)));
	const offline = dispatchRun({
		device: device("windows"),
		online: false,
		command: "ver"
	});
	checks.push(check("h-offline", "hub", "offline device never executes shell", offline.status === "offline" && !offline.stdout.includes("Windows") && offline.events.some((e) => e.envelope.type === "result" && e.envelope.body.error === "offline"), offline.stderr));
	const cwdMac = dispatchRun({
		device: device("darwin"),
		online: true,
		command: "pwd"
	});
	checks.push(check("h-cwd-mac", "hub", "Mac run cwd is /Users/keel", String(cwdMac.events[0].envelope.body.cwd) === "/Users/keel", String(cwdMac.events[0].envelope.body.cwd)));
	const passed = checks.filter((c) => c.ok).length;
	return {
		passed,
		failed: checks.length - passed,
		checks
	};
}
function labTopology() {
	return {
		hub: HUB,
		nodes: SEED_NODES
	};
}
var GROUP_LABEL = {
	darwin: "macOS",
	linux: "Linux",
	windows: "Windows",
	net: "虚拟内网",
	hub: "模拟 Worker"
};
function LabPanel() {
	const topo = (0, import_react.useMemo)(() => labTopology(), []);
	const [result, setResult] = (0, import_react.useState)(null);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-4",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-base font-medium",
					children: "假内网"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted",
					children: "三台机器各在自己的 NAT 网段，只能通过 100.64.0.0/24 叠加网互访。Worker 是 100.64.0.1（hub.keel）。跨站点 LAN ping 必须失败。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-5 grid gap-3 md:grid-cols-4",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
						className: "rounded-lg border border-border bg-elevated p-4",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-mono text-xs tracking-[0.18em] text-muted uppercase",
								children: "Hub"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-2 text-sm font-medium",
								children: topo.hub.name
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-2 font-mono text-xs text-subtle",
								children: topo.hub.overlayName
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-mono text-xs text-subtle",
								children: topo.hub.overlayIp
							})
						]
					}), topo.nodes.map((n) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
						className: "rounded-lg border border-border bg-elevated p-4",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-mono text-xs tracking-[0.18em] text-muted uppercase",
								children: n.os
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-2 text-sm font-medium",
								children: n.name
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
								className: "mt-2 font-mono text-xs text-subtle",
								children: [
									n.overlayName,
									" · ",
									n.overlayIp
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
								className: "font-mono text-xs text-subtle",
								children: [
									n.lanIface,
									" ",
									n.lanIp,
									" · ",
									n.locationTag
								]
							})
						]
					}, n.slug))]
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap items-center justify-between gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						className: "text-base font-medium",
						children: "三系统验证"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-1 text-sm text-muted",
						children: "同一套检查：macOS / Linux / Windows 指纹、NAT、模拟 Worker 信封。"
					})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						type: "button",
						onClick: () => setResult(runLabSuite()),
						children: "跑完整验证"
					})]
				}),
				result && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-4 font-mono text-sm tabular-nums",
					children: result.failed === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "text-ok",
						children: [
							result.passed,
							" passed / ",
							result.failed,
							" failed"
						]
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "text-bad",
						children: [
							result.passed,
							" passed / ",
							result.failed,
							" failed"
						]
					})
				}),
				result && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-5 grid gap-4 lg:grid-cols-2",
					children: Object.keys(GROUP_LABEL).map((g) => {
						const rows = result.checks.filter((c) => c.group === g);
						const bad = rows.filter((c) => !c.ok).length;
						return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "rounded-lg border border-border bg-elevated p-4",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center justify-between gap-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
									className: "text-sm font-medium",
									children: GROUP_LABEL[g]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
									tone: bad ? "bad" : "ok",
									children: [
										rows.length - bad,
										"/",
										rows.length
									]
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
								className: "mt-3 space-y-2",
								children: rows.map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
									className: cn("text-sm", c.ok ? "text-fg" : "text-bad"),
									children: [
										c.ok ? "pass" : "fail",
										" · ",
										c.title
									]
								}), !c.ok && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
									className: "mt-1 max-h-24 overflow-auto font-mono text-xs text-subtle",
									children: c.detail
								})] }, c.id))
							})]
						}, g);
					})
				})
			]
		})]
	});
}
//#endregion
export { LabPanel as n, Badge as t };
