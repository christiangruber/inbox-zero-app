import { describe, expect, it } from "vitest";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import {
  formatLoadIssues,
  getEvalDataDirs,
  loadEvalCases,
} from "@/__tests__/eval/harness/load-cases";
import { runPolishDraftEval } from "@/__tests__/eval/harness/polish-draft-run";
import { polishDraftCaseSchema } from "@/__tests__/eval/harness/polish-draft-schema";
import {
  buildEvalReport,
  printEvalReport,
} from "@/__tests__/eval/harness/report";
import {
  checkSplitLock,
  formatSplitLockViolation,
  loadMergedSplitLock,
  SPLIT_LOCK_FILENAME,
} from "@/__tests__/eval/harness/split-lock";

// EVAL_DATA_DIRS=/path/to/datasets EVAL_MODELS=a,b pnpm test-ai eval/suites/polish-draft-data

const SUITE = "polish-draft";
const TIMEOUT_MS = 15 * 60 * 1000;

const roots = getEvalDataDirs();
const shouldRun = shouldRunEvalTests() && roots.length > 0;

if (roots.length === 0) {
  console.info(
    `[${SUITE}] skipped: no dataset roots. Set EVAL_DATA_DIRS to dataset directories, each containing a "${SUITE}/" folder of .jsonl cases.`,
  );
}

describe.runIf(shouldRun)("polish-draft data suite", () => {
  const loaded = loadEvalCases({
    suite: SUITE,
    schema: polishDraftCaseSchema,
    roots,
  });

  it("loads every case cleanly", () => {
    expect(formatLoadIssues(loaded.issues)).toBe("");
    expect(loaded.cases.length).toBeGreaterThan(0);
  });

  it("has not edited a held-out test case since it was locked", () => {
    const lock = loadMergedSplitLock(roots);
    const heldOut = loaded.cases.filter(
      (evalCase) => evalCase.split === "test",
    );

    if (Object.keys(lock).length === 0) {
      expect(
        heldOut.length === 0
          ? ""
          : `${heldOut.length} held-out cases but no ${SPLIT_LOCK_FILENAME} in any dataset root (${roots.join(", ")}). Run the dataset lock script.`,
      ).toBe("");
      return;
    }

    const { violations } = checkSplitLock({
      suite: SUITE,
      cases: loaded.cases,
      lock,
    });
    expect(violations.map(formatSplitLockViolation).join("\n")).toBe("");
  });

  describeEvalMatrix("polish-draft criteria", (model, emailAccount) => {
    it(
      "reports how often the real polish function keeps every criterion",
      async () => {
        const run = await runPolishDraftEval({
          evalName: SUITE,
          model: model.label,
          cases: loaded.cases,
          emailAccount,
        });

        printEvalReport(buildEvalReport({ run }));

        // A rate, not a threshold: which model is better is decided by blind
        // pairwise reading of the samples that passed. A run where nothing
        // was graded is a broken harness, and that does fail.
        expect(run.records.length).toBeGreaterThan(0);
        expect(
          run.records.filter((record) => record.sendReady !== null).length,
          "no sample produced a judge verdict",
        ).toBeGreaterThan(0);
      },
      TIMEOUT_MS,
    );
  });
});
