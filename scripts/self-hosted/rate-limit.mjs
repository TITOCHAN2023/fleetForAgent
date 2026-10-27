// One process owns the Hub. Admission counters are intentionally ephemeral;
// challenge nonces and revocation remain in the application's durable storage.
export function fixedWindowLimit(limit, { now = Date.now, maxKeys = 10000 } = {}) {
  const counters = new Map();
  return {
    async limit({ key }) {
      const window = Math.floor(now() / 60000);
      let bucket = counters.get(key);
      if (!bucket || bucket.window !== window) {
        if (counters.size >= maxKeys) {
          for (const [oldKey, oldBucket] of counters) {
            if (oldBucket.window !== window) counters.delete(oldKey);
          }
        }
        if (!counters.has(key) && counters.size >= maxKeys) return { success: false };
        bucket = { window, count: 0 };
        counters.set(key, bucket);
      }
      if (bucket.count >= limit) return { success: false };
      bucket.count += 1;
      return { success: true };
    },
  };
}
