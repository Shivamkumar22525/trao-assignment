import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { checkCoverage } from "../server/services/coverage/checkCoverage.js";
import { getLlmConfig } from "../server/services/llm/config.js";
import type { GenerationErrorCode, GenerationResult } from "../server/services/llm/types.js";
import { generateKit, type GenerateKitPipelineInput } from "../server/services/pipeline/generateKit.js";
import { CompleteKitSchema } from "../server/services/validation/kit.schema.js";
import type { CompleteKit } from "../server/types/kit.js";
import { researchCompanyAndInterviews } from "../server/services/retrieval/researchCompanyAndInterviews.js";

const InputCaseSchema = z.object({
  id: z.string().min(1).refine((value) => value.trim().length > 0, "ID must not be blank."),
  jd: z.string().min(1, "Job description is required.").refine((value) => value.trim().length > 0, "Job description must not be blank."),
  company_url: z.string().min(1, "Company URL is required.").max(2048).refine((value) => {
    try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
    catch { return false; }
  }, "Company URL must be an HTTP or HTTPS URL without credentials."),
  // The assignment explicitly includes a 60-day case. A one-year ceiling keeps
  // malformed local input from asking the deterministic scheduler to allocate
  // an unreasonable in-memory array while comfortably covering the spec.
  days: z.number().int().min(1).max(366),
}).strict();

export type EvaluationCase = z.infer<typeof InputCaseSchema>;
export interface BatchSuccess { id: string; status: "ok"; kit: CompleteKit; error: null; }
export interface BatchFailure { id: string; status: "failed"; kit: null; error: { code: string; message: string }; }
export type BatchKitResult = BatchSuccess | BatchFailure;
export interface BatchOutput { version: "1.0"; generated_at: string; kits: BatchKitResult[]; }
export interface EvaluatorBudget { batchTimeoutMs: number; caseTimeoutMs: number; llmStageTimeoutMs: number }
export const DEFAULT_EVALUATOR_BUDGET: Readonly<EvaluatorBudget> = Object.freeze({
  batchTimeoutMs: 14 * 60_000,
  caseTimeoutMs: 135_000,
  llmStageTimeoutMs: 20_000,
});
export interface GenerateCaseOptions { signal: AbortSignal; llmStageTimeoutMs: number }
type GenerateCase = (input: GenerateKitPipelineInput, options?: GenerateCaseOptions) => Promise<GenerationResult<unknown>>;
export interface EvaluatorDependencies {
  generateCase?: GenerateCase;
  now?: () => Date;
  stderr?: (message: string) => void;
  budget?: Partial<EvaluatorBudget>;
}

class EvaluatorDeadlineError extends Error {
  constructor(readonly code: "CASE_TIMEOUT" | "BATCH_TIMEOUT") {
    super(code === "CASE_TIMEOUT" ? "Case generation exceeded its time budget." : "The evaluator batch exceeded its time budget.");
    this.name = "EvaluatorDeadlineError";
  }
}

function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: EvaluatorDeadlineError["code"],
  parent?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const deadlineError = new EvaluatorDeadlineError(code);
    const timer = setTimeout(() => {
      controller.abort(deadlineError);
      finish(deadlineError);
    }, Math.max(0, timeoutMs));
    const onParentAbort = () => {
      const reason = parent?.reason instanceof EvaluatorDeadlineError ? parent.reason : new EvaluatorDeadlineError("BATCH_TIMEOUT");
      controller.abort(reason);
      finish(reason);
    };
    parent?.addEventListener("abort", onParentAbort, { once: true });
    if (parent?.aborted) { onParentAbort(); return; }
    let task: Promise<T>;
    try { task = operation(controller.signal); }
    catch (error) { finish(error); return; }
    task.then((value) => finish(undefined, value), (error: unknown) => finish(error));
  });
}

export class EvaluatorInputError extends Error {
  constructor(message: string) { super(message); this.name = "EvaluatorInputError"; }
}

function fail(id: string, code: string, message: string): BatchFailure {
  return { id, status: "failed", kit: null, error: { code, message } };
}

function caseId(value: unknown, index: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluatorInputError(`Case at index ${index} must be an object with a non-empty string id.`);
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new EvaluatorInputError(`Case at index ${index} must have a non-empty string id.`);
  }
  return id;
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "case"}: ${issue.message}`).join("; ");
}

function safeGenerationFailure(result: GenerationResult<unknown>): BatchFailure {
  const error = result.error;
  return fail("", error?.code ?? "GENERATION_FAILED", error?.message ?? "The generation pipeline could not produce a valid kit.");
}

function validateGeneratedKit(value: unknown, input: EvaluationCase): CompleteKit | undefined {
  const parsed = CompleteKitSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const kit = parsed.data as CompleteKit;
  if (kit.schedule.days_available !== input.days || kit.schedule.days.length !== input.days) return undefined;
  const coverage = checkCoverage(kit.role.requirements, kit.questions);
  const reportedUncovered = [...kit.coverage.uncovered_requirement_ids].sort();
  if (!coverage.passes || coverage.uncovered_requirement_ids.join("\0") !== reportedUncovered.join("\0")) return undefined;
  return kit;
}

/** Processes cases in input order through the application's shared generation pipeline. */
export async function evaluateCases(rawCases: unknown, dependencies: EvaluatorDependencies = {}): Promise<BatchOutput> {
  if (!Array.isArray(rawCases)) throw new EvaluatorInputError("Input JSON must be an array of cases.");
  // IDs are required to construct the Appendix B failure envelope. Validate all
  // IDs before starting expensive external work; other per-case issues are recorded.
  const ids = rawCases.map((value, index) => caseId(value, index));
  const budget = { ...DEFAULT_EVALUATOR_BUDGET, ...dependencies.budget };
  const generate: GenerateCase = dependencies.generateCase ?? (async (input, runOptions) => {
    const config = getLlmConfig();
    return generateKit(input, {
      signal: runOptions?.signal,
      llmConfig: { ...config, timeoutMs: runOptions?.llmStageTimeoutMs ?? budget.llmStageTimeoutMs },
      researchOptions: {
        company: { config: { maxPages: 3, maxDepth: 1, requestTimeoutMs: 3_000, minRequestIntervalMs: 250, maxRetries: 1, retryBaseDelayMs: 250, retryMaxDelayMs: 500, maxRedirects: 2, maxCrawlDelayMs: 1_000 } },
        interviews: { config: { interviewSearchMaxQueries: 2, interviewSearchMaxResultsPerQuery: 2, interviewResearchMaxSources: 2, requestTimeoutMs: 3_000, minRequestIntervalMs: 250, maxRetries: 1, retryBaseDelayMs: 250, retryMaxDelayMs: 500, maxRedirects: 2, maxCrawlDelayMs: 1_000 } },
      },
    });
  });
  const kits: BatchKitResult[] = [];
  const batchController = new AbortController();
  const batchTimer = setTimeout(() => batchController.abort(new EvaluatorDeadlineError("BATCH_TIMEOUT")), Math.max(0, budget.batchTimeoutMs));

  try { for (let index = 0; index < rawCases.length; index += 1) {
    const id = ids[index]!;
    if (batchController.signal.aborted) {
      kits.push(fail(id, "BATCH_TIMEOUT", "The evaluator batch exceeded its time budget before this case could start."));
      continue;
    }
    const parsed = InputCaseSchema.safeParse(rawCases[index]);
    if (!parsed.success) {
      kits.push(fail(id, "INVALID_CASE", validationMessage(parsed.error)));
      continue;
    }
    let result: GenerationResult<unknown>;
    try {
      result = await runWithDeadline((signal) => generate(parsed.data, { signal, llmStageTimeoutMs: budget.llmStageTimeoutMs }), budget.caseTimeoutMs, "CASE_TIMEOUT", batchController.signal);
    } catch (error) {
      if (error instanceof EvaluatorDeadlineError) {
        kits.push(fail(id, error.code, error.message));
        continue;
      }
      kits.push(fail(id, "GENERATION_FAILED", "The generation pipeline failed unexpectedly for this case."));
      continue;
    }
    if (result.status === "failed" || result.kit === null) {
      const failure = safeGenerationFailure(result);
      kits.push({ ...failure, id });
      continue;
    }
    const kit = validateGeneratedKit(result.kit, parsed.data);
    if (!kit) {
      kits.push(fail(id, "FINAL_VALIDATION_FAILED", "The generated kit failed Appendix A, coverage, or requested schedule validation."));
      continue;
    }
    // Appendix B status records whether a kit exists, not whether retrieval was
    // partial. The kit itself preserves honest empty sources and coverage gaps.
    kits.push({ id, status: "ok", kit, error: null });
  } } finally { clearTimeout(batchTimer); }

  return { version: "1.0", generated_at: (dependencies.now ?? (() => new Date()))().toISOString(), kits };
}

function parseArguments(args: readonly string[]): { inputPath: string; outputPath: string } {
  // npm on Windows may consume the conventional `--` delimiter and forward
  // only the option/value pairs to the lifecycle script.
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  // PowerShell's npm lifecycle shim also consumes flags following `--` as npm
  // configuration and forwards the two values positionally.
  if (normalizedArgs.length === 2 && normalizedArgs.every((argument) => !argument.startsWith("--"))) {
    const resolvedInput = resolve(normalizedArgs[0]!);
    const resolvedOutput = resolve(normalizedArgs[1]!);
    if (resolvedInput.toLocaleLowerCase() === resolvedOutput.toLocaleLowerCase()) throw new EvaluatorInputError("Input and output paths must be different files.");
    return { inputPath: resolvedInput, outputPath: resolvedOutput };
  }
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const option = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if ((option !== "--input" && option !== "--output") || !value || value.startsWith("--")) {
      throw new EvaluatorInputError("Usage: npm run evaluate -- --input <cases.json> --output <kits.json>");
    }
    if (option === "--input") {
      if (inputPath) throw new EvaluatorInputError("Specify --input only once.");
      inputPath = value;
    } else {
      if (outputPath) throw new EvaluatorInputError("Specify --output only once.");
      outputPath = value;
    }
    index += 1;
  }
  if (!inputPath || !outputPath) throw new EvaluatorInputError("Usage: npm run evaluate -- --input <cases.json> --output <kits.json>");
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputPath);
  if (resolvedInput.toLocaleLowerCase() === resolvedOutput.toLocaleLowerCase()) throw new EvaluatorInputError("Input and output paths must be different files.");
  return { inputPath: resolvedInput, outputPath: resolvedOutput };
}

async function writeOutput(outputPath: string, output: BatchOutput): Promise<void> {
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** CLI-level handler, injectable in tests so they never use MongoDB or live AI. */
export async function runEvaluatorCli(args: readonly string[], dependencies: EvaluatorDependencies = {}): Promise<number> {
  try {
    const { inputPath, outputPath } = parseArguments(args);
    let source: string;
    try { source = await readFile(inputPath, "utf8"); }
    catch { throw new EvaluatorInputError(`Could not read input file: ${inputPath}`); }
    let raw: unknown;
    try { raw = JSON.parse(source) as unknown; }
    catch { throw new EvaluatorInputError(`Input file is not valid JSON: ${inputPath}`); }
    if (!Array.isArray(raw)) throw new EvaluatorInputError("Input JSON must be an array of cases.");
    // Load documented server-side environment files only for actual CLI use.
    // Importing evaluator helpers in tests has no environment or network effect.
    if (!dependencies.generateCase) {
      dotenv.config({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "server/.env"), resolve(process.cwd(), "../.env")] });
    }
    const output = await evaluateCases(raw, dependencies);
    try { await writeOutput(outputPath, output); }
    catch { throw new EvaluatorInputError(`Could not write output file: ${outputPath} (parent directory must exist and be writable).`); }
    return 0;
  } catch (error) {
    const message = error instanceof EvaluatorInputError ? error.message : "The evaluator could not complete because of an input/output error.";
    (dependencies.stderr ?? ((text) => process.stderr.write(`${text}\n`)))(`evaluate: ${message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).replace(/\\/g, "/") : "";
if (/\/scripts\/evaluate\.(?:ts|js)$/.test(invokedPath)) {
  void runEvaluatorCli(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}
