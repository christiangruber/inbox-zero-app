import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { getEmailProviderRateLimitStateFromRedis } from "@/utils/redis/email-provider-rate-limit";
import {
  isBackgroundHydration,
  takeBackgroundSyncBudget,
} from "@/utils/mail-api/sync-budget";

vi.mock("@/utils/redis", () => ({
  redis: { incrby: vi.fn(), expire: vi.fn() },
}));
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  getEmailProviderRateLimitStateFromRedis: vi.fn(),
}));

describe("takeBackgroundSyncBudget", () => {
  beforeEach(() => {
    vi.mocked(redis.incrby).mockReset();
    vi.mocked(getEmailProviderRateLimitStateFromRedis).mockResolvedValue(null);
  });

  it("allows background work up to the minute's budget, then pauses until the next minute", async () => {
    vi.mocked(redis.incrby)
      .mockResolvedValueOnce(3000)
      .mockResolvedValueOnce(3260);

    await expect(takeBackgroundSyncBudget("account-1", 260)).resolves.toEqual({
      ok: true,
    });
    const paused = await takeBackgroundSyncBudget("account-1", 260);

    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.retryAfterMs).toBeGreaterThan(0);
      expect(paused.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("pauses while the provider is rate limiting the account", async () => {
    vi.mocked(getEmailProviderRateLimitStateFromRedis).mockResolvedValue({
      provider: "google",
      retryAt: new Date(Date.now() + 30_000),
    });

    const result = await takeBackgroundSyncBudget("account-1", 260);

    expect(result.ok).toBe(false);
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it("treats opening a conversation as interactive and bulk metadata as background", () => {
    expect(isBackgroundHydration({ purpose: "body", keyCount: 4 })).toBe(false);
    expect(isBackgroundHydration({ purpose: "body", keyCount: 50 })).toBe(true);
    expect(isBackgroundHydration({ purpose: "metadata", keyCount: 1 })).toBe(
      true,
    );
  });
});
