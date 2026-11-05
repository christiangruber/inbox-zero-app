/**
 * Sends one tiny prompt through the product's text-generation path for every
 * model in EVAL_MODELS and reports which model actually answered.
 *
 * Run it before a comparison: a model whose key is missing is not rejected, it
 * is quietly served by the deployment default under its own label, and every
 * result recorded against it would describe a different model.
 *
 * Usage:
 *   EVAL_MODELS=gpt-6-luna,my-private-shorthand \
 *   EVAL_MODEL_CATALOG_FILE=/path/to/models.json \
 *   pnpm --filter inbox-zero-ai eval:check-models
 *
 * Exits non-zero if any model fails or is served by another model.
 */

import "@/__tests__/test-env";
import { captureAiUsage } from "@/__tests__/eval/harness/usage-capture";
import {
  getEmailAccountForModel,
  getEvalModels,
} from "@/__tests__/eval/model-catalog";
import { createGenerateText } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const models = getEvalModels();
  if (models.length === 0) {
    console.error("Set EVAL_MODELS to the models to check.");
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const evalModel of models) {
    const emailAccount = getEmailAccountForModel(evalModel);
    const requested = `${evalModel.provider}:${evalModel.model}`;
    const startedAt = Date.now();

    try {
      const { calls } = await captureAiUsage(async () => {
        const modelOptions = getModel(emailAccount.user);
        const generateText = createGenerateText({
          emailAccount,
          label: "Eval model check",
          modelOptions,
          promptHardening: { trust: "trusted" },
        });
        await generateText({
          model: modelOptions.model,
          prompt: "Reply with the single word OK.",
        });
      });

      const served = [
        ...new Set(calls.map((call) => `${call.provider}:${call.model}`)),
      ];
      const ok = served.length === 1 && served[0] === requested;
      if (!ok) failures++;

      const cost = calls.reduce(
        (total, call) => total + (call.costUsd ?? 0),
        0,
      );
      const unpriced = calls.some((call) => call.costUsd === null);
      console.log(
        `${ok ? "ok  " : "FAIL"} ${evalModel.label}: requested ${requested}, served ${
          served.join(", ") || "nothing recorded"
        }, ${Date.now() - startedAt} ms, cost ${
          unpriced ? "unknown" : `$${cost.toFixed(6)}`
        }`,
      );
    } catch (error) {
      failures++;
      console.log(
        `FAIL ${evalModel.label}: requested ${requested}, error ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (failures > 0) process.exitCode = 1;
}
