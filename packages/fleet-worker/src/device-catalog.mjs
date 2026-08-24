const DEVICE_PREFIX = "d:";
const USER_DEVICE_PREFIX = "udi:";
const USER_DEVICE_READY_PREFIX = "udi-ready:";

export function deviceCatalogKey(deviceId) {
  return `${DEVICE_PREFIX}${deviceId}`;
}

export function userDeviceIndexPrefix(userId) {
  return `${USER_DEVICE_PREFIX}${userId}:`;
}

export function userDeviceIndexKey(userId, deviceId) {
  return `${userDeviceIndexPrefix(userId)}${deviceId}`;
}

export function userDeviceIndexReadyKey(userId) {
  return `${USER_DEVICE_READY_PREFIX}${userId}`;
}

export async function markUserDeviceIndexReady(storage, userId) {
  if (!userId) return;
  await storage.put(userDeviceIndexReadyKey(userId), true);
}

export async function rememberDeviceOwner(storage, previous, next) {
  const userId = next?.userId;
  if (!userId || previous?.userId === userId) return;
  await storage.put(userDeviceIndexKey(userId, next.id), deviceCatalogKey(next.id));
}

async function backfillUserDeviceIndex(storage, userId) {
  const all = await storage.list({ prefix: DEVICE_PREFIX });
  const rows = [...all.values()].filter((row) => row?.id && row.userId === userId);
  const index = { [userDeviceIndexReadyKey(userId)]: true };
  for (const row of rows) {
    index[userDeviceIndexKey(userId, row.id)] = deviceCatalogKey(row.id);
  }
  await storage.put(index);
  return rows;
}

export async function listCatalogDevices(storage, userId = null) {
  if (!userId) {
    return [...(await storage.list({ prefix: DEVICE_PREFIX })).values()];
  }

  const ready = await storage.get(userDeviceIndexReadyKey(userId));
  if (!ready) return backfillUserDeviceIndex(storage, userId);

  const index = await storage.list({ prefix: userDeviceIndexPrefix(userId) });
  const catalogKeys = [...index.values()].filter(
    (key) => typeof key === "string" && key.startsWith(DEVICE_PREFIX),
  );
  if (catalogKeys.length === 0) return [];
  const rows = await storage.get(catalogKeys);
  return [...rows.values()].filter((row) => row?.id && row.userId === userId);
}
