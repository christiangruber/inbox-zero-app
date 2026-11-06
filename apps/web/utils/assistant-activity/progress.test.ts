import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { createAssistantActivityTracker } from "@/utils/assistant-activity/progress";

vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn(), get: vi.fn() } }));

const logger = createScopedLogger("test");

describe("createAssistantActivityTracker", () => {
  beforeEach(() => {
    vi.mocked(redis.set).mockReset().mockResolvedValue("OK");
  });

  it("records steps in order and closes running ones when finished", async () => {
    const tracker = createAssistantActivityTracker({
      emailAccountId: "account-1",
      messageId: "message-1",
      threadId: "thread-1",
      enabled: true,
      logger,
    });

    await tracker.start("rules", "Matching…", "Rules");
    await tracker.done("rules", { tags: ["Newsletter"] });
    await tracker.start("draft", "Writing…", "Draft");
    await tracker.finish("draft");

    const [key, saved] = vi.mocked(redis.set).mock.calls.at(-1)!;
    expect(key).toBe("assistant-activity:account-1:message-1");
    expect(saved).toMatchObject({
      outcome: "draft",
      steps: [
        { key: "rules", state: "done", tags: ["Newsletter"] },
        { key: "draft", state: "done" },
      ],
    });
  });

  it("writes nothing for test runs", async () => {
    const tracker = createAssistantActivityTracker({
      emailAccountId: "account-1",
      messageId: "message-1",
      threadId: "thread-1",
      enabled: false,
      logger,
    });

    await tracker.start("rules", "Matching…", "Rules");
    await tracker.finish("sorted");

    expect(redis.set).not.toHaveBeenCalled();
  });

  it("keeps processing when a write fails", async () => {
    vi.mocked(redis.set).mockRejectedValue(new Error("redis down"));
    const tracker = createAssistantActivityTracker({
      emailAccountId: "account-1",
      messageId: "message-1",
      threadId: "thread-1",
      enabled: true,
      logger,
    });

    await expect(
      tracker.start("rules", "Matching…", "Rules"),
    ).resolves.toBeUndefined();
  });
});
