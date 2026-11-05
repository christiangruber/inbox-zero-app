import { describe, expect, it, vi } from "vitest";
import type { AiUsageEvent } from "@/utils/usage";

const listeners = vi.hoisted(() => new Set<(event: AiUsageEvent) => void>());

vi.mock("@/utils/usage", () => ({
  subscribeToAiUsage: (listener: (event: AiUsageEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

import { captureAiUsage } from "@/__tests__/eval/harness/usage-capture";

describe("captureAiUsage", () => {
  it("attributes calls to the concurrent sample that made them", async () => {
    const sample = (model: string, delayMs: number) =>
      captureAiUsage(async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        emit(model);
        return model;
      });

    const [slow, fast] = await Promise.all([
      sample("slow-model", 20),
      sample("fast-model", 1),
    ]);

    expect(slow.calls.map((call) => call.model)).toEqual(["slow-model"]);
    expect(fast.calls.map((call) => call.model)).toEqual(["fast-model"]);
  });

  it("prefers provider-reported cost and leaves unknown cost empty", async () => {
    const { calls } = await captureAiUsage(async () => {
      emit("priced", { providerReportedCost: 0.002, estimatedCost: 0.001 });
      emit("unpriced", { estimatedCost: 0 });
    });

    expect(calls.map((call) => call.costUsd)).toEqual([0.002, null]);
  });
});

function emit(model: string, overrides: Partial<AiUsageEvent> = {}) {
  const event: AiUsageEvent = {
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0.001,
    inputTokens: 10,
    label: "test",
    model,
    outputTokens: 5,
    platformCost: 0,
    provider: "aigateway",
    reasoningTokens: 0,
    totalTokens: 15,
    ...overrides,
  };
  for (const listener of listeners) listener(event);
}
