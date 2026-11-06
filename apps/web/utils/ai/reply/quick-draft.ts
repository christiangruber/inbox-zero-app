import { aiDraftReplyWithConfidence } from "@/utils/ai/reply/draft-reply";
import type { EmailAccountForDrafting } from "@/utils/ai/choose-rule/choose-args";
import { internalDateToDate, sortByInternalDate } from "@/utils/date";
import { renderEmailTextWithSafeLinks } from "@/utils/email/render-safe-links";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import prisma from "@/utils/prisma";
import { getReplyWithConfidence } from "@/utils/redis/reply";
import { getWritingStyle } from "@/utils/user/get";

/**
 * Writes a reply for the open composer in one model call: the thread plus the
 * user's writing style. The full draft pipeline also searches past mail,
 * knowledge, calendar and meetings, which takes around 30 seconds and is too
 * slow for a button. Returns editor HTML without a signature, because the
 * composer keeps its own.
 */
export async function quickDraftReplyHtml({
  emailAccount,
  threadId,
  provider,
}: {
  emailAccount: EmailAccountForDrafting;
  threadId: string;
  provider: EmailProvider;
}): Promise<string> {
  const threadMessages = (await provider.getThreadMessages(threadId)).sort(
    sortByInternalDate("asc"),
  );
  const lastMessage = threadMessages.at(-1);
  if (!lastMessage) throw new Error("The thread has no messages");

  // The automatic pipeline may already have written one for this message.
  const cached = await getReplyWithConfidence({
    emailAccountId: emailAccount.id,
    messageId: lastMessage.id,
  });
  if (cached?.reply) return toEditorHtml(cached.reply);

  const messages = threadMessages.map((message, index) => ({
    date: internalDateToDate(message.internalDate),
    threadId: message.threadId,
    ...getEmailForLLM(message, {
      maxLength: index === threadMessages.length - 1 ? 2000 : 500,
      extractReply: true,
      removeForwarded: false,
      includeLinkUrls: true,
      includeImageAltText: true,
    }),
  }));

  const [writingStyle, settings] = await Promise.all([
    getWritingStyle({ emailAccountId: emailAccount.id }),
    prisma.emailAccount.findUnique({
      where: { id: emailAccount.id },
      select: { learnedWritingStyle: true, signature: true },
    }),
  ]);

  const { reply } = await aiDraftReplyWithConfidence({
    messages,
    emailAccount: { ...emailAccount, bookingLinks: [] },
    knowledgeBaseContent: null,
    emailHistorySummary: null,
    emailHistoryContext: null,
    calendarAvailability: null,
    writingStyle,
    learnedWritingStyle: settings?.learnedWritingStyle ?? null,
    hasConfiguredSignature: !!settings?.signature?.trim(),
    mcpContext: null,
    meetingContext: null,
  });

  return toEditorHtml(reply);
}

function toEditorHtml(text: string) {
  return renderEmailTextWithSafeLinks(text.trim(), {
    allowHiddenLinks: false,
  }).replace(/\n/g, "<br>");
}
