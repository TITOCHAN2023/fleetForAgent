import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Never switch the user's Docker context. An explicit caller endpoint always wins.
export function dockerEnvironment() {
  const env = { ...process.env };
  const socket = path.join(os.homedir(), ".colima/default/docker.sock");
  if (
    !env.DOCKER_HOST &&
    !env.DOCKER_CONTEXT &&
    process.platform === "darwin" &&
    existsSync(socket)
  ) {
    env.DOCKER_HOST = `unix://${socket}`;
  }
  return env;
}
