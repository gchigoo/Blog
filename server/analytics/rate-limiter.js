function retryAfter(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

class BoundedTokenBucketLimiter {
  constructor({ capacity, refillTokens, refillIntervalMs, idleTtlMs, maxEntries, now = () => Date.now() }) {
    this.capacity = capacity;
    this.refillPerMs = refillTokens / refillIntervalMs;
    this.idleTtlMs = idleTtlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  cleanup(at = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.lastSeen + this.idleTtlMs <= at) this.entries.delete(key);
    }
  }

  consume(key) {
    const at = this.now();
    this.cleanup(at);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return { allowed: false, retryAfter: 60, reason: 'capacity' };
      entry = { tokens: this.capacity, updatedAt: at, lastSeen: at };
      this.entries.set(key, entry);
    }
    entry.tokens = Math.min(this.capacity, entry.tokens + (at - entry.updatedAt) * this.refillPerMs);
    entry.updatedAt = at;
    entry.lastSeen = at;
    if (entry.tokens < 1) {
      return { allowed: false, retryAfter: retryAfter((1 - entry.tokens) / this.refillPerMs), reason: 'rate' };
    }
    entry.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }

  clear() { this.entries.clear(); }
}

class BoundedFixedWindowLimiter {
  constructor({ limit, windowMs, maxEntries, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  cleanup(at = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= at) this.entries.delete(key);
    }
  }

  consume(key, expiresAt = null) {
    const at = this.now();
    this.cleanup(at);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return { allowed: false, retryAfter: 60, reason: 'capacity' };
      entry = { count: 0, resetAt: expiresAt || at + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) {
      return { allowed: false, retryAfter: retryAfter(entry.resetAt - at), reason: 'rate' };
    }
    entry.count += 1;
    return { allowed: true, retryAfter: 0 };
  }

  clear() { this.entries.clear(); }
}

function createAnalyticsRateLimiters({
  now = () => Date.now(),
  scheduler = { setInterval, clearInterval }
} = {}) {
  const ip = new BoundedTokenBucketLimiter({
    capacity: 40,
    refillTokens: 30,
    refillIntervalMs: 60_000,
    idleTtlMs: 10 * 60_000,
    maxEntries: 4096,
    now
  });
  const event = new BoundedFixedWindowLimiter({
    limit: 8,
    windowMs: 10 * 60_000,
    maxEntries: 8192,
    now
  });
  let timer = null;

  return Object.freeze({
    consumeIp(key) { return ip.consume(key); },
    consumeEvent(key, expiresAt) {
      return event.consume(key, Math.min(now() + 10 * 60_000, expiresAt));
    },
    start() {
      if (timer) return;
      timer = scheduler.setInterval(() => {
        const at = now();
        ip.cleanup(at);
        event.cleanup(at);
      }, 60_000);
      timer?.unref?.();
    },
    stop() {
      if (timer) scheduler.clearInterval(timer);
      timer = null;
      ip.clear();
      event.clear();
    }
  });
}

module.exports = {
  BoundedFixedWindowLimiter,
  BoundedTokenBucketLimiter,
  createAnalyticsRateLimiters
};
