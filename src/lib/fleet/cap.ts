/** Fleet size is unbounded. Three seed boxes are a demo, not a ceiling. */
export const FLEET_CAP: number | null = null;

export function assertCanAddDevice(_currentCount: number) {
  if (FLEET_CAP !== null && _currentCount >= FLEET_CAP) {
    throw new Error(`fleet cap ${FLEET_CAP}`);
  }
}

export function makeDeviceSlug(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "node";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}
