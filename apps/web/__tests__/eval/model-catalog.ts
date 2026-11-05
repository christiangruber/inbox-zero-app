import { readFileSync } from "node:fs";
import { z } from "zod";
import { getEmailAccount } from "@/__tests__/helpers";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { Provider } from "@/utils/llms/config";

/**
 * Which model is under test, and how to authenticate it. Kept free of vitest so
 * standalone eval scripts running under tsx can select a model the same way the
 * vitest matrix does.
 *
 * `apiKeyEnv` names the one variable that holds this model's key. Without it the
 * key is looked up per provider, where shared fallbacks such as LLM_API_KEY can
 * send one provider's key to another.
 */
const evalModelSchema = z.object({
  includeInAll: z.boolean().optional(),
  label: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
});

export type EvalModel = z.infer<typeof evalModelSchema>;

export const EVAL_MODEL_CATALOG: Record<string, EvalModel> = {
  "deepseek-v4-flash": {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
  },
  "gemini-3.8-flash": {
    provider: "openrouter",
    model: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
  },
  "gemini-3.1-flash-lite": {
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
  },
  "gemini-3-flash": {
    provider: "openrouter",
    model: "google/gemini-3-flash",
    label: "Gemini 3 Flash",
  },
  "gemini-2.5-flash": {
    provider: "openrouter",
    model: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
  },
  "gpt-5.4-nano": {
    provider: "openrouter",
    model: "openai/gpt-5.4-nano",
    label: "GPT-5.4 Nano",
  },
  "gpt-5.4-mini": {
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
  },
  "gpt-6-luna": {
    provider: "openrouter",
    model: "openai/gpt-6-luna",
    label: "GPT-6 Luna",
  },
  "gpt-5.6-terra": {
    provider: "openrouter",
    model: "openai/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
  },
  "claude-sonnet-5": {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
  },
  "claude-haiku-5.5": {
    provider: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    label: "Claude Haiku 5.5",
  },
  "claude-haiku-4.5": {
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
  },
  "gpt-5.6-luna-azure": {
    provider: "azure-foundry",
    model: "gpt-5.6-luna",
    label: "GPT-5.6 Luna Azure",
    includeInAll: false,
  },
  "gpt-5.6-terra-azure": {
    provider: "azure-foundry",
    model: "gpt-5.6-terra",
    label: "GPT-5.6 Terra Azure",
    includeInAll: false,
  },
  "deepseek-v4-pro-azure": {
    provider: "azure-foundry",
    model: "DeepSeek-V4-Pro",
    label: "DeepSeek V4 Pro Azure",
    includeInAll: false,
  },
  "deepseek-v4-flash-azure": {
    provider: "azure-foundry",
    model: "DeepSeek-V4-Flash",
    label: "DeepSeek V4 Flash Azure",
    includeInAll: false,
  },
  "ollama-gemma4-e2b": {
    provider: "ollama",
    model: "gemma4:e2b",
    label: "Ollama Gemma 4 E2B",
    includeInAll: false,
  },
};

/**
 * Returns the list of models to evaluate against.
 *
 * - Not set:                         single run with the default model from describeEvalMatrix
 * - EVAL_MODELS=all                  every model in the catalog
 * - EVAL_MODELS=gemini-2.5-flash     single model by shorthand
 * - EVAL_MODELS=gemini-2.5-flash,gpt-5.4-mini   comma-separated shorthand picks
 * - EVAL_MODELS=[{...}]             custom JSON array
 *
 * EVAL_MODEL_CATALOG_FILE points at a JSON object of extra shorthands, merged
 * over the built-in catalog, so a private model list (new releases, keys named
 * per model) never has to be committed.
 */
export function getEvalModels(): EvalModel[] {
  const envModels = process.env.EVAL_MODELS;
  if (!envModels) return [];
  const catalog = getEvalModelCatalog();
  if (envModels === "all") {
    return Object.entries(catalog)
      .filter(([, model]) => model.includeInAll !== false)
      .map(([, model]) => model);
  }

  if (envModels.startsWith("[")) {
    try {
      return JSON.parse(envModels);
    } catch {
      return [];
    }
  }

  return envModels
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const preset = catalog[name];
      if (!preset) {
        console.warn(
          `Unknown eval model shorthand: "${name}". Available: ${Object.keys(catalog).join(", ")}`,
        );
      }
      return preset;
    })
    .filter((m): m is EvalModel => m != null);
}

export function getEvalModelCatalog(): Record<string, EvalModel> {
  const file = process.env.EVAL_MODEL_CATALOG_FILE;
  if (!file) return EVAL_MODEL_CATALOG;

  const extra = z
    .record(z.string(), evalModelSchema)
    .parse(JSON.parse(readFileSync(file, "utf8")));
  return { ...EVAL_MODEL_CATALOG, ...extra };
}

export function getEmailAccountForModel(
  model: EvalModel,
  overrides: Partial<EmailAccountWithAI> = {},
): EmailAccountWithAI {
  return {
    ...getEmailAccount(overrides),
    user: {
      aiProvider: model.provider,
      aiModel: model.model,
      aiApiKey: getApiKeyForModel(model),
    },
  };
}

/**
 * A null key does not fail: getModel then serves the deployment default under
 * this model's label. Callers that compare models must verify the served model.
 */
export function getApiKeyForModel(model: EvalModel): string | null {
  if (model.apiKeyEnv) return process.env[model.apiKeyEnv] || null;
  return getApiKeyForProvider(model.provider);
}

function getApiKeyForProvider(provider: string): string | null {
  const keys: Record<string, string | undefined> = {
    openrouter: process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    groq: process.env.GROQ_API_KEY,
    cerebras: process.env.CEREBRAS_API_KEY,
    [Provider.AZURE_FOUNDRY]: process.env.AZURE_FOUNDRY_API_KEY,
    [Provider.AI_GATEWAY]: process.env.AI_GATEWAY_API_KEY,
    "openai-compatible": process.env.LLM_API_KEY || "not-required",
    ollama: "ollama-local",
  };
  return keys[provider] ?? null;
}
