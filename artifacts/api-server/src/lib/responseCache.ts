import { createHash } from "crypto";

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  ttlMinutes: number;
  enabled: boolean;
  maxEntries: number;
}

interface CacheEntry {
  data: unknown;
  expiresAt: number;
  model: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_ENTRIES = 500;

let ttlMs = DEFAULT_TTL_MS;
let maxEntries = DEFAULT_MAX_ENTRIES;
let enabled = true;

const cache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now > v.expiresAt) cache.delete(k);
  }
}

export function hashRequest(body: {
  model: string;
  messages: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  seed?: number;
}): string {
  const { model, messages, temperature, top_p, max_tokens, stop, tools, tool_choice, seed } = body;
  const payload = JSON.stringify({ model, messages, temperature, top_p, max_tokens, stop, tools, tool_choice, seed });
  return createHash("sha256").update(payload).digest("hex").slice(0, 40);
}

export function cacheGet(key: string): unknown | null {
  if (!enabled) { misses++; return null; }
  const entry = cache.get(key);
  if (!entry) { misses++; return null; }
  if (Date.now() > entry.expiresAt) { cache.delete(key); misses++; return null; }
  hits++;
  return entry.data;
}

export function cacheSet(key: string, data: unknown, model: string): void {
  if (!enabled) return;
  if (cache.size >= maxEntries) {
    evictExpired();
    if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs, model });
}

export function cacheClear(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

export function getCacheStats(): CacheStats {
  evictExpired();
  return {
    hits,
    misses,
    size: cache.size,
    ttlMinutes: Math.round(ttlMs / 60000),
    enabled,
    maxEntries,
  };
}

export function setCacheTtl(minutes: number): void {
  ttlMs = Math.max(1, minutes) * 60 * 1000;
}

export function setCacheEnabled(e: boolean): void {
  enabled = e;
}

export function setCacheMaxEntries(n: number): void {
  maxEntries = Math.max(1, n);
}
