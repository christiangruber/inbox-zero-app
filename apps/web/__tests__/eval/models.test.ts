import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_MODEL_CATALOG,
  getEmailAccountForModel,
  getEvalModels,
} from "@/__tests__/eval/model-catalog";
import { shouldRunEvalTests } from "@/__tests__/eval/models";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("shouldRunEvalTests", () => {
  it("exposes Azure GPT-5.6 presets without duplicating them in all-model runs", () => {
    process.env.EVAL_MODELS = "gpt-5.6-luna-azure,gpt-5.6-terra-azure";

    expect(getEvalModels()).toEqual([
      {
        provider: "azure-foundry",
        model: "gpt-5.6-luna",
        label: "GPT-5.6 Luna Azure",
        includeInAll: false,
      },
      {
        provider: "azure-foundry",
        model: "gpt-5.6-terra",
        label: "GPT-5.6 Terra Azure",
        includeInAll: false,
      },
    ]);

    process.env.EVAL_MODELS = "all";

    expect(getEvalModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "openai/gpt-6-luna" }),
        expect.objectContaining({ model: "openai/gpt-5.6-terra" }),
      ]),
    );
    expect(
      getEvalModels().some(
        (model) =>
          model.provider === "azure-foundry" &&
          model.model.startsWith("gpt-5.6-"),
      ),
    ).toBe(false);
  });

  it("exposes Azure DeepSeek presets without including them in all-model runs", () => {
    process.env.EVAL_MODELS = "deepseek-v4-pro-azure";

    expect(getEvalModels()).toEqual([
      {
        provider: "azure-foundry",
        model: "DeepSeek-V4-Pro",
        label: "DeepSeek V4 Pro Azure",
        includeInAll: false,
      },
    ]);

    process.env.EVAL_MODELS = "deepseek-v4-flash-azure";

    expect(getEvalModels()).toEqual([
      {
        provider: "azure-foundry",
        model: "DeepSeek-V4-Flash",
        label: "DeepSeek V4 Flash Azure",
        includeInAll: false,
      },
    ]);

    process.env.EVAL_MODELS = "all";

    expect(
      getEvalModels().some((model) => model.model.startsWith("DeepSeek-V4-")),
    ).toBe(false);
  });

  it("allows openrouter eval presets when only LLM_API_KEY is configured", () => {
    process.env.RUN_AI_TESTS = "true";
    process.env.EVAL_MODELS = "gemini-3-flash";
    process.env.OPENROUTER_API_KEY = undefined;
    process.env.LLM_API_KEY = "shared-key";

    expect(shouldRunEvalTests()).toBe(true);
  });

  it("uses LLM_API_KEY for the selected openrouter eval model", () => {
    process.env.OPENROUTER_API_KEY = undefined;
    process.env.LLM_API_KEY = "shared-key";

    const emailAccount = getEmailAccountForModel(
      EVAL_MODEL_CATALOG["gemini-3.1-flash-lite"],
    );

    expect(emailAccount.user).toEqual({
      aiProvider: "openrouter",
      aiModel: "google/gemini-3.1-flash-lite",
      aiApiKey: "shared-key",
    });
  });

  it("passes the AI Gateway key so a gateway model is not silently swapped for the default", () => {
    process.env.AI_GATEWAY_API_KEY = "gateway-key";

    const emailAccount = getEmailAccountForModel({
      provider: "aigateway",
      model: "anthropic/claude-sonnet-5.5",
      label: "Sonnet via gateway",
    });

    expect(emailAccount.user.aiApiKey).toBe("gateway-key");
  });

  it("uses only the named key variable when a model declares one", () => {
    process.env.LLM_API_KEY = "shared-key";
    delete process.env.EU_PROVIDER_KEY;
    const model = {
      provider: "openai-compatible",
      model: "eu-model",
      label: "EU model",
      apiKeyEnv: "EU_PROVIDER_KEY",
    };

    expect(getEmailAccountForModel(model).user.aiApiKey).toBeNull();

    process.env.RUN_AI_TESTS = "true";
    process.env.EVAL_MODELS = JSON.stringify([model]);
    expect(shouldRunEvalTests()).toBe(false);

    process.env.EU_PROVIDER_KEY = "eu-key";
    expect(getEmailAccountForModel(model).user.aiApiKey).toBe("eu-key");
    expect(shouldRunEvalTests()).toBe(true);
  });

  it("merges a private catalog file over the built-in shorthands", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-catalog-"));
    const file = path.join(dir, "models.json");
    writeFileSync(
      file,
      JSON.stringify({
        "sonnet-5.5-gateway": {
          provider: "aigateway",
          model: "anthropic/claude-sonnet-5.5",
          label: "Claude Sonnet 5.5 (Gateway)",
          apiKeyEnv: "AI_GATEWAY_API_KEY",
        },
      }),
    );
    try {
      process.env.EVAL_MODEL_CATALOG_FILE = file;
      process.env.EVAL_MODELS = "sonnet-5.5-gateway,gpt-6-luna";

      expect(getEvalModels().map((model) => model.label)).toEqual([
        "Claude Sonnet 5.5 (Gateway)",
        "GPT-6 Luna",
      ]);

      writeFileSync(file, JSON.stringify({ broken: { provider: "x" } }));
      expect(() => getEvalModels()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat unrelated provider keys as valid for openrouter eval presets", () => {
    process.env.RUN_AI_TESTS = "true";
    process.env.EVAL_MODELS = "gemini-3-flash";
    process.env.OPENROUTER_API_KEY = undefined;
    process.env.LLM_API_KEY = undefined;
    process.env.OPENAI_API_KEY = "openai-key";

    expect(shouldRunEvalTests()).toBe(false);
  });

  it("uses the default provider when no eval matrix is specified", () => {
    process.env.RUN_AI_TESTS = "true";
    process.env.EVAL_MODELS = undefined;
    process.env.DEFAULT_LLMS = "openai:gpt-5.4-mini";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.LLM_API_KEY = undefined;

    expect(shouldRunEvalTests()).toBe(true);
  });
});
