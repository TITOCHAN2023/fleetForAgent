import type { LocationTag, OsKind } from "./protocol";

/** Isolated pod: loopback only, NAT egress to the internet, no intranet IP. */
export type NetNode = {
  slug: string;
  name: string;
  os: OsKind;
  arch: string;
  locationTag: LocationTag;
  hostname: string;
  podId: string;
  egressIface: string;
};

/** Hub lives on the public internet (TEST-NET-3). Pods reach it only by going out. */
export const HUB = {
  slug: "keel-hub",
  name: "KEEL hub",
  host: "hub.keel",
  publicIp: "203.0.113.10",
} as const;

export const SEED_NODES: NetNode[] = [
  {
    slug: "mac-mini-home",
    name: "Mac mini",
    os: "darwin",
    arch: "arm64",
    locationTag: "home",
    hostname: "mac-mini-home",
    podId: "pod-mac",
    egressIface: "egress0",
  },
  {
    slug: "linux-colo-1",
    name: "机房 Linux",
    os: "linux",
    arch: "x86_64",
    locationTag: "colo",
    hostname: "linux-colo-1",
    podId: "pod-linux",
    egressIface: "egress0",
  },
  {
    slug: "win-cloud-gpu",
    name: "云上 Windows",
    os: "windows",
    arch: "x86_64",
    locationTag: "cloud",
    hostname: "win-cloud-gpu",
    podId: "pod-win",
    egressIface: "Internet",
  },
];

export function resolveNode(input: {
  slug: string;
  name: string;
  os: OsKind;
  arch: string;
  locationTag: string;
}): NetNode {
  const known = SEED_NODES.find((n) => n.slug === input.slug);
  if (known) return known;
  const loc: LocationTag =
    input.locationTag === "colo" || input.locationTag === "cloud" || input.locationTag === "home"
      ? input.locationTag
      : "home";
  return {
    slug: input.slug,
    name: input.name,
    os: input.os,
    arch: input.arch,
    locationTag: loc,
    hostname: input.slug,
    podId: `pod-${input.slug.slice(0, 12)}`,
    egressIface: input.os === "windows" ? "Internet" : "egress0",
  };
}

export function allNodes(extra: NetNode[] = []): NetNode[] {
  const bySlug = new Map<string, NetNode>();
  for (const n of SEED_NODES) bySlug.set(n.slug, n);
  for (const n of extra) bySlug.set(n.slug, n);
  return [...bySlug.values()];
}

export type PingTarget =
  | { kind: "hub" }
  | { kind: "wan"; ip: string }
  | { kind: "peer"; token: string }
  | { kind: "private"; token: string }
  | { kind: "unknown"; token: string };

function isPrivateV4(token: string) {
  const m = token.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return false;
  return false;
}

export function resolvePingTarget(_from: NetNode, token: string, roster: NetNode[]): PingTarget {
  const t = token.trim().toLowerCase();
  if (!t) return { kind: "unknown", token };
  if (t === HUB.publicIp || t === HUB.host || t === "hub.keel") return { kind: "hub" };
  if (t === "8.8.8.8" || t === "1.1.1.1") return { kind: "wan", ip: token.trim() };
  if (isPrivateV4(t)) return { kind: "private", token: token.trim() };
  for (const n of roster) {
    if (t === n.hostname || t === n.slug || t === n.podId || t === `${n.slug}.keel`) {
      return { kind: "peer", token };
    }
  }
  return { kind: "unknown", token };
}
