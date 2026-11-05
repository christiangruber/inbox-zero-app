import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isCountableCase,
  type DifficultyAxis,
  type DifficultyLevel,
  type EvalCaseEnvelope,
  type EvalSplit,
} from "@/__tests__/eval/harness/case-schema";
import type { AssertionOutcome } from "@/__tests__/eval/harness/assertions";
import {
  buildCacheKey,
  getCodeFingerprint,
  readCachedRecord,
  rehydrate,
  writeCachedRecord,
} from "@/__tests__/eval/harness/result-cache";
import type { EditFailureMode } from "@/__tests__/eval/harness/taxonomy";

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 120_000;

export type EvalFilters = {
  split: EvalSplit | "all";
  tags: string[];
  caseIds: string[];
  shard: { index: number; total: number } | null;
};

export type EvalJudgeOutcome = {
  sendReady: boolean;
  usability: string | null;
  primaryIssue: EditFailureMode | null;
  severity: string | null;
  reasoning: string;
  criteriaFailures?: string[];
};

export type EvalJudgeIdentity = {
  provider: string;
  model: string;
  fingerprint: string;
};

export type EvalUsageCall = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Null when neither the provider nor the price table knows the cost. */
  costUsd: number | null;
};

/**
 * Runs one phase of a sample and returns the AI calls made inside it. Injected
 * rather than imported so this runner stays free of product code; samples run
 * concurrently, so the implementation must attribute calls by async context.
 */
export type EvalUsageCapture = <T>(
  operation: () => Promise<T>,
) => Promise<{ value: T; calls: EvalUsageCall[] }>;

export type EvalUsageSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpricedCalls: number;
  servedModels: string[];
};

export type EvalResultRecord = {
  evalName: string;
  caseId: string;
  suite: string;
  split: EvalSplit;
  tags: string[];
  difficultyAxes: DifficultyAxis[];
  difficulty: DifficultyLevel;
  model: string;
  variantId: string;
  sampleIndex: number;
  pass: boolean;
  sendReady: boolean | null;
  /**
   * send-ready / needs-fill / not-usable. Separates a draft that honestly
   * leaves a gap from one that invented the missing value; both fail
   * sendReady, but only one is safe to ship behind a placeholder strategy.
   */
  usability: string | null;
  primaryIssue: EditFailureMode | null;
  severity: string | null;
  /**
   * The drafter's own self-reported confidence. Recorded because it gates
   * whether a draft is shown at all in production, via the account's
   * draftReplyConfidence threshold. If it does not track send-readiness, that
   * threshold is not protecting anyone.
   */
  confidence: string | null;
  assertionFailures: string[];
  criteriaFailures: string[];
  durationMs: number;
  judgeReasoning: string | null;
  actual: string | null;
  error: string | null;
  sourceRoot: string | null;
  caseFingerprint: string | null;
  judgeFingerprint: string | null;
  environmentFingerprint: string;
  /**
   * Hash of the files that shape a draft, so a stored record says which build
   * produced it.
   *
   * The cache already keys on this, which stops a stale verdict being served.
   * It does not make a record self-describing: two runs of the same model under
   * different prompts land in separate cache files whose contents are identical
   * in every field, so a before/after comparison cannot be told apart
   * afterwards. Since run history goes to a gitignored directory and the cache
   * outlives it, that meant the evidence for a prompt change disappeared as
   * soon as the run ended.
   */
  codeFingerprint: string | null;
  /**
   * Optional because records written before usage capture existed, and runs
   * without a capture, have none. A cache hit carries the original run's usage.
   */
  candidateUsage?: EvalUsageSummary | null;
  judgeUsage?: EvalUsageSummary | null;
};

export type EvalRun = {
  evalName: string;
  model: string;
  variantId: string;
  filters: EvalFilters;
  startedAt: string;
  finishedAt: string;
  selectedCaseCount: number;
  codeFingerprint: string;
  judgeProvider: string | null;
  judgeModel: string | null;
  judgeFingerprint: string | null;
  environmentFingerprint: string;
  records: EvalResultRecord[];
  historyPath: string | null;
};

export function readEvalFiltersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EvalFilters {
  return {
    split: parseSplit(env.EVAL_SPLIT),
    tags: splitList(env.EVAL_TAGS),
    caseIds: splitList(env.EVAL_CASE_ID),
    shard: parseShard(env.EVAL_SHARD),
  };
}

export function selectEvalCases<TCase extends EvalCaseEnvelope>({
  cases,
  filters,
}: {
  cases: TCase[];
  filters: EvalFilters;
}): TCase[] {
  // Unreviewed synthetic cases are excluded by default: a large generated set
  // moves the measured number without moving the product, which is the failure
  // this harness exists to prevent. The opt-in exists so a freshly generated
  // set can be read provisionally before someone has reviewed it; every report
  // from such a run is labelled provisional.
  const includeUnreviewed = process.env.EVAL_INCLUDE_UNREVIEWED === "true";

  return cases.filter((evalCase) => {
    if (!includeUnreviewed && !isCountableCase(evalCase)) return false;
    if (filters.split !== "all" && evalCase.split !== filters.split)
      return false;
    if (filters.caseIds.length > 0 && !filters.caseIds.includes(evalCase.id))
      return false;
    if (
      filters.tags.length > 0 &&
      !filters.tags.some((tag) => evalCase.tags.includes(tag))
    )
      return false;
    if (filters.shard && !isInShard(evalCase.id, filters.shard)) return false;
    return true;
  });
}

/**
 * Deliberately not vitest-based. A thousand cases at k samples with bounded
 * concurrency, sharding, per-invocation timeouts, and aggregate reporting all
 * fight vitest's one-assertion-per-test model, and a suite that reports a rate
 * is not a suite that should go red on the first case.
 */
export async function runEvalSuite<
  TCase extends EvalCaseEnvelope & { __sourceRoot?: string },
  TOutput,
>({
  evalName,
  cases,
  invoke,
  assert,
  judge,
  describeOutput,
  confidenceOf,
  caseFingerprintOf,
  cacheFingerprintOf,
  judgeIdentity,
  model,
  variantId = defaultVariantId(),
  samples = defaultSamples(),
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  filters = readEvalFiltersFromEnv(),
  writeHistory = true,
  onRecord,
  captureUsage,
  expectedServedModel,
}: {
  evalName: string;
  cases: TCase[];
  invoke: (args: {
    evalCase: TCase;
    sampleIndex: number;
    signal: AbortSignal;
  }) => Promise<TOutput>;
  assert?: (args: { evalCase: TCase; output: TOutput }) => AssertionOutcome[];
  judge?: (args: {
    evalCase: TCase;
    output: TOutput;
    signal: AbortSignal;
  }) => Promise<EvalJudgeOutcome>;
  describeOutput?: (output: TOutput) => string;
  confidenceOf?: (output: TOutput) => string | null;
  /**
   * Enables the result cache. Both the case fingerprint and judge identity must
   * be supplied: omitting either could reuse a verdict for different evidence.
   */
  caseFingerprintOf?: (evalCase: TCase) => string;
  /** Cache dependencies may change across comparable runs of the same case. */
  cacheFingerprintOf?: (evalCase: TCase) => string;
  judgeIdentity?: EvalJudgeIdentity;
  model: string;
  variantId?: string;
  samples?: number;
  concurrency?: number;
  timeoutMs?: number;
  filters?: EvalFilters;
  writeHistory?: boolean;
  onRecord?: (record: EvalResultRecord) => void;
  captureUsage?: EvalUsageCapture;
  /**
   * When set, a sample counts only if every candidate call was served by this
   * model. Without a key, getModel quietly serves the deployment default under
   * the requested label, which would make a comparison meaningless.
   */
  expectedServedModel?: { provider: string; model: string };
}): Promise<EvalRun> {
  const startedAt = new Date().toISOString();
  const selected = selectEvalCases({ cases, filters });
  const codeFingerprint = getCodeFingerprint();
  const environmentFingerprint = getEnvironmentFingerprint();
  const judgeFingerprint = judgeIdentity?.fingerprint;

  const tasks = selected.flatMap((evalCase) =>
    Array.from({ length: evalCase.samples ?? samples }, (_, sampleIndex) => ({
      evalCase,
      sampleIndex,
    })),
  );

  const records = await mapWithConcurrency(tasks, concurrency, async (task) => {
    const record = await runOne({
      evalName,
      model,
      variantId,
      timeoutMs,
      invoke,
      assert,
      judge,
      describeOutput,
      confidenceOf,
      caseFingerprintOf,
      cacheFingerprintOf,
      judgeFingerprint,
      codeFingerprint,
      environmentFingerprint,
      captureUsage,
      expectedServedModel,
      ...task,
    });
    onRecord?.(record);
    return record;
  });

  const finishedAt = new Date().toISOString();
  const run: EvalRun = {
    evalName,
    model,
    variantId,
    filters,
    startedAt,
    finishedAt,
    selectedCaseCount: selected.length,
    codeFingerprint,
    judgeProvider: judgeIdentity?.provider ?? null,
    judgeModel: judgeIdentity?.model ?? null,
    judgeFingerprint: judgeFingerprint ?? null,
    environmentFingerprint,
    records,
    historyPath: null,
  };

  if (writeHistory) run.historyPath = writeRunHistory(run);
  appendRunLog(run);
  return run;
}

/** Honours EVAL_HISTORY_DIR like the vitest reporter, including `off`. */
export function writeRunHistory(run: EvalRun): string | null {
  const configured = process.env.EVAL_HISTORY_DIR?.trim();
  if (configured === "off") return null;

  const dir = path.resolve(
    configured || path.join(process.cwd(), ".context", "eval-results"),
    run.evalName,
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  return file;
}

/**
 * A processing log for runs over private data: what was sent where and when,
 * never what it said. Kept apart from run history, which holds full outputs.
 */
function appendRunLog(run: EvalRun) {
  const logFile = process.env.EVAL_RUN_LOG?.trim();
  if (!logFile) return;

  const entry = {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    evalName: run.evalName,
    model: run.model,
    variantId: run.variantId,
    split: run.filters.split,
    caseIds: [...new Set(run.records.map((record) => record.caseId))],
    samples: run.records.length,
    servedModels: [
      ...new Set(
        run.records.flatMap(
          (record) => record.candidateUsage?.servedModels ?? [],
        ),
      ),
    ],
    judgeProvider: run.judgeProvider,
    judgeModel: run.judgeModel,
    dataRoots: [
      ...new Set(
        run.records
          .map((record) => record.sourceRoot)
          .filter((root) => root !== null),
      ),
    ],
  };
  mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

async function runOne<
  TCase extends EvalCaseEnvelope & { __sourceRoot?: string },
  TOutput,
>({
  evalName,
  evalCase,
  sampleIndex,
  model,
  variantId,
  timeoutMs,
  invoke,
  assert,
  judge,
  describeOutput,
  confidenceOf,
  caseFingerprintOf,
  cacheFingerprintOf,
  judgeFingerprint,
  codeFingerprint,
  environmentFingerprint,
  captureUsage = withoutUsageCapture,
  expectedServedModel,
}: {
  evalName: string;
  evalCase: TCase;
  sampleIndex: number;
  model: string;
  variantId: string;
  timeoutMs: number;
  confidenceOf?: (output: TOutput) => string | null;
  caseFingerprintOf?: (evalCase: TCase) => string;
  cacheFingerprintOf?: (evalCase: TCase) => string;
  judgeFingerprint?: string;
  codeFingerprint: string;
  environmentFingerprint: string;
  invoke: (args: {
    evalCase: TCase;
    sampleIndex: number;
    signal: AbortSignal;
  }) => Promise<TOutput>;
  assert?: (args: { evalCase: TCase; output: TOutput }) => AssertionOutcome[];
  judge?: (args: {
    evalCase: TCase;
    output: TOutput;
    signal: AbortSignal;
  }) => Promise<EvalJudgeOutcome>;
  describeOutput?: (output: TOutput) => string;
  captureUsage?: EvalUsageCapture;
  expectedServedModel?: { provider: string; model: string };
}): Promise<EvalResultRecord> {
  const startedAt = Date.now();
  const caseFingerprint = caseFingerprintOf?.(evalCase) ?? null;
  const base = {
    evalName,
    caseId: evalCase.id,
    suite: evalCase.suite,
    split: evalCase.split,
    tags: evalCase.tags,
    difficultyAxes: evalCase.difficultyAxes,
    difficulty: evalCase.difficulty,
    model,
    variantId,
    sampleIndex,
    sourceRoot: evalCase.__sourceRoot ?? null,
    caseFingerprint,
    judgeFingerprint: judgeFingerprint ?? null,
    environmentFingerprint,
    // Safe to stamp the current fingerprint even on a rehydrated cache hit: the
    // fingerprint is part of the cache key, so a hit can only have been written
    // under this same one.
    codeFingerprint,
  };

  const cacheKey =
    caseFingerprint !== null && judgeFingerprint
      ? buildCacheKey({
          caseFingerprint: cacheFingerprintOf?.(evalCase) ?? caseFingerprint,
          judgeFingerprint,
          environmentFingerprint,
          model,
          sampleIndex,
          variantId,
        })
      : null;

  if (cacheKey) {
    const cached = readCachedRecord(cacheKey);
    if (cached) return rehydrate(cached, base);
  }

  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const invoked = await race(
      captureUsage(() => invoke({ evalCase, sampleIndex, signal })),
      signal,
    );
    const output = invoked.value;
    const candidateUsage = summarizeUsage(invoked.calls);

    const routingError = expectedServedModel
      ? checkServedModel(expectedServedModel, invoked.calls)
      : null;
    if (routingError) {
      return {
        ...base,
        pass: false,
        sendReady: null,
        usability: null,
        primaryIssue: null,
        severity: null,
        confidence: null,
        assertionFailures: [],
        criteriaFailures: [],
        durationMs: Date.now() - startedAt,
        judgeReasoning: null,
        actual: describeOutput ? describeOutput(output) : null,
        error: routingError,
        candidateUsage,
        judgeUsage: null,
      };
    }

    const assertionFailures = (assert?.({ evalCase, output }) ?? [])
      .filter((outcome) => !outcome.pass)
      .map((outcome) => `${outcome.name}: ${outcome.detail}`);

    const judged = judge
      ? await race(
          captureUsage(() => judge({ evalCase, output, signal })),
          signal,
        )
      : null;
    const verdict = judged?.value ?? null;
    const criteriaFailures = verdict?.criteriaFailures ?? [];

    const record: EvalResultRecord = {
      ...base,
      pass:
        assertionFailures.length === 0 &&
        criteriaFailures.length === 0 &&
        (verdict === null || verdict.sendReady),
      sendReady: verdict?.sendReady ?? null,
      usability: verdict?.usability ?? null,
      primaryIssue: verdict?.primaryIssue ?? null,
      severity: verdict?.severity ?? null,
      confidence: confidenceOf ? confidenceOf(output) : null,
      assertionFailures,
      criteriaFailures,
      durationMs: Date.now() - startedAt,
      judgeReasoning: verdict?.reasoning ?? null,
      actual: describeOutput ? describeOutput(output) : null,
      error: null,
      candidateUsage,
      judgeUsage: judged ? summarizeUsage(judged.calls) : null,
    };

    if (cacheKey) writeCachedRecord(cacheKey, record);
    return record;
  } catch (error) {
    // A dropped case silently inflates the pass rate, so a timeout or a crash
    // is recorded as a failed sample rather than removed from the denominator.
    const timedOut = isTimeout(error, signal);
    return {
      ...base,
      pass: false,
      sendReady: null,
      usability: null,
      primaryIssue: null,
      severity: null,
      confidence: null,
      assertionFailures: [],
      criteriaFailures: [],
      durationMs: Date.now() - startedAt,
      judgeReasoning: null,
      actual: timedOut ? "timeout" : null,
      error: timedOut ? "timeout" : errorMessage(error),
    };
  }
}

async function withoutUsageCapture<T>(operation: () => Promise<T>) {
  return { value: await operation(), calls: [] };
}

function summarizeUsage(calls: EvalUsageCall[]): EvalUsageSummary | null {
  if (calls.length === 0) return null;

  return {
    calls: calls.length,
    inputTokens: sumOf(calls, (call) => call.inputTokens),
    outputTokens: sumOf(calls, (call) => call.outputTokens),
    reasoningTokens: sumOf(calls, (call) => call.reasoningTokens),
    costUsd: sumOf(calls, (call) => call.costUsd ?? 0),
    unpricedCalls: calls.filter((call) => call.costUsd === null).length,
    servedModels: [...new Set(calls.map(servedModelId))],
  };
}

function checkServedModel(
  expected: { provider: string; model: string },
  calls: EvalUsageCall[],
): string | null {
  if (calls.length === 0) {
    return "served_model_unverified: no AI call was recorded for this sample";
  }

  const wrong = calls.filter(
    (call) =>
      call.provider !== expected.provider || call.model !== expected.model,
  );
  if (wrong.length === 0) return null;

  return `served_model_mismatch: expected ${servedModelId(expected)}, got ${[
    ...new Set(wrong.map(servedModelId)),
  ].join(", ")}`;
}

function servedModelId(call: { provider: string; model: string }): string {
  return `${call.provider}:${call.model}`;
}

function sumOf<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([promise, abortRejection(signal)]);
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("eval_timeout"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("eval_timeout")), {
      once: true,
    });
  });
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error) {
    return error.message === "eval_timeout" || error.name === "TimeoutError";
  }
  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "unknown_error";
}

function defaultSamples(): number {
  const raw = Number(process.env.EVAL_SAMPLES);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function getEnvironmentFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: process.env.NEXT_PUBLIC_BASE_URL ?? null,
        timezone: process.env.TZ ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Names the arm a run belongs to. Part of the cache key, so two arms never
 * share a cached verdict, and stored on every record so a finished experiment
 * can still be told apart from the run it was compared against.
 */
function defaultVariantId(): string {
  return process.env.EVAL_VARIANT_ID?.trim() || "baseline";
}

function parseSplit(value: string | undefined): EvalSplit | "all" {
  const split = value?.trim() || "dev";
  if (split === "dev" || split === "test" || split === "all") return split;
  throw new Error(`EVAL_SPLIT must be dev, test, or all (got "${split}")`);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseShard(
  value: string | undefined,
): { index: number; total: number } | null {
  const raw = value?.trim();
  if (!raw) return null;

  const match = raw.match(/^(\d+)\/(\d+)$/);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || index < 1 || index > total) {
    throw new Error(`EVAL_SHARD must look like 2/4 (got "${raw}")`);
  }
  return { index, total };
}

/**
 * Hash the id rather than using position: shard membership then stays stable as
 * cases are added or removed, and the split is balanced without needing the
 * case list to be sorted the same way on every machine.
 */
function isInShard(
  id: string,
  shard: { index: number; total: number },
): boolean {
  const digest = createHash("sha256").update(id).digest();
  return digest.readUInt32BE(0) % shard.total === shard.index - 1;
}
