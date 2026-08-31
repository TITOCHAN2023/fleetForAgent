import { getSql } from "../db";
import { writeDeviceAlias } from "./device-alias";

export async function setDeviceAliasForUser(userId: string, deviceId: string, alias: unknown) {
  return writeDeviceAlias(await getSql(), userId, deviceId, alias);
}
