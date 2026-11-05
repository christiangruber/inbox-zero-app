import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatLoadIssues,
  loadEvalCases,
} from "@/__tests__/eval/harness/load-cases";
import { polishDraftCaseSchema } from "@/__tests__/eval/harness/polish-draft-schema";

describe("invented polish-draft fixtures", () => {
  it("load cleanly and keep the sent email out of the model input", () => {
    const { cases, issues } = loadEvalCases({
      suite: "polish-draft",
      schema: polishDraftCaseSchema,
      roots: [path.join(import.meta.dirname, "..", "fixtures", "synthetic")],
    });

    expect(formatLoadIssues(issues)).toBe("");
    expect(cases.length).toBeGreaterThan(0);
    for (const evalCase of cases) {
      if (!evalCase.sentEmail) continue;
      expect(JSON.stringify(evalCase.input)).not.toContain(
        evalCase.sentEmail.slice(0, 40),
      );
    }
  });
});
