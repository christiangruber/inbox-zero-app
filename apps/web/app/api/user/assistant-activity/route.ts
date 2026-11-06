import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { getAssistantActivity } from "@/utils/assistant-activity/progress";

const assistantActivityQuery = z.object({
  messageId: z.string().trim().min(1).max(512),
});

export type GetAssistantActivityResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount(
  "user/assistant-activity",
  async (request) => {
    const { messageId } = assistantActivityQuery.parse({
      messageId: new URL(request.url).searchParams.get("messageId"),
    });
    return NextResponse.json(
      await getData({ emailAccountId: request.auth.emailAccountId, messageId }),
    );
  },
);

async function getData({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}) {
  const [activity, executedRules] = await Promise.all([
    getAssistantActivity({ emailAccountId, messageId }),
    prisma.executedRule.findMany({
      where: { emailAccountId, messageId },
      orderBy: { createdAt: "asc" },
      select: {
        status: true,
        reason: true,
        createdAt: true,
        rule: { select: { name: true, systemType: true } },
        actionItems: {
          select: { type: true, draftId: true, draftModelName: true },
        },
      },
    }),
  ]);

  return {
    activity,
    executedRules: executedRules.map((executedRule) => ({
      status: executedRule.status,
      reason: executedRule.reason,
      createdAt: executedRule.createdAt,
      ruleName: executedRule.rule?.name ?? null,
      systemType: executedRule.rule?.systemType ?? null,
      draftModelName:
        executedRule.actionItems.find((action) => action.draftId)
          ?.draftModelName ?? null,
      hasDraft: executedRule.actionItems.some((action) => action.draftId),
    })),
  };
}
