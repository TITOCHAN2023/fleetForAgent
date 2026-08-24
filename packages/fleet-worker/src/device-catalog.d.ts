export type DeviceCatalogStorage = {
  get(key: string): Promise<unknown>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};

export type CatalogDevice = {
  id: string;
  userId?: string;
  [key: string]: unknown;
};

export function deviceCatalogKey(deviceId: string): string;
export function userDeviceIndexPrefix(userId: string): string;
export function userDeviceIndexKey(userId: string, deviceId: string): string;
export function userDeviceIndexReadyKey(userId: string): string;
export function markUserDeviceIndexReady(storage: DeviceCatalogStorage, userId: string): Promise<void>;
export function rememberDeviceOwner(
  storage: DeviceCatalogStorage,
  previous: CatalogDevice | undefined,
  next: CatalogDevice,
): Promise<void>;
export function listCatalogDevices<T extends CatalogDevice>(
  storage: DeviceCatalogStorage,
  userId?: string | null,
): Promise<T[]>;
