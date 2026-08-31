export type DeviceCatalogAccess = {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
};

export type DeviceCatalogStorage = DeviceCatalogAccess & {
  transaction<T>(callback: (txn: DeviceCatalogAccess) => Promise<T>): Promise<T>;
};

export type CatalogDevice = {
  id: string;
  userId?: string;
  alias?: string;
  [key: string]: unknown;
};

export const DEVICE_ALIAS_MAX_CHARS: 64;
export function normalizeDeviceAlias(value: unknown): { alias: string; key: string } | null;
export function userDeviceAliasIndexKey(userId: string, aliasKey: string): string;

export function deviceCatalogKey(deviceId: string): string;
export function userDeviceIndexPrefix(userId: string): string;
export function userDeviceIndexKey(userId: string, deviceId: string): string;
export function userDeviceIndexReadyKey(userId: string): string;
export function markUserDeviceIndexReady(storage: DeviceCatalogAccess, userId: string): Promise<void>;
export function storeCatalogDevice(
  storage: DeviceCatalogAccess,
  next: CatalogDevice,
): Promise<void>;
export function listCatalogDevices<T extends CatalogDevice>(
  storage: DeviceCatalogAccess,
  userId: string,
): Promise<T[]>;
export function resolveCatalogDevice<T extends CatalogDevice>(
  storage: DeviceCatalogAccess,
  userId: string,
  reference: unknown,
): Promise<T | null>;
export function setCatalogDeviceAlias<T extends CatalogDevice>(
  storage: DeviceCatalogStorage,
  userId: string,
  deviceId: unknown,
  value: unknown,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; status: 200; device: T }
>;
