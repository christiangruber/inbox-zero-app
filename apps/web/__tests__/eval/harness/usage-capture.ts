import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EvalUsageCall,
  EvalUsageCapture,
} from "@/__tests__/eval/harness/run-suite";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { subscribeToAiUsage, type AiUsageEvent } from "@/utils/usage";

const activeSample = new AsyncLocalStorage<AiUsageEvent[]>();
let subscribed = false;

/**
 * Attributes product AI usage events to the eval sample that caused them.
 * Samples run concurrently, so a plain listener could not tell them apart; the
 * async context follows each sample's calls through the product code path.
 */
export const captureAiUsage: EvalUsageCapture = async (operation) => {
  if (!subscribed) {
    subscribeToAiUsage((event) => activeSample.getStore()?.push(event));
    subscribed = true;
  }

  const events: AiUsageEvent[] = [];
  const value = await activeSample.run(events, operation);
  return { value, calls: events.map(toUsageCall) };
};

/**
 * An account that names a model must be served by it; one that names none runs
 * on the deployment default by design and has nothing to verify.
 */
export function getRequestedModel(emailAccount: EmailAccountWithAI) {
  const { aiProvider, aiModel } = emailAccount.user;
  if (!aiProvider || !aiModel) return;
  return { provider: aiProvider, model: aiModel };
}

function toUsageCall(event: AiUsageEvent): EvalUsageCall {
  return {
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    costUsd: event.providerReportedCost ?? (event.estimatedCost || null),
  };
}
