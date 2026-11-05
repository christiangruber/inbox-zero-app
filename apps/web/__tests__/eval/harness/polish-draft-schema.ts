import { z } from "zod";
import {
  KEBAB_CASE_REGEX,
  baseEvalCaseSchema,
} from "@/__tests__/eval/harness/case-schema";

/**
 * One dictated or typed draft, the voice the polish should match, and what the
 * user actually sent. `sentEmail` is a reference for human reading and edit
 * distance only; it must never reach the model, because a model shown the
 * target text is no longer being tested on voice.
 */
export const polishDraftCaseSchema = baseEvalCaseSchema.extend({
  suite: z.literal("polish-draft"),
  input: z.object({
    draft: z.string().min(1),
    voiceSamples: z.array(z.string().min(1)).default([]),
    writingStyle: z.string().nullable().default(null),
    about: z.string().nullable().default(null),
    needsSubject: z.boolean().default(false),
    hasConfiguredSignature: z.boolean().default(false),
  }),
  sentEmail: z.string().nullable().default(null),
  /** The facts, doubts and register the polished email must keep. */
  expectedGroundTruth: z.string().min(1),
  judgeCriteria: z
    .array(
      z.object({
        id: z.string().regex(KEBAB_CASE_REGEX),
        criterion: z.string().min(1),
        /** A failed critical criterion rules the sample out of preference reading. */
        critical: z.boolean().default(false),
      }),
    )
    .default([]),
});

export type PolishDraftCase = z.infer<typeof polishDraftCaseSchema>;
