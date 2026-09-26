import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validKit } from "../fixtures/valid-kit.js";
import { CompleteKitSchema } from "../../server/services/validation/kit.schema.js";
import { buildSchedule } from "../../server/services/scheduler/buildSchedule.js";
import { generateKit } from "../../server/services/pipeline/generateKit.js";
import type { LlmRequest } from "../../server/services/llm/types.js";
import type { LlmProvider } from "../../server/services/llm/types.js";
import type { CompleteKit } from "../../server/types/kit.js";
import { DEFAULT_EVALUATOR_BUDGET, evaluateCases, runEvaluatorCli } from "../../scripts/evaluate.js";

const tempDirectories: string[] = [];
async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "trao-evaluator-"));
  tempDirectories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function resultKit(days: number) {
  return { ...structuredClone(validKit), schedule: buildSchedule(validKit.role.requirements, validKit.questions, days) };
}

describe("Appendix B batch evaluator", () => {
  it("writes the exact envelope and marks partial research as status ok", async () => {
    const generated = resultKit(2);
    const output = await evaluateCases([{ id: "case-partial", jd: "Engineer", company_url: "https://example.com", days: 2 }], {
      now: () => new Date("2026-09-01T09:12:44.000Z"),
      generateCase: async () => ({ status: "partial", kit: generated, warnings: ["No interview sources."], uncovered_requirement_ids: [] }),
    });
    expect(Object.keys(output)).toEqual(["version", "generated_at", "kits"]);
    expect(output).toMatchObject({ version: "1.0", generated_at: "2026-09-01T09:12:44.000Z" });
    expect(Object.keys(output.kits[0]!)).toEqual(["id", "status", "kit", "error"]);
    expect(output.kits[0]).toMatchObject({ id: "case-partial", status: "ok", error: null, kit: generated });
    expect(CompleteKitSchema.safeParse(output.kits[0]!.kit).success).toBe(true);
  });

  it("continues after a failed case and preserves all input IDs and ordering", async () => {
    const generateCase = vi.fn(async (input: { jd: string; days: number }) => input.jd === "fails"
      ? { status: "failed" as const, kit: null, warnings: [], uncovered_requirement_ids: [], error: { code: "LLM_RATE_LIMIT" as const, stage: "requirement_extraction" as const, message: "Rate limit reached." } }
      : { status: "ok" as const, kit: resultKit(input.days), warnings: [], uncovered_requirement_ids: [] });
    const output = await evaluateCases([
      { id: "first", jd: "good", company_url: "https://example.com", days: 1 },
      { id: "second", jd: "fails", company_url: "https://example.com", days: 2 },
      { id: "third", jd: "good again", company_url: "https://example.com", days: 60 },
    ], { generateCase });
    expect(output.kits.map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect(output.kits.map(({ status }) => status)).toEqual(["ok", "failed", "ok"]);
    expect(output.kits[1]).toEqual({ id: "second", status: "failed", kit: null, error: { code: "LLM_RATE_LIMIT", message: "Rate limit reached." } });
    expect(output.kits[2]!.status === "ok" && output.kits[2]!.kit.schedule.days).toHaveLength(60);
    expect(generateCase).toHaveBeenCalledTimes(3);
  });

  it("uses the bounded batch defaults and continues in order after a per-case deadline", async () => {
    expect(DEFAULT_EVALUATOR_BUDGET).toEqual({ batchTimeoutMs: 840_000, caseTimeoutMs: 135_000, llmStageTimeoutMs: 20_000 });
    vi.useFakeTimers();
    try {
      const controllerSignals: AbortSignal[] = [];
      const generateCase = vi.fn((input: { jd: string; days: number }, options?: { signal: AbortSignal; llmStageTimeoutMs: number }) => {
        controllerSignals.push(options!.signal);
        expect(options!.llmStageTimeoutMs).toBe(20_000);
        return input.jd === "slow" ? new Promise<never>(() => {}) : Promise.resolve({ status: "ok" as const, kit: resultKit(input.days), warnings: [], uncovered_requirement_ids: [] });
      });
      const pending = evaluateCases([
        { id: "slow", jd: "slow", company_url: "https://example.com", days: 1 },
        { id: "next", jd: "quick", company_url: "https://example.com", days: 2 },
      ], { generateCase, budget: { caseTimeoutMs: 100, batchTimeoutMs: 500 } });
      await vi.advanceTimersByTimeAsync(100);
      const output = await pending;
      expect(controllerSignals[0]?.aborted).toBe(true);
      expect(output.kits.map(({ id }) => id)).toEqual(["slow", "next"]);
      expect(output.kits.map(({ status }) => status)).toEqual(["failed", "ok"]);
      expect(output.kits[0]).toMatchObject({ error: { code: "CASE_TIMEOUT", message: "Case generation exceeded its time budget." } });
    } finally { vi.useRealTimers(); }
  });

  it("records active and remaining cases as failures when the overall deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const generateCase = vi.fn(() => new Promise<never>(() => {}));
      const pending = evaluateCases([
        { id: "active", jd: "slow", company_url: "https://example.com", days: 1 },
        { id: "remaining-1", jd: "later", company_url: "https://example.com", days: 2 },
        { id: "remaining-2", jd: "later", company_url: "https://example.com", days: 3 },
      ], { generateCase, budget: { caseTimeoutMs: 100, batchTimeoutMs: 50 } });
      await vi.advanceTimersByTimeAsync(50);
      const output = await pending;
      expect(generateCase).toHaveBeenCalledTimes(1);
      expect(output.kits.map(({ id }) => id)).toEqual(["active", "remaining-1", "remaining-2"]);
      expect(output.kits.every((entry) => entry.status === "failed" && entry.kit === null && entry.error.code === "BATCH_TIMEOUT")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("records invalid cases independently and rejects unidentifiable entries as fatal input", async () => {
    const generateCase = vi.fn(async (input: { days: number }) => ({ status: "ok" as const, kit: resultKit(input.days), warnings: [], uncovered_requirement_ids: [] }));
    const output = await evaluateCases([
      { id: "missing-jd", company_url: "https://example.com", days: 2 },
      { id: "invalid-url", jd: "job", company_url: "file:///etc/passwd", days: 2 },
      { id: "after-invalid", jd: "good", company_url: "https://example.com", days: 1 },
    ], { generateCase });
    expect(output.kits[0]).toMatchObject({ id: "missing-jd", status: "failed", kit: null, error: { code: "INVALID_CASE" } });
    expect(output.kits[1]).toMatchObject({ id: "invalid-url", status: "failed", kit: null, error: { code: "INVALID_CASE" } });
    expect(output.kits[2]!.status).toBe("ok");
    expect(generateCase).toHaveBeenCalledTimes(1);
    await expect(evaluateCases([{ jd: "no id" }])).rejects.toThrow("Case at index 0 must have a non-empty string id.");
  });

  it("reports provider errors and refuses a kit with invalid coverage or schedule", async () => {
    const error = await evaluateCases([{ id: "rate-limited", jd: "job", company_url: "https://example.com", days: 1 }], {
      generateCase: async () => ({ status: "failed", kit: null, warnings: [], uncovered_requirement_ids: [], error: { code: "LLM_RATE_LIMIT", stage: "question_generation", message: "Provider rate limit." } }),
    });
    expect(error.kits[0]).toMatchObject({ status: "failed", kit: null, error: { code: "LLM_RATE_LIMIT", message: "Provider rate limit." } });
    const invalid = await evaluateCases([{ id: "bad-kit", jd: "job", company_url: "https://example.com", days: 1 }], {
      generateCase: async () => ({ status: "ok", kit: { ...validKit, schedule: { ...validKit.schedule, days_available: 2 } }, warnings: [], uncovered_requirement_ids: [] }),
    });
    expect(invalid.kits[0]).toMatchObject({ status: "failed", error: { code: "FINAL_VALIDATION_FAILED" }, kit: null });
  });

  it("writes JSON from the CLI handler and runs the shared pipeline with injected provider/research mocks", async () => {
    const directory = await tempDirectory();
    const inputPath = fileURLToPath(new URL("../../examples/evaluator-cases.json", import.meta.url));
    const outputPath = join(directory, "kits.json");
    const provider = {
      generateStructured: vi.fn(async (request: LlmRequest) => {
        if (request.stage === "requirement_extraction") {
          const { job_description } = JSON.parse(request.userInput) as { job_description: string };
          const skill = /React/i.test(job_description) ? "React" : "TypeScript";
          return { requirements: [{ text: `Experience with ${skill}`, kind: "technical", priority: "must" }], role_profile: { title: "", seniority: "", responsibilities: [] } };
        }
        if (request.stage === "question_generation" || request.stage === "coverage_gap_generation") {
          const { requirements } = JSON.parse(request.userInput) as { requirements: { id: string; text: string }[] };
          const requirement = requirements[0]!;
          return { questions: [{ requirement_ids: [requirement.id], category: "technical", prompt: `How do you use ${requirement.text}?`, answer_outline: "Describe a relevant example.", difficulty: 2 }] };
        }
        throw new Error(`Unexpected model stage: ${request.stage}`);
      }),
    };
    const errors: string[] = [];
    const code = await runEvaluatorCli(["--input", inputPath, "--output", outputPath], {
      stderr: (message) => errors.push(message),
      generateCase: (input) => generateKit(input, {
        provider: provider as unknown as LlmProvider,
        llmConfig: { provider: "test", model: "mock", apiKey: "mock", timeoutMs: 1_000, researchContextMaxBytes: 1024, researchContextMaxSources: 2 },
        research: async ({ company_url }) => ({ company_url, company_name: "", company_sources: [], interview_sources: [], failed_sources: [], research_warnings: [] }),
        now: () => Date.parse("2026-09-01T09:12:44Z"),
      }),
      now: () => new Date("2026-09-01T09:12:44Z"),
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect((await stat(outputPath)).isFile()).toBe(true);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as { version: string; generated_at: string; kits: BatchEntry[] };
    expect(output.version).toBe("1.0");
    expect(output.generated_at).toBe("2026-09-01T09:12:44.000Z");
    expect(output.kits.map(({ id }) => id)).toEqual(["sample-typescript-backend", "sample-react-frontend"]);
    for (const entry of output.kits) {
      expect(Object.keys(entry)).toEqual(["id", "status", "kit", "error"]);
      expect(entry.status).toBe("ok");
      const kit = CompleteKitSchema.parse(entry.kit);
      expect(kit.schedule.days).toHaveLength(kit.schedule.days_available);
      expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
    }
    expect(output.kits[0]!.kit.schedule.days).toHaveLength(5);
    expect(output.kits[1]!.kit.schedule.days).toHaveLength(60);
    expect(provider.generateStructured).toHaveBeenCalled();
  });

  it("accepts npm's Windows positional input/output argument forwarding", async () => {
    const directory = await tempDirectory();
    const inputPath = fileURLToPath(new URL("../../examples/evaluator-cases.json", import.meta.url));
    const outputPath = join(directory, "kits-positional.json");
    const errors: string[] = [];
    const code = await runEvaluatorCli([inputPath, outputPath], {
      stderr: (message) => errors.push(message),
      generateCase: async (input) => ({ status: "ok", kit: resultKit(input.days), warnings: [], uncovered_requirement_ids: [] }),
      now: () => new Date("2026-09-01T09:12:44Z"),
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as { version: string; kits: { id: string; status: string }[] };
    expect(output.version).toBe("1.0");
    expect(output.kits.map(({ id }) => id)).toEqual(["sample-typescript-backend", "sample-react-frontend"]);
    expect(output.kits.map(({ status }) => status)).toEqual(["ok", "ok"]);
  });

  it("returns a clear fatal error for malformed JSON without creating an output file", async () => {
    const directory = await tempDirectory();
    const inputPath = join(directory, "broken.json");
    const outputPath = join(directory, "kits.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(inputPath, "[{ broken", "utf8"));
    const errors: string[] = [];
    const code = await runEvaluatorCli(["--input", inputPath, "--output", outputPath], { stderr: (message) => errors.push(message) });
    expect(code).toBe(1);
    expect(errors[0]).toContain("not valid JSON");
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface BatchEntry { id: string; status: string; kit: CompleteKit; error: unknown; }
