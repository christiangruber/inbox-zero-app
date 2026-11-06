"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { writeReplyDraftBody } from "@/utils/actions/assistant-activity.validation";
import { quickDraftReplyHtml } from "@/utils/ai/reply/quick-draft";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

/**
 * Writes a reply for the open composer, whatever the rules decided for the
 * email. The composer inserts the text and saves the draft itself.
 */
export const writeReplyDraftAction = actionClient
  .metadata({ name: "writeReplyDraft" })
  .inputSchema(writeReplyDraftBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger: ctxLogger },
      parsedInput: { threadId },
    }) => {
      const logger = ctxLogger.with({ threadId });
      if (!provider) throw new SafeError("Provider not found");

      const emailAccount = await getEmailAccountForRuleExecution({
        emailAccountId,
      });
      if (!emailAccount) throw new SafeError("Email account not found");

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        const html = await quickDraftReplyHtml({
          emailAccount,
          threadId,
          provider: emailProvider,
        });
        return { html };
      } catch (error) {
        logger.error("Failed to write reply", { error });
        throw new SafeError("The assistant could not write a reply");
      }
    },
  );
