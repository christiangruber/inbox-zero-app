import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { aiPolishDraft } from "./polish-draft";

const { mockCreateGenerateObject, mockGenerateObject } = vi.hoisted(() => {
  const mockGenerateObject = vi.fn();
  const mockCreateGenerateObject = vi.fn(() => mockGenerateObject);
  return { mockCreateGenerateObject, mockGenerateObject };
});

vi.mock("@/utils/llms", () => ({
  createGenerateObject: mockCreateGenerateObject,
}));

vi.mock("@/utils/llms/model", () => ({
  getModel: vi.fn(() => ({
    provider: "openai",
    modelName: "test-model",
    model: {},
    providerOptions: undefined,
    fallbackModels: [],
  })),
}));

describe("aiPolishDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateObject.mockResolvedValue({
      object: { subject: "Invoice terms", body: "  Hi Sam,\n\nBody.  " },
    });
  });

  it("does not call the model for an empty draft", async () => {
    const result = await aiPolishDraft({
      emailAccount: getEmailAccount(),
      draft: "  \n ",
    });

    expect(result).toEqual({ subject: null, body: "" });
    expect(mockCreateGenerateObject).not.toHaveBeenCalled();
  });

  it("returns a subject only when one was asked for", async () => {
    const withoutSubject = await aiPolishDraft({
      emailAccount: getEmailAccount(),
      draft: "so uh hi Sam the invoice",
    });
    const withSubject = await aiPolishDraft({
      emailAccount: getEmailAccount(),
      draft: "so uh hi Sam the invoice",
      needsSubject: true,
    });

    expect(withoutSubject).toEqual({ subject: null, body: "Hi Sam,\n\nBody." });
    expect(withSubject.subject).toBe("Invoice terms");
  });

  it("sends the draft and at most eight voice samples, marked as voice only", async () => {
    await aiPolishDraft({
      emailAccount: getEmailAccount(),
      draft: "hallo Frau Beispiel wegen dem Angebot",
      voiceSamples: Array.from({ length: 10 }, (_, i) => `Sample ${i + 1}`),
    });

    const { prompt, instructions } = mockGenerateObject.mock.calls[0][0];
    expect(prompt).toContain("hallo Frau Beispiel wegen dem Angebot");
    expect(prompt).toContain("Sample 8");
    expect(prompt).not.toContain("Sample 9");
    expect(instructions).toContain("Never take facts");
    expect(mockCreateGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Polish draft" }),
    );
  });

  it("leaves the sign-off to the configured signature when there is one", async () => {
    await aiPolishDraft({
      emailAccount: getEmailAccount(),
      draft: "hi Sam quick one",
      hasConfiguredSignature: true,
    });

    expect(mockGenerateObject.mock.calls[0][0].instructions).toContain(
      "A signature is added automatically",
    );
  });
});
