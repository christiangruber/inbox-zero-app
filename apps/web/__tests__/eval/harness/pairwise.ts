import { randomInt } from "node:crypto";
import type { EvalRun } from "@/__tests__/eval/harness/run-suite";

export type BlindPair = {
  pairId: string;
  group: string;
  caseId: string;
  a: string;
  b: string;
};

export type BlindPairKey = {
  pairId: string;
  group: string;
  caseId: string;
  sampleIndex: number;
  a: { model: string; editDistance: number | null };
  b: { model: string; editDistance: number | null };
};

export type PairChoice = "A" | "B" | "tie";

export type GroupTally = {
  group: string;
  models: [string, string];
  wins: [number, number];
  ties: number;
  nonTied: number;
  pValue: number;
  decision: string;
  meanEditDistance: [number | null, number | null];
};

/**
 * Pairs two runs of the same cases for blind reading. A sample enters only if
 * both sides passed every criterion: preference must never rescue a draft that
 * broke a gate. Order is randomised per pair, and the text is normalised so
 * typographic habits (dash and quote style, blank lines) do not reveal which
 * model wrote it.
 */
export function buildBlindPairs({
  runA,
  runB,
  referenceFor = () => null,
  random = randomInt,
}: {
  runA: EvalRun;
  runB: EvalRun;
  referenceFor?: (caseId: string) => string | null;
  random?: (max: number) => number;
}): { pairs: BlindPair[]; keys: BlindPairKey[]; excluded: string[] } {
  const bySample = new Map(
    runB.records.map((record) => [
      `${record.caseId}#${record.sampleIndex}`,
      record,
    ]),
  );
  const pairs: BlindPair[] = [];
  const keys: BlindPairKey[] = [];
  const excluded: string[] = [];

  const candidates = runA.records.flatMap((left) => {
    const right = bySample.get(`${left.caseId}#${left.sampleIndex}`);
    if (!right) return [];
    if (!left.pass || !right.pass || !left.actual || !right.actual) {
      excluded.push(
        `${left.caseId}#${left.sampleIndex}: ${[
          left.pass ? null : `${runA.model} failed`,
          right.pass ? null : `${runB.model} failed`,
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
      return [];
    }
    return [{ left, right }];
  });

  shuffle(candidates, random).forEach(({ left, right }, index) => {
    const pairId = `p${String(index + 1).padStart(3, "0")}`;
    const group = left.tags[0] ?? "all";
    const reference = referenceFor(left.caseId);
    const swap = random(2) === 1;
    const first = swap ? right : left;
    const second = swap ? left : right;
    const firstModel = swap ? runB.model : runA.model;
    const secondModel = swap ? runA.model : runB.model;

    pairs.push({
      pairId,
      group,
      caseId: left.caseId,
      a: normalizeForBlindReading(first.actual ?? ""),
      b: normalizeForBlindReading(second.actual ?? ""),
    });
    keys.push({
      pairId,
      group,
      caseId: left.caseId,
      sampleIndex: left.sampleIndex,
      a: {
        model: firstModel,
        editDistance: reference
          ? wordEditDistance(first.actual ?? "", reference)
          : null,
      },
      b: {
        model: secondModel,
        editDistance: reference
          ? wordEditDistance(second.actual ?? "", reference)
          : null,
      },
    });
  });

  return { pairs, keys, excluded };
}

export function normalizeForBlindReading(text: string): string {
  return text
    .replace(/[–—]/g, "-")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Word-level edit distance divided by the longer text's word count. */
export function wordEditDistance(output: string, reference: string): number {
  const a = words(output);
  const b = words(reference);
  if (a.length === 0 && b.length === 0) return 0;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

/**
 * Applies the pre-registered rule: a winner needs an exact two-sided sign test
 * at p <= 0.05 on non-tied judgments (9 of 10, 15 of 20, 27 of 40). From 20
 * judgments, 12 to 14 is "leaning" and 11 or fewer is "no meaningful
 * difference".
 */
export function tallyJudgments({
  keys,
  choices,
}: {
  keys: BlindPairKey[];
  choices: Map<string, PairChoice>;
}): GroupTally[] {
  const groups = new Map<string, BlindPairKey[]>();
  for (const key of keys) {
    if (!choices.has(key.pairId)) continue;
    groups.set(key.group, [...(groups.get(key.group) ?? []), key]);
  }

  return [...groups.entries()].map(([group, groupKeys]) => {
    const models = [
      ...new Set(groupKeys.flatMap((key) => [key.a.model, key.b.model])),
    ].sort() as [string, string];
    const wins: [number, number] = [0, 0];
    let ties = 0;
    const distances: [number[], number[]] = [[], []];

    for (const key of groupKeys) {
      for (const side of [key.a, key.b]) {
        if (side.editDistance !== null) {
          distances[models.indexOf(side.model) as 0 | 1].push(
            side.editDistance,
          );
        }
      }
      const choice = choices.get(key.pairId);
      if (choice === "tie") {
        ties++;
        continue;
      }
      const winner = choice === "A" ? key.a.model : key.b.model;
      wins[models.indexOf(winner) as 0 | 1]++;
    }

    const nonTied = wins[0] + wins[1];
    const pValue = signTestPValue(Math.max(...wins), nonTied);
    return {
      group,
      models,
      wins,
      ties,
      nonTied,
      pValue,
      decision: decide({ wins, nonTied, pValue, models }),
      meanEditDistance: [mean(distances[0]), mean(distances[1])],
    };
  });
}

export function signTestPValue(wins: number, total: number): number {
  if (total === 0) return 1;
  let tail = 0;
  for (let k = wins; k <= total; k++) tail += binomial(total, k);
  return Math.min(1, (2 * tail) / 2 ** total);
}

function decide({
  wins,
  nonTied,
  pValue,
  models,
}: {
  wins: [number, number];
  nonTied: number;
  pValue: number;
  models: [string, string];
}): string {
  const leader = wins[0] >= wins[1] ? models[0] : models[1];
  const best = Math.max(...wins);
  if (nonTied > 0 && pValue <= 0.05) return `winner: ${leader}`;
  if (nonTied < 20) return `keep reading (${nonTied} of 20 judgments)`;
  if (best / nonTied >= 12 / 20) {
    return `leaning ${leader}: decide on cost and latency, or extend to 40`;
  }
  return "no meaningful difference: choose the cheapest model that passes the gates";
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function shuffle<T>(items: T[], random: (max: number) => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
