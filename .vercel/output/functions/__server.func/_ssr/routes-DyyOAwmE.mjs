import { o as __toESM } from "../_runtime.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { a as require_jsx_runtime, i as useQueryClient, n as useQuery, t as useMutation } from "../_libs/react+tanstack__react-query.mjs";
import { a as getServerFnById, i as TSS_SERVER_FUNCTION, r as createServerFn } from "./ssr.mjs";
import { t as authMiddleware } from "./middleware-Bfun67SM.mjs";
import { i as TOOLS } from "./hub-AQG3plA7.mjs";
import { i as signOut } from "./client-sGid3STf.mjs";
import { n as cn, t as Button } from "./button-BNn1q7XL.mjs";
import { n as LabPanel, t as Badge } from "./lab-panel-BtzTN40-.mjs";
import { n as useCurrentUser, r as useCurrentUserState, t as LoginLanding } from "./login-landing-DiWwHxB7.mjs";
import { a as ArrowRight, i as Circle, n as Server, o as Apple, r as Monitor } from "../_libs/lucide-react.mjs";
import { n as toast } from "../_libs/sonner.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-DyyOAwmE.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var listDevices = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(createSsrRpc("aff8864b0eee3ba0f2e7ba3b4b880c6ab09f0c96667d52ae7e925bcbea533e0c"));
var selectDevice = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((id) => id).handler(createSsrRpc("17db7a4fb25efa3ca913c0069de1fd8f19ea53f4079785ac1caf2d7c4dba0f96"));
var toggleDevice = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((input) => input).handler(createSsrRpc("5f00ad34f5b9e4fc2bb1175f62b9cb6daf136b531220a9086c8b461978160164"));
var runCommand = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((command) => command).handler(createSsrRpc("0f11145a64b95525cbdd07a774bcbc7010fc3cdfce8cdfd96704248cdee8a742"));
var listCommands = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(createSsrRpc("60cac36ada08725fecf090a8e839feb4b0c05d5cb2d19cc4cf3125b92405d7eb"));
var listProtocol = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(createSsrRpc("87b4a29f8e6e052c501dc016a220fd0726665a6f36bdfeb0e5bc4ccb160e8e7e"));
var createJoinCode = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator(() => true).handler(createSsrRpc("ac2cf358f25de4570c9176d1b33257afbf607a44bdf69f9921cfd060a87606cc"));
var listJoinCodes = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(createSsrRpc("9cac52f975dc0d93a16fc6a6ad32f17793d3d904d819293f7ec1527b5a88ad8d"));
var redeemJoinCode = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((input) => input).handler(createSsrRpc("d0eda07b4b534d43d1b9fa1b0a09f5ca4ed9a682809f660b81260d6bd1e289e8"));
var LOC = {
	home: "家里",
	colo: "机房",
	cloud: "云上"
};
var OS = {
	darwin: "macOS",
	linux: "Linux",
	windows: "Windows"
};
function OsIcon({ os }) {
	if (os === "darwin") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Apple, {
		className: "size-4",
		strokeWidth: 1.75
	});
	if (os === "windows") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Monitor, {
		className: "size-4",
		strokeWidth: 1.75
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Server, {
		className: "size-4",
		strokeWidth: 1.75
	});
}
function DeviceRail({ devices, onSelect, onToggle }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
		className: "flex flex-col gap-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-baseline justify-between px-1",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "text-xs font-medium tracking-[0.18em] text-muted uppercase",
				children: "舰队"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				className: "font-mono text-xs tabular-nums text-subtle",
				children: [
					devices.filter((d) => d.status === "online").length,
					"/",
					devices.length
				]
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
			className: "flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible",
			children: devices.map((d) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: "min-w-56 flex-1 md:min-w-0 md:flex-none",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					onClick: () => onSelect(d.id),
					className: cn("w-full rounded-lg border px-3 py-3 text-left transition-[border-color,background-color] duration-150", d.selected ? "border-accent/40 bg-elevated" : "border-border bg-surface hover:border-accent/25"),
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-start justify-between gap-2",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-center gap-2 text-fg",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(OsIcon, { os: d.os }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: "text-sm font-medium",
									children: d.name
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "flex items-center gap-1 text-xs text-muted",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Circle, {
									className: cn("size-2 fill-current", d.status === "online" ? "text-ok" : "text-subtle"),
									strokeWidth: 0
								}), d.status === "online" ? "在线" : "离线"]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "mt-2 flex flex-wrap gap-1.5",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: OS[d.os] ?? d.os }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: LOC[d.locationTag] ?? d.locationTag }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									className: "font-mono",
									children: d.arch
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-2 font-mono text-xs text-subtle",
							children: [d.slug, d.overlayIp ? ` · ${d.overlayIp}` : ""]
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => onToggle(d.id, d.status === "online" ? "offline" : "online"),
					className: "mt-1 w-full px-1 text-left text-xs text-subtle hover:text-muted",
					children: d.status === "online" ? "模拟掉线" : "模拟上线"
				})]
			}, d.id))
		})]
	});
}
function Input({ className, type, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
		type,
		className: cn("flex h-11 w-full rounded-sm border border-border bg-elevated px-3 text-sm text-fg placeholder:text-subtle", "transition-[border-color,box-shadow] duration-150", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40", "disabled:cursor-not-allowed disabled:opacity-40", className),
		...props
	});
}
function ConsolePanel({ device, history, pending, onRun }) {
	const [value, setValue] = (0, import_react.useState)("");
	const [histIdx, setHistIdx] = (0, import_react.useState)(-1);
	const scroller = (0, import_react.useRef)(null);
	const inputRef = (0, import_react.useRef)(null);
	const cmds = [...history].reverse();
	const lines = [];
	if (!device) lines.push({
		id: "empty",
		kind: "sys",
		text: "没有选中的机器。从左侧选一台。"
	});
	else {
		lines.push({
			id: "banner",
			kind: "sys",
			text: `connected  ${device.slug}  ${device.os}/${device.arch}  ${device.status}${device.overlayIp ? "  " + device.overlayIp : ""}`
		});
		for (const c of cmds) {
			lines.push({
				id: `${c.id}-c`,
				kind: "cmd",
				text: c.command
			});
			if (c.stdout) lines.push({
				id: `${c.id}-o`,
				kind: "out",
				text: c.stdout
			});
			if (c.stderr) lines.push({
				id: `${c.id}-e`,
				kind: "err",
				text: c.stderr
			});
		}
	}
	(0, import_react.useEffect)(() => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lines.length, pending]);
	const past = cmds.map((c) => c.command);
	async function submit() {
		const cmd = value.trim();
		if (!cmd || pending || !device) return;
		setValue("");
		setHistIdx(-1);
		await onRun(cmd);
		inputRef.current?.focus();
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "bg-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "flex items-center justify-between border-b border-border px-4 py-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm font-medium",
					children: "控制台"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-mono text-xs text-subtle",
					children: device ? `${device.slug}${device.overlayIp ? " · " + device.overlayIp : ""}` : "unselected"
				})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "hidden text-xs text-subtle sm:block",
					children: "Enter 执行 · ↑ 历史"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				ref: scroller,
				className: "min-h-48 flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed md:min-h-0",
				children: [lines.map((l) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
					className: cn("whitespace-pre-wrap break-all", l.kind === "cmd" && "mt-3 text-accent", l.kind === "out" && "text-fg", l.kind === "err" && "text-bad", l.kind === "sys" && "text-subtle"),
					children: l.kind === "cmd" ? `▸ ${l.text}` : l.text
				}, l.id)), pending && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 animate-pulse text-subtle",
					children: "running…"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
				className: "flex gap-2 border-t border-border p-3",
				onSubmit: (e) => {
					e.preventDefault();
					submit();
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, {
					ref: inputRef,
					value,
					disabled: !device || pending,
					placeholder: device?.status === "offline" ? "设备离线" : "uname -a  ·  ping hub.keel",
					className: "font-mono",
					autoComplete: "off",
					onChange: (e) => setValue(e.target.value),
					onKeyDown: (e) => {
						if (e.key === "ArrowUp") {
							e.preventDefault();
							const next = Math.min(histIdx + 1, past.length - 1);
							if (past[past.length - 1 - next]) {
								setHistIdx(next);
								setValue(past[past.length - 1 - next]);
							}
						}
						if (e.key === "ArrowDown") {
							e.preventDefault();
							const next = histIdx - 1;
							if (next < 0) {
								setHistIdx(-1);
								setValue("");
							} else {
								setHistIdx(next);
								setValue(past[past.length - 1 - next] ?? "");
							}
						}
					}
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "submit",
					disabled: !device || pending || !value.trim(),
					className: "bg-accent text-accent-fg inline-flex size-11 shrink-0 items-center justify-center rounded-sm disabled:opacity-40",
					"aria-label": "运行",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowRight, { className: "size-4" })
				})]
			})
		]
	});
}
function pretty(raw) {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}
function ProtocolPanel({ events }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "bg-surface flex min-h-0 flex-col overflow-hidden rounded-xl border border-border",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "border-b border-border px-4 py-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-sm font-medium",
				children: "协议"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-subtle",
				children: "v1 信封 · 设备连出 WSS"
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "min-h-40 flex-1 overflow-y-auto p-3",
			children: events.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "px-1 text-xs text-subtle",
				children: "还没有报文。选一台机器跑 `uname -a`。"
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
				className: "flex flex-col gap-2",
				children: events.map((ev) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
					className: "rounded-md border border-border bg-elevated px-3 py-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center justify-between gap-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: cn("font-mono text-xs", ev.direction === "down" ? "text-accent" : "text-ok"),
							children: ev.direction === "down" ? "DO → device" : "device → DO"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "font-mono text-xs text-subtle",
							children: ev.type
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
						className: "mt-2 max-h-40 overflow-auto font-mono text-xs leading-relaxed text-muted",
						children: pretty(ev.envelope)
					})]
				}, ev.id))
			})
		})]
	});
}
var TABS = [
	{
		id: "console",
		label: "控制台"
	},
	{
		id: "lab",
		label: "验证"
	},
	{
		id: "join",
		label: "接入"
	},
	{
		id: "tools",
		label: "Agent"
	},
	{
		id: "spec",
		label: "规格"
	}
];
function FleetConsole() {
	const user = useCurrentUser();
	const qc = useQueryClient();
	const [tab, setTab] = (0, import_react.useState)("console");
	const [running, setRunning] = (0, import_react.useState)(false);
	const devicesQ = useQuery({
		queryKey: ["devices"],
		queryFn: () => listDevices(),
		refetchInterval: 4e3
	});
	const commandsQ = useQuery({
		queryKey: ["commands"],
		queryFn: () => listCommands()
	});
	const protoQ = useQuery({
		queryKey: ["protocol"],
		queryFn: () => listProtocol(),
		refetchInterval: 4e3
	});
	const codesQ = useQuery({
		queryKey: ["codes"],
		queryFn: () => listJoinCodes()
	});
	const devices = devicesQ.data ?? [];
	const selected = devices.find((d) => d.selected);
	function invalidateAll() {
		qc.invalidateQueries({ queryKey: ["devices"] });
		qc.invalidateQueries({ queryKey: ["commands"] });
		qc.invalidateQueries({ queryKey: ["protocol"] });
		qc.invalidateQueries({ queryKey: ["codes"] });
	}
	const selectMut = useMutation({
		mutationFn: (id) => selectDevice({ data: id }),
		onSuccess: invalidateAll,
		onError: (e) => toast.error(e.message)
	});
	const toggleMut = useMutation({
		mutationFn: (p) => toggleDevice({ data: p }),
		onSuccess: invalidateAll,
		onError: (e) => toast.error(e.message)
	});
	async function onRun(command) {
		setRunning(true);
		try {
			const res = await runCommand({ data: command });
			if (res.status === "offline") toast.error(res.stderr);
			invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "运行失败");
		} finally {
			setRunning(false);
		}
	}
	const label = user?.displayName ?? user?.primaryEmail ?? "Account";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "bg-bg text-fg flex min-h-svh flex-col",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "font-mono text-xs tracking-[0.22em] uppercase",
						children: "Keel"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "hidden text-xs text-subtle sm:inline",
						children: "多机统筹中枢"
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
					className: "flex flex-1 flex-wrap gap-1",
					children: TABS.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setTab(t.id),
						className: cn("rounded-sm px-3 py-2 text-sm transition-colors duration-150", tab === t.id ? "bg-elevated text-fg" : "text-muted hover:text-fg"),
						children: t.label
					}, t.id))
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "max-w-32 truncate text-sm text-muted",
						children: label
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => void signOut(),
						children: "退出"
					})]
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 p-4 md:p-6",
			children: [
				tab === "console" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid min-h-0 flex-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)_22rem] lg:items-stretch",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DeviceRail, {
							devices,
							onSelect: (id) => selectMut.mutate(id),
							onToggle: (id, status) => toggleMut.mutate({
								id,
								status
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConsolePanel, {
							device: selected,
							history: commandsQ.data ?? [],
							pending: running,
							onRun
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProtocolPanel, { events: protoQ.data ?? [] })
					]
				}),
				tab === "lab" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LabPanel, {}),
				tab === "join" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(JoinView, {
					codes: codesQ.data ?? [],
					onCreated: invalidateAll
				}),
				tab === "tools" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ToolsView, {
					devices,
					selected
				}),
				tab === "spec" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SpecView, {})
			]
		})]
	});
}
function JoinView({ codes, onCreated }) {
	const [name, setName] = (0, import_react.useState)("工作室 PC");
	const [os, setOs] = (0, import_react.useState)("linux");
	const [locationTag, setLocationTag] = (0, import_react.useState)("home");
	const [code, setCode] = (0, import_react.useState)("");
	const [busy, setBusy] = (0, import_react.useState)(false);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-6 lg:grid-cols-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-base font-medium",
					children: "一次性接入码"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted",
					children: "15 分钟有效，用过即废。设备拿它换长期钥匙，身份以服务端为准。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
					className: "mt-5",
					disabled: busy,
					onClick: async () => {
						setBusy(true);
						try {
							const r = await createJoinCode({ data: true });
							setCode(r.code);
							toast.success(`接入码 ${r.code}`);
							onCreated();
						} catch (e) {
							toast.error(e instanceof Error ? e.message : "失败");
						} finally {
							setBusy(false);
						}
					},
					children: "生成接入码"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
					className: "mt-6 space-y-2 font-mono text-sm",
					children: codes.map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "flex items-center justify-between gap-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "tracking-widest",
							children: c.code
						}), c.usedAt ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
							tone: "muted",
							children: "已用"
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
							tone: "ok",
							children: "有效"
						})]
					}, c.id))
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-base font-medium",
					children: "模拟设备接入"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted",
					children: "真机上是 daemon 连出 WSS。这里用同一套 hello / hello_ok 走一遍。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
					className: "mt-5 grid gap-3",
					onSubmit: async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							await redeemJoinCode({ data: {
								code,
								name,
								os,
								locationTag
							} });
							toast.success("设备已接入");
							onCreated();
						} catch (err) {
							toast.error(err instanceof Error ? err.message : "接入失败");
						} finally {
							setBusy(false);
						}
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
							className: "grid gap-1 text-xs text-muted",
							children: ["接入码", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, {
								value: code,
								onChange: (e) => setCode(e.target.value.toUpperCase()),
								className: "font-mono tracking-widest",
								placeholder: "ABCD2345",
								required: true
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
							className: "grid gap-1 text-xs text-muted",
							children: ["名称", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, {
								value: name,
								onChange: (e) => setName(e.target.value),
								required: true
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "grid grid-cols-2 gap-3",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
								className: "grid gap-1 text-xs text-muted",
								children: ["系统", /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
									value: os,
									onChange: (e) => setOs(e.target.value),
									className: "h-11 rounded-sm border border-border bg-elevated px-3 text-sm text-fg",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "darwin",
											children: "macOS"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "linux",
											children: "Linux"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "windows",
											children: "Windows"
										})
									]
								})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
								className: "grid gap-1 text-xs text-muted",
								children: ["位置", /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
									value: locationTag,
									onChange: (e) => setLocationTag(e.target.value),
									className: "h-11 rounded-sm border border-border bg-elevated px-3 text-sm text-fg",
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "home",
											children: "家里"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "colo",
											children: "机房"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value: "cloud",
											children: "云上"
										})
									]
								})]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							type: "submit",
							disabled: busy,
							children: "模拟接入"
						})
					]
				})
			]
		})]
	});
}
function ToolsView({ devices, selected }) {
	const payload = devices.map((d) => ({
		id: d.slug,
		name: d.name,
		os: d.os,
		where: d.locationTag,
		online: d.status === "online",
		arch: d.arch
	}));
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-4 lg:grid-cols-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-base font-medium",
					children: "Agent 只看见这四个 tool"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted",
					children: "装到 Cursor / 租来的 agent / Grok 上的就是这一份。没有 IP，没有三套操作系统 API。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", {
					className: "mt-5 space-y-3",
					children: TOOLS.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "rounded-md border border-border bg-elevated px-3 py-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-mono text-sm text-accent",
							children: t.name
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-1 text-sm text-muted",
							children: t.description
						})]
					}, t.name))
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-base font-medium",
					children: "list_computers 现在返回"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
					tone: "ok",
					children: selected ? `selected ${selected.slug}` : "unselected"
				})]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
				className: "mt-4 overflow-auto rounded-md bg-elevated p-4 font-mono text-xs leading-relaxed text-muted",
				children: JSON.stringify(payload, null, 2)
			})]
		})]
	});
}
function SpecView() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "grid gap-4 lg:grid-cols-2",
		children: [
			{
				title: "连法",
				body: "设备只连出 WSS 到 /v1/device。Authorization 放 Header，不放 URL。每台一个 Durable Object，闲置休眠，连接留在 Cloudflare 边缘。"
			},
			{
				title: "信封",
				body: "{ v:1, type, id, corr?, t, body }。控制面用文本帧，大块数据用二进制帧。第一版一台机器同时只跑一条命令。"
			},
			{
				title: "安全",
				body: "TLS 管保密。设备钥匙和 Agent 钥匙分开。一次性码换长期 token。device_id 以服务端为准。新连接踢旧连接。中枢对 run 做 Ed25519 签名。不要自造 AES 通道。"
			},
			{
				title: "假内网",
				body: "家里 192.168.10.0/24、机房 10.20.0.0/24、云 10.40.0.0/24。互访只走 100.64.0.0/24 叠加网。hub.keel 是模拟 Worker。跨站点 LAN ping 必失败。"
			},
			{
				title: "部署",
				body: "中枢之后接到 Cloudflare Durable Object。设备端是 packages/keel-daemon。预览里 Worker 是同一套信封的内存实现，不接管真机。"
			}
		].map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
			className: "rounded-xl border border-border bg-surface p-5",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "text-base font-medium",
				children: c.title
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-3 text-sm leading-relaxed text-muted",
				children: c.body
			})]
		}, c.title))
	});
}
function Home() {
	const { user } = useCurrentUserState();
	if (user) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FleetConsole, {});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoginLanding, {});
}
//#endregion
export { Home as component };
