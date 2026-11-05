/**
 * Blind pairwise reading for comparing two models on the same cases.
 *
 *   export: pairs the samples that passed every criterion in two run-history
 *           files, writes a sheet with the model names hidden and order
 *           shuffled, a judgments file to fill in, and a separate key.
 *   tally:  joins the filled-in judgments with the key and applies the
 *           pre-registered decision rule per group (the case's first tag).
 *
 * Keep the key in a different folder from the sheet and open it only after
 * every judgment is recorded.
 *
 * Usage:
 *   pnpm --filter inbox-zero-ai eval:pairwise export --a <run.json> --b <run.json> \
 *     --sheet-dir <dir> --key-dir <dir> [--suite polish-draft]
 *   pnpm --filter inbox-zero-ai eval:pairwise tally --key <key.json> --judgments <judgments.csv>
 *
 * With --suite, cases are loaded from EVAL_DATA_DIRS so each draft's word edit
 * distance to what the user actually sent (`sentEmail`) lands in the key.
 */

import "@/__tests__/test-env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEvalCases } from "@/__tests__/eval/harness/load-cases";
import {
  buildBlindPairs,
  tallyJudgments,
  type BlindPairKey,
  type PairChoice,
} from "@/__tests__/eval/harness/pairwise";
import { polishDraftCaseSchema } from "@/__tests__/eval/harness/polish-draft-schema";
import type { EvalRun } from "@/__tests__/eval/harness/run-suite";

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (command === "export") exportSheet();
else if (command === "tally") tally();
else {
  console.error("Usage: eval-pairwise export|tally ... (see file header)");
  process.exitCode = 1;
}

function exportSheet() {
  const runA = readRun(required("a"));
  const runB = readRun(required("b"));
  const references = loadReferences(args.suite);
  const { pairs, keys, excluded } = buildBlindPairs({
    runA,
    runB,
    referenceFor: (caseId) => references.get(caseId) ?? null,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sheetDir = path.resolve(required("sheet-dir"));
  const keyDir = path.resolve(required("key-dir"));
  if (sheetDir === keyDir)
    throw new Error("Keep the key apart from the sheet.");
  mkdirSync(sheetDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });

  const sheet = [
    `# Blind pairs (${pairs.length})`,
    "",
    "For each pair, ask one question: which would you send with fewer edits?",
    "Record A, B or tie in the judgments file next to this sheet.",
    ...pairs.flatMap((pair) => [
      "",
      `## ${pair.pairId} (${pair.group})`,
      "",
      "### A",
      "",
      pair.a,
      "",
      "### B",
      "",
      pair.b,
    ]),
  ].join("\n");

  const sheetFile = path.join(sheetDir, `pairs-${stamp}.md`);
  const judgmentsFile = path.join(sheetDir, `judgments-${stamp}.csv`);
  const keyFile = path.join(keyDir, `key-${stamp}.json`);
  writeFileSync(sheetFile, `${sheet}\n`);
  writeFileSync(
    judgmentsFile,
    `pair_id,choice,note\n${pairs.map((pair) => `${pair.pairId},,`).join("\n")}\n`,
  );
  writeFileSync(keyFile, `${JSON.stringify(keys, null, 2)}\n`);

  console.log(`${pairs.length} pairs written to ${sheetFile}`);
  console.log(`Fill in ${judgmentsFile}; the key is in ${keyFile}`);
  if (excluded.length > 0) {
    console.log(
      `${excluded.length} samples left out because a side failed a criterion:`,
    );
    for (const line of excluded) console.log(`  ${line}`);
  }
}

function tally() {
  const keys = JSON.parse(
    readFileSync(required("key"), "utf8"),
  ) as BlindPairKey[];
  const choices = new Map<string, PairChoice>();
  const lines = readFileSync(required("judgments"), "utf8")
    .split(/\r?\n/)
    .slice(1);
  for (const line of lines) {
    const [pairId, rawChoice] = line.split(",").map((cell) => cell.trim());
    const choice = rawChoice?.toUpperCase();
    if (!pairId || !choice) continue;
    if (choice === "A" || choice === "B") choices.set(pairId, choice);
    else if (choice === "TIE") choices.set(pairId, "tie");
    else throw new Error(`Unknown choice "${rawChoice}" for ${pairId}`);
  }

  for (const group of tallyJudgments({ keys, choices })) {
    const [first, second] = group.models;
    console.log(`\n${group.group}`);
    console.log(
      `  ${first}: ${group.wins[0]}  ${second}: ${group.wins[1]}  ties: ${group.ties}  (p = ${group.pValue.toFixed(3)})`,
    );
    if (group.meanEditDistance.some((value) => value !== null)) {
      console.log(
        `  edit distance to what was sent: ${first} ${format(group.meanEditDistance[0])}, ${second} ${format(group.meanEditDistance[1])}`,
      );
    }
    console.log(`  ${group.decision}`);
  }
}

function loadReferences(suite: string | undefined): Map<string, string> {
  if (!suite) return new Map();
  if (suite !== "polish-draft") {
    throw new Error(`No reference text is defined for suite "${suite}".`);
  }
  const { cases } = loadEvalCases({ suite, schema: polishDraftCaseSchema });
  return new Map(
    cases.flatMap((evalCase) =>
      evalCase.sentEmail ? [[evalCase.id, evalCase.sentEmail] as const] : [],
    ),
  );
}

function readRun(file: string): EvalRun {
  return JSON.parse(readFileSync(file, "utf8")) as EvalRun;
}

function required(name: string): string {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 2) {
    parsed[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  return parsed;
}

function format(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}
