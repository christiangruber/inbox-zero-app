import { describe, expect, it } from "vitest";
import {
  buildBlindPairs,
  normalizeForBlindReading,
  signTestPValue,
  tallyJudgments,
  wordEditDistance,
  type BlindPairKey,
  type PairChoice,
} from "@/__tests__/eval/harness/pairwise";
import type {
  EvalResultRecord,
  EvalRun,
} from "@/__tests__/eval/harness/run-suite";

describe("buildBlindPairs", () => {
  it("pairs only samples that passed on both sides and hides which model wrote which", () => {
    const runA = run("model-a", [
      record("case-1", "Hi Sam — net 30?", true),
      record("case-2", "Hallo", false),
    ]);
    const runB = run("model-b", [
      record("case-1", "Hi Sam, net 30?", true),
      record("case-2", "Hallo Frau Beispiel", true),
    ]);

    const { pairs, keys, excluded } = buildBlindPairs({
      runA,
      runB,
      referenceFor: () => "Hi Sam, net 30?",
      random: () => 1,
    });

    expect(pairs).toHaveLength(1);
    expect(JSON.stringify(pairs)).not.toContain("model-");
    expect(pairs[0]?.a).toBe("Hi Sam, net 30?");
    expect(pairs[0]?.b).toBe("Hi Sam - net 30?");
    expect(keys[0]?.a).toEqual({ model: "model-b", editDistance: 0 });
    expect(excluded).toEqual(["case-2#0: model-a failed"]);
  });
});

describe("normalizeForBlindReading", () => {
  it("removes typographic tells", () => {
    expect(normalizeForBlindReading("„Hallo“ – it’s ok  \n\n\n\nBest")).toBe(
      '"Hallo" - it\'s ok\n\nBest',
    );
  });
});

describe("wordEditDistance", () => {
  it("is zero for identical text and grows with edits", () => {
    expect(wordEditDistance("Hi Sam, thanks", "hi sam, thanks")).toBe(0);
    expect(wordEditDistance("Hi Sam", "Hi Ben")).toBe(0.5);
  });
});

describe("tallyJudgments", () => {
  it("declares a winner at 15 of 20 and not at 14 of 20", () => {
    expect(decisionFor(15, 5)).toBe("winner: model-a");
    expect(decisionFor(14, 6)).toMatch(/^leaning model-a/);
    expect(decisionFor(11, 9)).toMatch(/^no meaningful difference/);
    expect(decisionFor(9, 1)).toBe("winner: model-a");
    expect(decisionFor(6, 2)).toMatch(/^keep reading/);
  });

  it("matches the exact sign test thresholds", () => {
    expect(signTestPValue(15, 20)).toBeLessThanOrEqual(0.05);
    expect(signTestPValue(14, 20)).toBeGreaterThan(0.05);
    expect(signTestPValue(27, 40)).toBeLessThanOrEqual(0.05);
    expect(signTestPValue(26, 40)).toBeGreaterThan(0.05);
  });
});

function decisionFor(winsA: number, winsB: number): string | undefined {
  const keys: BlindPairKey[] = [];
  const choices = new Map<string, PairChoice>();
  for (let i = 0; i < winsA + winsB; i++) {
    const pairId = `p${i}`;
    keys.push({
      pairId,
      group: "polish-en",
      caseId: `case-${i}`,
      sampleIndex: 0,
      a: { model: "model-a", editDistance: null },
      b: { model: "model-b", editDistance: null },
    });
    choices.set(pairId, i < winsA ? "A" : "B");
  }
  return tallyJudgments({ keys, choices })[0]?.decision;
}

function run(model: string, records: EvalResultRecord[]): EvalRun {
  return {
    evalName: "polish-draft",
    model,
    variantId: "baseline",
    filters: { split: "all", tags: [], caseIds: [], shard: null },
    startedAt: "2026-11-05T00:00:00.000Z",
    finishedAt: "2026-11-05T00:01:00.000Z",
    selectedCaseCount: records.length,
    codeFingerprint: "code",
    judgeProvider: null,
    judgeModel: null,
    judgeFingerprint: null,
    environmentFingerprint: "env",
    records: records.map((entry) => ({ ...entry, model })),
    historyPath: null,
  };
}

function record(
  caseId: string,
  actual: string,
  pass: boolean,
): EvalResultRecord {
  return {
    evalName: "polish-draft",
    caseId,
    suite: "polish-draft",
    split: "dev",
    tags: ["polish-en"],
    difficultyAxes: ["language"],
    difficulty: "medium",
    model: "",
    variantId: "baseline",
    sampleIndex: 0,
    pass,
    sendReady: pass,
    usability: null,
    primaryIssue: null,
    severity: null,
    confidence: null,
    assertionFailures: [],
    criteriaFailures: pass ? [] : ["keeps-doubt"],
    durationMs: 1,
    judgeReasoning: null,
    actual,
    error: null,
    sourceRoot: null,
    caseFingerprint: null,
    judgeFingerprint: null,
    environmentFingerprint: "env",
    codeFingerprint: null,
  };
}
