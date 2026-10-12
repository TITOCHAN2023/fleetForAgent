import { defineWebSocketHandler } from "h3";
import { appRoomWebSocketHooks } from "../../../src/lib/fleet/v1.server";

// Nitro production uses crossws; Vite dev uses the native upgrade hook.
export default defineWebSocketHandler(appRoomWebSocketHooks);
