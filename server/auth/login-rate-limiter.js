const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

function retryAfterSeconds(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function createLoginRateLimiter({
  capacity = DEFAULT_CAPACITY,
  refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now()
} = {}) {
  const entries = new Map();
  const refillPerMs = 1 / refillIntervalMs;

  function cleanup(at) {
    for (const [key, entry] of entries) {
      if (entry.lastSeen + idleTtlMs <= at) entries.delete(key);
    }
  }

  function consume(key) {
    const at = now();
    cleanup(at);

    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxEntries) {
        return { allowed: false, retryAfter: 60 };
      }
      entry = { tokens: capacity, updatedAt: at, lastSeen: at };
      entries.set(key, entry);
    }

    entry.tokens = Math.min(
      capacity,
      entry.tokens + (at - entry.updatedAt) * refillPerMs
    );
    entry.updatedAt = at;
    entry.lastSeen = at;

    if (entry.tokens < 1) {
      return {
        allowed: false,
        retryAfter: retryAfterSeconds((1 - entry.tokens) / refillPerMs)
      };
    }

    entry.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }

  return Object.freeze({
    consume,
    clear() {
      entries.clear();
    }
  });
}

module.exports = {
  createLoginRateLimiter
};
