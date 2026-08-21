import type { MessageKey } from "./messages";
import { tr } from "./locale";

const SEED: Record<string, MessageKey> = {
  "mac-mini-home": "seed.mac-mini-home",
  "linux-colo-1": "seed.linux-colo-1",
  "win-cloud-gpu": "seed.win-cloud-gpu",
};

const LOC: Record<string, MessageKey> = {
  home: "loc.home",
  colo: "loc.colo",
  cloud: "loc.cloud",
};

export function deviceTitle(slug: string, fallback: string) {
  const key = SEED[slug];
  return key ? tr(key) : fallback;
}

export function locationLabel(tag: string) {
  const key = LOC[tag];
  return key ? tr(key) : tag;
}
