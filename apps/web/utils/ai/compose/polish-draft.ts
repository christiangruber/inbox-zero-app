import { z } from "zod";
import { getUserAboutPrompt, getWritingStylePrompt } from "@/utils/ai/helpers";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";

const MAX_DRAFT_CHARS = 20_000;
const MAX_VOICE_SAMPLES = 8;
const MAX_VOICE_SAMPLE_CHARS = 2000;

export type PolishDraftInput = {
  emailAccount: EmailAccountWithAI;
  /** What the user dictated or typed, as-is. */
  draft: string;
  /** Emails the user sent before, used only for voice. */
  voiceSamples?: string[];
  writingStyle?: string | null;
  needsSubject?: boolean;
  hasConfiguredSignature?: boolean;
};

export type PolishedDraft = { subject: string | null; body: string };

/**
 * Turns the user's own dictated or typed draft into the email they would send.
 * Unlike reply drafting, the content is fixed: the user already decided what to
 * say, so the job is wording, order and voice, and every fact and every doubt
 * in the draft has to survive.
 */
export async function aiPolishDraft({
  emailAccount,
  draft,
  voiceSamples = [],
  writingStyle = null,
  needsSubject = false,
  hasConfiguredSignature = false,
}: PolishDraftInput): Promise<PolishedDraft> {
  if (!draft.trim()) return { subject: null, body: "" };

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.PolishDraft,
  );

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Polish draft",
    modelOptions,
    promptHardening: { trust: "trusted" },
  });

  const result = await generateObject({
    ...modelOptions,
    instructions: buildPolishDraftSystemPrompt({
      needsSubject,
      hasConfiguredSignature,
    }),
    prompt: buildPolishDraftPrompt({
      draft,
      voiceSamples,
      writingStyle,
      about: emailAccount.about,
    }),
    schema: polishedDraftSchema,
  });

  return {
    subject: needsSubject ? result.object.subject.trim() || null : null,
    body: result.object.body.trim(),
  };
}

function buildPolishDraftSystemPrompt({
  needsSubject,
  hasConfiguredSignature,
}: {
  needsSubject: boolean;
  hasConfiguredSignature: boolean;
}): string {
  return `You turn an email the user dictated or typed into the email they would send. The user has already decided what to say. Your job is wording, order and voice, not content.

Keep the content exactly:
- Keep every fact, name, number, date, request, question and commitment in the draft. Add none.
- Keep every doubt. If the user says they think, believe or are not sure, the email stays just as unsure.
- Do not add promises, apologies, thanks, compliments, offers or small talk the draft does not contain.
- If a word looks misheard by dictation, choose the reading that fits the rest of the draft. Never guess a number, date or name that is not there.

Fix the form:
- Remove filler words, false starts, repetitions and spoken punctuation.
- Fix grammar and spelling, and put related points together. Lead with the main point or request when that reads naturally.
- Use short paragraphs. Keep the email as long as its content needs and no longer.
- If the draft contains a note addressed to you about the email, such as "make this shorter" or "add a greeting", follow it and leave it out of the email.

Sound like the user:
- Write in the language of the draft. Keep the form of address the draft uses, such as du or Sie and first or last name.
- Match the writing style and voice samples when they are given: sentence length, directness, formality, greeting and sign-off habits.
- Voice samples show how the user writes, not what to say. Never take facts, names or phrases from them into this email.
${
  hasConfiguredSignature
    ? "- A signature is added automatically after the email. Do not write a sign-off name, title, contact details or signature block."
    : "- Close the way the user closes in the voice samples or the draft. Without either, use a short, plain sign-off."
}

Return the polished body${needsSubject ? " and a short subject line that names the email's main point" : ", and an empty subject"}.`;
}

function buildPolishDraftPrompt({
  draft,
  voiceSamples,
  writingStyle,
  about,
}: {
  draft: string;
  voiceSamples: string[];
  writingStyle: string | null;
  about: string | null;
}): string {
  const samples = voiceSamples
    .map((sample) => sample.trim())
    .filter(Boolean)
    .slice(0, MAX_VOICE_SAMPLES)
    .map(
      (sample, index) => `<voice_sample index="${index + 1}">
${sample.slice(0, MAX_VOICE_SAMPLE_CHARS)}
</voice_sample>`,
    )
    .join("\n");

  return `${getUserAboutPrompt(about)}
${getWritingStylePrompt(writingStyle?.trim() || null)}
${samples ? `Emails the user sent before, for voice only:\n\n${samples}\n` : ""}
The user's draft:

<draft>
${draft.slice(0, MAX_DRAFT_CHARS)}
</draft>`;
}

const polishedDraftSchema = z.object({
  subject: z
    .string()
    .describe("Short subject line, or an empty string if none was asked for"),
  body: z.string().describe("The polished email body"),
});
