import { z } from "zod";

export const writeReplyDraftBody = z.object({
  threadId: z.string().min(1),
});
