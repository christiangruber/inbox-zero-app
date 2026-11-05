import { createHash } from "node:crypto";
import { judgeCriteria } from "@/__tests__/eval/harness/criteria-judge";
import { getJudgeIdentity } from "@/__tests__/eval/harness/judge-model";
import type { PolishDraftCase } from "@/__tests__/eval/harness/polish-draft-schema";
import {
  runEvalSuite,
  type EvalFilters,
  type EvalResultRecord,
  type EvalRun,
} from "@/__tests__/eval/harness/run-suite";
import { contentHashForCase } from "@/__tests__/eval/harness/split-lock";
import {
  captureAiUsage,
  getRequestedModel,
} from "@/__tests__/eval/harness/usage-capture";
import {
  aiPolishDraft,
  type PolishedDraft,
} from "@/utils/ai/compose/polish-draft";
import type { EmailAccountWithAI } from "@/utils/llms/types";

/**
 * Runs the shipping polish function on each case and grades the result against
 * the case's own criteria. There is no send-ready verdict here: whether a
 * polished email sounds like the user is decided by the user reading blind
 * pairs, not by a judge.
 */
export function runPolishDraftEval<
  TCase extends PolishDraftCase & { __sourceRoot?: string },
>({
  evalName,
  cases,
  emailAccount,
  model,
  variantId,
  samples,
  concurrency,
  filters,
  writeHistory,
  onRecord,
}: {
  evalName: string;
  cases: TCase[];
  emailAccount: EmailAccountWithAI;
  model: string;
  variantId?: string;
  samples?: number;
  concurrency?: number;
  filters?: EvalFilters;
  writeHistory?: boolean;
  onRecord?: (record: EvalResultRecord) => void;
}): Promise<EvalRun> {
  return runEvalSuite({
    evalName,
    cases,
    model,
    variantId,
    samples,
    concurrency,
    filters,
    writeHistory,
    onRecord,
    captureUsage: captureAiUsage,
    expectedServedModel: getRequestedModel(emailAccount),
    invoke: ({ evalCase }) =>
      aiPolishDraft({
        emailAccount: { ...emailAccount, about: evalCase.input.about },
        draft: evalCase.input.draft,
        voiceSamples: evalCase.input.voiceSamples,
        writingStyle: evalCase.input.writingStyle,
        needsSubject: evalCase.input.needsSubject,
        hasConfiguredSignature: evalCase.input.hasConfiguredSignature,
      }),
    judge: async ({ evalCase, output, signal }) => {
      const criteria = await judgeCriteria({
        inboundThread: `The user's own dictated or typed draft, which the assistant was asked to polish without changing its content:\n\n${evalCase.input.draft}`,
        draft: formatPolishedDraft(output),
        criteria: evalCase.judgeCriteria,
        groundTruth: evalCase.expectedGroundTruth,
        context: `The assistant also saw ${evalCase.input.voiceSamples.length} earlier emails by the user, for voice only.`,
        signal,
      });

      return {
        sendReady: criteria.failures.length === 0,
        usability: null,
        primaryIssue: null,
        severity: criticalFailures(evalCase, criteria.failures).length
          ? "critical"
          : null,
        reasoning: criteria.results
          .filter((result) => !result.pass)
          .map((result) => `${result.id}: ${result.reasoning}`)
          .join("\n"),
        criteriaFailures: criteria.failures,
      };
    },
    describeOutput: formatPolishedDraft,
    caseFingerprintOf: (evalCase) => contentHashForCase(evalCase),
    cacheFingerprintOf: (evalCase) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            case: contentHashForCase(evalCase),
            model: {
              provider: emailAccount.user.aiProvider,
              name: emailAccount.user.aiModel,
            },
          }),
        )
        .digest("hex"),
    judgeIdentity: getJudgeIdentity(),
  });
}

export function formatPolishedDraft(output: PolishedDraft): string {
  return output.subject
    ? `Subject: ${output.subject}\n\n${output.body}`
    : output.body;
}

function criticalFailures(evalCase: PolishDraftCase, failures: string[]) {
  const critical = new Set(
    evalCase.judgeCriteria
      .filter((criterion) => criterion.critical)
      .map((criterion) => criterion.id),
  );
  return failures.filter((id) => critical.has(id));
}
