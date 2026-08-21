import { v as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as require_jsx_runtime } from "../_libs/react+tanstack__react-query.mjs";
import { n as LabPanel } from "./lab-panel-BtzTN40-.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/lab-C-ozrDlb.js
var import_jsx_runtime = require_jsx_runtime();
function LabPage() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "bg-bg text-fg min-h-svh",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "flex items-center justify-between border-b border-border px-4 py-3 md:px-6",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "font-mono text-xs tracking-[0.22em] uppercase",
				children: "Keel lab"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
				to: "/",
				className: "text-sm text-muted hover:text-fg",
				children: "返回"
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mx-auto max-w-[1400px] p-4 md:p-6",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LabPanel, {})
		})]
	});
}
//#endregion
export { LabPage as component };
