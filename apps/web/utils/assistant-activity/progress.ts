import { z } from "zod";
import { redis } from "@/utils/redis";
import type { Logger } from "@/utils/logger";

// Long enough that the steps are still there when the user opens the email days later.
const ACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;

const stepSchema = z.object({
  key: z.enum(["rules", "decision", "draft"]),
  state: z.enum(["running", "done", "failed"]),
  doing: z.string(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  note: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

export const assistantActivitySchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  outcome: z.enum(["draft", "no-reply", "sorted", "failed"]).optional(),
  steps: z.array(stepSchema),
});

export type AssistantActivity = z.infer<typeof assistantActivitySchema>;
type StepKey = z.infer<typeof stepSchema>["key"];

export async function getAssistantActivity({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}): Promise<AssistantActivity | null> {
  const value = await redis.get(activityKey(emailAccountId, messageId));
  const parsed = assistantActivitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Records each processing step of one message as it happens, so the reader can
 * show the assistant at work. Writes are best effort: a failed write never
 * affects processing.
 */
export function createAssistantActivityTracker({
  emailAccountId,
  messageId,
  threadId,
  enabled,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  enabled: boolean;
  logger: Logger;
}) {
  const activity: AssistantActivity = {
    messageId,
    threadId,
    startedAt: Date.now(),
    steps: [],
  };
  const key = activityKey(emailAccountId, messageId);
  let writes = Promise.resolve();

  const save = () => {
    if (!enabled) return writes;
    const snapshot = structuredClone(activity);
    writes = writes
      .then(() => redis.set(key, snapshot, { ex: ACTIVITY_TTL_SECONDS }))
      .then(() => undefined)
      .catch((error) => {
        logger.warn("Failed to record assistant activity", { error });
      });
    return writes;
  };

  const update = (
    stepKey: StepKey,
    changes: Partial<z.infer<typeof stepSchema>>,
  ) => {
    const step = activity.steps.findLast((s) => s.key === stepKey);
    if (step) Object.assign(step, changes, { endedAt: Date.now() });
    return save();
  };

  return {
    start(stepKey: StepKey, doing: string, title: string) {
      activity.steps.push({
        key: stepKey,
        state: "running",
        doing,
        title,
        startedAt: Date.now(),
      });
      return save();
    },
    done(stepKey: StepKey, details: { tags?: string[]; note?: string } = {}) {
      return update(stepKey, { state: "done", ...details });
    },
    fail(stepKey: StepKey, note?: string) {
      return update(stepKey, { state: "failed", note });
    },
    finish(outcome: NonNullable<AssistantActivity["outcome"]>) {
      for (const step of activity.steps) {
        if (step.state === "running") {
          step.state = outcome === "failed" ? "failed" : "done";
          step.endedAt = Date.now();
        }
      }
      activity.outcome = outcome;
      activity.finishedAt = Date.now();
      return save();
    },
  };
}

export type AssistantActivityTracker = ReturnType<
  typeof createAssistantActivityTracker
>;

function activityKey(emailAccountId: string, messageId: string) {
  return `assistant-activity:${emailAccountId}:${messageId}`;
}
