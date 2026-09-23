import { describe, expect, it, vi } from "vitest";
import type { CompleteKit, Requirement } from "../../server/types/kit.js";
import { checkCoverage } from "../../server/services/coverage/checkCoverage.js";
import { createLlmProvider } from "../../server/services/llm/config.js";
import { GenerationError, type LlmProvider, type LlmRequest } from "../../server/services/llm/types.js";
import type { CombinedResearchResult } from "../../server/services/retrieval/types.js";
import { buildResearchContext } from "../../server/services/pipeline/buildResearchContext.js";
import { extractRequirements } from "../../server/services/pipeline/extractRequirements.js";
import { generateKit } from "../../server/services/pipeline/generateKit.js";
import { generateQuestions } from "../../server/services/pipeline/generateQuestions.js";
import { requirementId } from "../../server/services/pipeline/ids.js";

class FakeLlmProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly respond: (request: LlmRequest) => unknown | Promise<unknown>) {}
  async generateStructured<T>(request: LlmRequest): Promise<T> {
    this.requests.push(request);
    return await this.respond(request) as T;
  }
}

const reqDraft = { requirements: [{ text: "TypeScript programming skills", kind: "technical", priority: "must" }] };
const r1 = requirementId("TypeScript programming skills", "technical");
const r2 = requirementId("PostgreSQL database design", "technical");
const question = (id: string, prompt: string) => ({ requirement_ids: [id], category: "technical", prompt, answer_outline: "Explain a practical approach.", difficulty: 2 });
const emptyResearch = (warnings: string[] = []): CombinedResearchResult => ({ company_url: "https://acme.example/", company_name: "Acme", company_sources: [], interview_sources: [], failed_sources: [], research_warnings: warnings });
const baseInput = { jd: "TypeScript programming skills and PostgreSQL database design required.", company_url: "https://acme.example/", days: 3, company_name: "Acme", role: "Backend Engineer" };

describe("multi-stage generation pipeline", () => {
  it("accepts valid structured requirement extraction", async () => {
    const provider = new FakeLlmProvider(() => reqDraft);
    await expect(extractRequirements("TypeScript programming skills required.", provider)).resolves.toMatchObject([{ id: r1, kind: "technical", priority: "must" }]);
  });
  it("rejects malformed extraction output with a structured schema error", async () => {
    const provider = new FakeLlmProvider(() => ({ requirements: [{ text: "", kind: "tech", priority: "must" }] }));
    await expect(extractRequirements("TypeScript is required.", provider)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });
  it("rejects invalid JSON returned by the provider", async () => {
    const provider = new FakeLlmProvider(() => "{not-json");
    await expect(extractRequirements("TypeScript is required.", provider)).rejects.toMatchObject({ code: "INVALID_JSON" });
  });
  it("deduplicates normalized duplicate requirements", async () => {
    const provider = new FakeLlmProvider(() => ({ requirements: [
      { text: "TypeScript programming skills", kind: "technical", priority: "must" },
      { text: "  TYPESCRIPT   programming skills! ", kind: "technical", priority: "must" },
    ] }));
    expect(await extractRequirements("TypeScript programming skills are required.", provider)).toHaveLength(1);
  });
  it("assigns stable requirement IDs across repeated extraction", async () => {
    const provider = new FakeLlmProvider(() => reqDraft);
    const a = await extractRequirements("TypeScript programming skills required.", provider);
    const b = await extractRequirements("TypeScript programming skills required.", provider);
    expect(a).toEqual(b);
  });
  it("rejects a technology unsupported by the JD", async () => {
    const provider = new FakeLlmProvider(() => ({ requirements: [{ text: "Rust programming skills", kind: "technical", priority: "must" }] }));
    await expect(extractRequirements("TypeScript programming skills required.", provider)).rejects.toMatchObject({ code: "REQUIREMENT_EXTRACTION_FAILED" });
  });

  it("accepts valid generated questions and assigns application IDs", async () => {
    const provider = new FakeLlmProvider(() => ({ questions: [question(r1, "How do you use TypeScript?")] }));
    const result = await generateQuestions({ requirements: [{ id: r1, text: "TypeScript", kind: "technical", priority: "must" }], research: buildResearchContext(emptyResearch()) }, provider);
    expect(result[0]).toMatchObject({ id: expect.stringMatching(/^q_[a-f0-9]{20}$/), requirement_ids: [r1] });
  });
  it("rejects question references that are not in supplied requirements", async () => {
    const provider = new FakeLlmProvider(() => ({ questions: [question("unknown", "How do you use TypeScript?")] }));
    await expect(generateQuestions({ requirements: [{ id: r1, text: "TypeScript", kind: "technical", priority: "must" }], research: buildResearchContext(emptyResearch()) }, provider)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });
  it("rejects invalid question categories", async () => {
    const provider = new FakeLlmProvider(() => ({ questions: [{ ...question(r1, "Question?"), category: "culture" }] }));
    await expect(generateQuestions({ requirements: [{ id: r1, text: "TypeScript", kind: "technical", priority: "must" }], research: buildResearchContext(emptyResearch()) }, provider)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });
  it("rejects invalid question difficulty", async () => {
    const provider = new FakeLlmProvider(() => ({ questions: [{ ...question(r1, "Question?"), difficulty: 4 }] }));
    await expect(generateQuestions({ requirements: [{ id: r1, text: "TypeScript", kind: "technical", priority: "must" }], research: buildResearchContext(emptyResearch()) }, provider)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });
  it("assigns stable question IDs for identical logical questions", async () => {
    const provider = new FakeLlmProvider(() => ({ questions: [question(r1, "How do you use TypeScript?")] }));
    const input = { requirements: [{ id: r1, text: "TypeScript", kind: "technical" as const, priority: "must" as const }], research: buildResearchContext(emptyResearch()) };
    expect(await generateQuestions(input, provider)).toEqual(await generateQuestions(input, provider));
  });

  it("keeps source provenance boundaries and enforces context size limits", () => {
    const research = { ...emptyResearch(), company_sources: [{ url: "https://acme.example/about", requested_url: "https://acme.example/about", title: "About", description: "Company", content: "x".repeat(1000), content_type: "text/html", fetched_at: "2026-01-01" }] };
    const context = buildResearchContext(research, { maxBytes: 500, maxSources: 3 });
    expect(context.company_sources[0]).toMatchObject({ url: "https://acme.example/about", type: "company" });
    expect(context.truncated).toBe(true);
    expect(Buffer.byteLength(context.serialized)).toBeLessThanOrEqual(500);
  });

  it("does not run the gap pass when all must-have requirements are covered", async () => {
    const provider = new FakeLlmProvider((request) => request.stage === "requirement_extraction" ? reqDraft : ({ questions: [question(r1, "How do you use TypeScript?")] }));
    const result = await generateKit(baseInput, { provider, research: async () => emptyResearch(), now: () => 0 });
    expect(result.status).toBe("ok");
    expect(provider.requests.map(({ stage }) => stage)).toEqual(["requirement_extraction", "question_generation"]);
  });

  it("runs a second pass when a must-have requirement is uncovered", async () => {
    const provider = new FakeLlmProvider((request) => {
      if (request.stage === "requirement_extraction") return { requirements: [
        { text: "TypeScript programming skills", kind: "technical", priority: "must" },
        { text: "PostgreSQL database design", kind: "technical", priority: "must" },
      ] };
      if (request.stage === "question_generation") return { questions: [question(r1, "How do you use TypeScript?")] };
      return { questions: [question(r2, "How would you design PostgreSQL data storage?")] };
    });
    const result = await generateKit(baseInput, { provider, research: async () => emptyResearch(), now: () => 0 });
    expect(result.status).toBe("ok");
    expect(provider.requests.map(({ stage }) => stage)).toContain("coverage_gap_generation");
  });

  it("sends only uncovered requirements to the second generation pass", async () => {
    const provider = new FakeLlmProvider((request) => {
      if (request.stage === "requirement_extraction") return { requirements: [
        { text: "TypeScript programming skills", kind: "technical", priority: "must" },
        { text: "PostgreSQL database design", kind: "technical", priority: "must" },
      ] };
      if (request.stage === "question_generation") return { questions: [question(r1, "How do you use TypeScript?")] };
      return { questions: [question(r2, "How would you design PostgreSQL data storage?")] };
    });
    await generateKit(baseInput, { provider, research: async () => emptyResearch(), now: () => 0 });
    const gap = provider.requests.find(({ stage }) => stage === "coverage_gap_generation");
    expect(JSON.parse(gap!.userInput).requirements.map((requirement: Requirement) => requirement.id)).toEqual([r2]);
    expect(gap!.systemInstruction).toContain("Generate questions specifically for these uncovered requirements.");
  });

  it("preserves all valid first-pass questions after merging gap questions", async () => {
    const provider = new FakeLlmProvider((request) => {
      if (request.stage === "requirement_extraction") return { requirements: [
        { text: "TypeScript programming skills", kind: "technical", priority: "must" },
        { text: "PostgreSQL database design", kind: "technical", priority: "must" },
      ] };
      if (request.stage === "question_generation") return { questions: [question(r1, "How do you use TypeScript?")] };
      return { questions: [question(r2, "How would you design PostgreSQL data storage?")] };
    });
    const result = await generateKit(baseInput, { provider, research: async () => emptyResearch(), now: () => 0 });
    expect(result.kit?.questions.map(({ requirement_ids }) => requirement_ids[0])).toEqual(expect.arrayContaining([r1, r2]));
  });

  it("honestly reports requirements still uncovered after pass two", async () => {
    const provider = new FakeLlmProvider((request) => {
      if (request.stage === "requirement_extraction") return { requirements: [
        { text: "TypeScript programming skills", kind: "technical", priority: "must" },
        { text: "PostgreSQL database design", kind: "technical", priority: "must" },
      ] };
      if (request.stage === "coverage_gap_generation") return { questions: [] };
      return { questions: [question(r1, "How do you use TypeScript?")] };
    });
    const result = await generateKit(baseInput, { provider, research: async () => emptyResearch() });
    expect(result).toMatchObject({ status: "failed", kit: null, uncovered_requirement_ids: [r2], error: { code: "COVERAGE_FAILURE" } });
  });

  it("follows stage order and calls deterministic coverage, scheduler, then final validator", async () => {
    const events: string[] = [];
    const research = { ...emptyResearch(), company_sources: [{ url: "https://acme.example/about", requested_url: "https://acme.example/about", title: "Acme", description: "Builds tools", content: "Acme builds software tools.", content_type: "text/html", fetched_at: "2026-01-01" }] };
    const provider = new FakeLlmProvider((request) => {
      events.push(request.stage);
      if (request.stage === "requirement_extraction") return reqDraft;
      if (request.stage === "company_brief") return { summary: "Acme builds tools.", what_they_do: "Builds tools.", sources: ["https://acme.example/about"] };
      return { questions: [question(r1, "How do you use TypeScript?")] };
    });
    const validateKit = vi.fn((value: unknown) => value as CompleteKit);
    const result = await generateKit(baseInput, {
      provider,
      research: async () => { events.push("research"); return research; },
      checkCoverage: ((requirements, questions) => { events.push("coverage"); return checkCoverage(requirements, questions); }) as typeof checkCoverage,
      allocateSchedule: ((requirements, questions, days) => { events.push("schedule"); return (awaitSchedule)(requirements, questions, days); }) as never,
      validateKit: (value) => { events.push("validate"); return validateKit(value); },
      now: () => 0,
    });
    expect(result.status).toBe("ok");
    expect(events).toEqual(["requirement_extraction", "research", "company_brief", "question_generation", "coverage", "schedule", "validate"]);
    expect(validateKit).toHaveBeenCalledOnce();
  });

  it("continues when research fails and returns a partial kit", async () => {
    const provider = new FakeLlmProvider((request) => request.stage === "requirement_extraction" ? reqDraft : ({ questions: [question(r1, "How do you use TypeScript?")] }));
    const result = await generateKit(baseInput, { provider, research: async () => { throw new Error("network"); }, now: () => 0 });
    expect(result.status).toBe("partial");
    expect(result.kit).not.toBeNull();
    expect(result.warnings).toContain("Company and interview research could not be completed; generation continued without research evidence.");
  });

  it("returns a partial kit when only a nice-to-have remains uncovered", async () => {
    const provider = new FakeLlmProvider((request) => request.stage === "requirement_extraction" ? { requirements: [
      { text: "TypeScript programming skills", kind: "technical", priority: "must" },
      { text: "PostgreSQL database design", kind: "technical", priority: "nice" },
    ] } : ({ questions: [question(r1, "How do you use TypeScript?")] }));
    const result = await generateKit(baseInput, { provider, research: async () => emptyResearch(), now: () => 0 });
    expect(result).toMatchObject({ status: "partial", uncovered_requirement_ids: [r2] });
    expect(result.kit?.coverage.uncovered_requirement_ids).toEqual([r2]);
  });

  it("returns a structured failure for provider errors", async () => {
    const provider = new FakeLlmProvider(() => { throw new Error("vendor detail must stay internal"); });
    const result = await generateKit(baseInput, { provider });
    expect(result).toMatchObject({ status: "failed", kit: null, error: { code: "LLM_API_ERROR", stage: "requirement_extraction" } });
    expect(result.error?.message).not.toContain("vendor detail");
  });

  it("returns a structured timeout error", async () => {
    const provider = new FakeLlmProvider(() => new Promise(() => {}));
    const result = await generateKit(baseInput, { provider, llmConfig: { provider: "fake", model: "fake-v1", apiKey: "test-only", timeoutMs: 5, researchContextMaxBytes: 1000, researchContextMaxSources: 2 } });
    expect(result).toMatchObject({ status: "failed", error: { code: "LLM_TIMEOUT", stage: "requirement_extraction" } });
  });

  it("fails clearly when LLM configuration is missing", () => {
    expect(() => createLlmProvider({ provider: "", model: "", apiKey: "", timeoutMs: 1000, researchContextMaxBytes: 1000, researchContextMaxSources: 1 })).toThrowError(GenerationError);
  });
});

function awaitSchedule(requirements: readonly Requirement[], questions: CompleteKit["questions"], days: number) {
  return buildScheduleForTest(requirements, questions, days);
}

import { buildSchedule as buildScheduleForTest } from "../../server/services/scheduler/buildSchedule.js";
