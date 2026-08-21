import { y as Navigate } from "../_libs/@tanstack/react-router+[...].mjs";
import { a as require_jsx_runtime } from "../_libs/react+tanstack__react-query.mjs";
import { r as useCurrentUserState, t as LoginLanding } from "./login-landing-DiWwHxB7.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/login-xyvotf0t.js
var import_jsx_runtime = require_jsx_runtime();
function Login() {
	const { user } = useCurrentUserState();
	if (user) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Navigate, { to: "/" });
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoginLanding, {});
}
//#endregion
export { Login as component };
