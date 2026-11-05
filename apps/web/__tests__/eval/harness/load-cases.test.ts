import path from "node:path";
import { describe, expect, it } from "vitest";
import { getEvalDataDirs } from "@/__tests__/eval/harness/load-cases";

describe("getEvalDataDirs", () => {
  it("keeps absolute roots whole when splitting on the platform delimiter", () => {
    const first = path.resolve("private-evals", "datasets");
    const second = path.resolve("private-evals", "overlay");

    expect(
      getEvalDataDirs({
        EVAL_DATA_DIRS: [first, second].join(path.delimiter),
      }),
    ).toEqual([first, second]);
  });

  it("treats an unset variable as no private data", () => {
    expect(getEvalDataDirs({})).toEqual([]);
  });
});
