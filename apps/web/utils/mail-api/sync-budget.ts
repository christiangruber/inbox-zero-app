import { redis } from "@/utils/redis";
import { getEmailProviderRateLimitStateFromRedis } from "@/utils/redis/email-provider-rate-limit";

// Gmail allows 6,000 query-cost units per user per minute. Background syncing
// gets half, so opening and answering email always has room.
const BACKGROUND_UNITS_PER_MINUTE = 3000;
const WINDOW_MS = 60_000;

// Measured in Cloud Monitoring: a full-format message get costs about 60
// query-cost units, so the user's whole minute buys roughly 100 messages.
export const HYDRATION_COST_PER_MESSAGE = 60;
// One list call plus a get for each of the page's 50 messages.
export const ENUMERATION_PAGE_COST = 5 + 50 * HYDRATION_COST_PER_MESSAGE;

/**
 * Paces the background mailbox copy so it never starves interactive requests
 * (opening an email, replying) of the provider's per-user quota.
 */
export async function takeBackgroundSyncBudget(
  emailAccountId: string,
  cost: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const rateLimit = await getEmailProviderRateLimitStateFromRedis({
    emailAccountId,
  });
  if (rateLimit) {
    return {
      ok: false,
      retryAfterMs: Math.max(rateLimit.retryAt.getTime() - Date.now(), 1000),
    };
  }

  const window = Math.floor(Date.now() / WINDOW_MS);
  const key = `mail-sync-budget:${emailAccountId}:${window}`;
  const used = await redis.incrby(key, cost);
  if (used === cost) await redis.expire(key, 2 * (WINDOW_MS / 1000));
  // A single job larger than the whole budget may run alone in a fresh minute.
  if (used <= BACKGROUND_UNITS_PER_MINUTE || used === cost) return { ok: true };

  return { ok: false, retryAfterMs: (window + 1) * WINDOW_MS - Date.now() };
}

/**
 * Opening a conversation hydrates a handful of message bodies; anything else
 * (metadata for many messages at once) is the background copy filling in.
 */
export function isBackgroundHydration({
  purpose,
  keyCount,
}: {
  purpose: "metadata" | "body";
  keyCount: number;
}) {
  return purpose === "metadata" || keyCount > 10;
}
