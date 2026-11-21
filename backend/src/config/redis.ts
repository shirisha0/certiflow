import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const redisPub = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

export const redisSub = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

export const VERIFY_CACHE_TTL_SECONDS = 120;

export function verifyCacheKey(certNumber: string): string {
  return `cert:verify:${certNumber.toUpperCase()}`;
}

/**
 * Cancellation tombstone. A verify request that read "valid" from Postgres *before* a cancel
 * committed could write that stale answer into the cache *after* the cancel deleted it.
 * While a tombstone exists the cache is ignored, so a cancelled certificate can never be
 * served as genuine. The TTL only needs to outlive VERIFY_CACHE_TTL_SECONDS.
 */
export const TOMBSTONE_TTL_SECONDS = 600;

export function verifyTombstoneKey(certNumber: string): string {
  return `cert:cancelled:${certNumber.toUpperCase()}`;
}
