import type { CompleteKit, Requirement } from "../../types/kit.js";
import { checkCoverage as defaultCheckCoverage } from "../coverage/checkCoverage.js";
import { buildSchedule as defaultBuildSchedule } from "../scheduler/buildSchedule.js";
import { researchCompanyAndInterviews, type ResearchCompanyAndInterviewsOptions } from "../retrieval/researchCompanyAndInterviews.js";
import type { CombinedResearchResult } from "../retrieval/types.js";
import { CompleteKitSchema } from "../validation/kit.schema.js";
import { createLlmProvider, getLlmConfig, type LlmConfig, type LlmProviderFactory } from "../llm/config.js";
import { GenerationError, type GenerationResult, type LlmProvider } from "../llm/types.js";
import { buildResearchContext, type PreparedResearchContext } from "./buildResearchContext.js";
import { extractJobProfile } from "./extractRequirements.js";
import { generateCompanyBrief } from "./generateCompanyBrief.js";
import { generateCoverageGaps } from "./generateCoverageGaps.js";
import { generateQuestions } from "./generateQuestions.js";
import { throwIfAborted } from "../../utils/abort.js";

export interface GenerateKitPipelineInput {
  jd: string;
  company_url: string;
  days: number;
  company_name?: string;
  role?: string;
  location?: string;
  userId?: string;
}

export interface GenerateKitPipelineOptions {
  provider?: LlmProvider;
  providerFactories?: Readonly<Record<string, LlmProviderFactory>>;
  llmConfig?: LlmConfig;
  research?: (input: { company_url: string; company_name?: string; role?: string }, options?: ResearchCompanyAndInterviewsOptions) => Promise<CombinedResearchResult>;
  researchOptions?: ResearchCompanyAndInterviewsOptions;
  signal?: AbortSignal;
  checkCoverage?: typeof defaultCheckCoverage;
  allocateSchedule?: typeof defaultBuildSchedule;
  validateKit?: (value: unknown) => CompleteKit;
  now?: () => number;
  researchContextMaxBytes?: number;
  researchContextMaxSources?: number;
  onDiagnostic?: (error: GenerationError) => void;
}

function emptyResearch(input: GenerateKitPipelineInput): CombinedResearchResult {
  let company = input.company_name?.trim() ?? "";
  if (!company) {
    try { company = new URL(input.company_url).hostname.replace(/^www\./i, ""); } catch { /* Keep unknown company empty. */ }
  }
  return { company_url: input.company_url, company_name: company, ...(input.role ? { role: input.role } : {}), company_sources: [], interview_sources: [], failed_sources: [], research_warnings: [] };
}

function validateBySchema(value: unknown): CompleteKit {
  const parsed = CompleteKitSchema.safeParse(value);
  if (!parsed.success) {
    throw new GenerationError("FINAL_VALIDATION_FAILED", "validation", "The generated kit failed final validation.", parsed.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join("; "));
  }
  return parsed.data as CompleteKit;
}

function failed(error: GenerationError, warnings: string[], uncovered: string[] = []): GenerationResult<CompleteKit> {
  return {
    status: "failed", kit: null, warnings, uncovered_requirement_ids: uncovered,
    error: { code: error.code, stage: error.stage, message: error.message },
  };
}

/** Sequences distinct model stages with deterministic coverage, scheduling, and final validation. */
export async function generateKit(input: GenerateKitPipelineInput, options: GenerateKitPipelineOptions = {}): Promise<GenerationResult<CompleteKit>> {
  const config = options.llmConfig ?? getLlmConfig();
  const fail = (error: GenerationError, warnings: string[], uncovered: string[] = []) => {
    try { options.onDiagnostic?.(error); } catch { /* Diagnostic logging must not change generation behavior. */ }
    return failed(error, warnings, uncovered);
  };
  let provider: LlmProvider;
  try { provider = options.provider ?? createLlmProvider(config, options.providerFactories); }
  catch (error) {
    return fail(error instanceof GenerationError ? error : new GenerationError("LLM_PROVIDER_UNAVAILABLE", "pipeline", "No LLM provider is configured.", error instanceof Error ? error.message : undefined), []);
  }
  try { throwIfAborted(options.signal); } catch (error) {
    return fail(new GenerationError("GENERATION_CANCELLED", "pipeline", "Generation was cancelled by its deadline."), []);
  }

  let requirements: Requirement[];
  let extractedRole: { title: string; seniority: string; responsibilities: string[] };
  try {
    const extracted = await extractJobProfile(input.jd, provider, { model: config.model, timeoutMs: config.timeoutMs, signal: options.signal });
    requirements = extracted.requirements;
    extractedRole = { title: extracted.title, seniority: extracted.seniority, responsibilities: extracted.responsibilities };
  }
  catch (error) {
    if (options.signal?.aborted) return fail(new GenerationError("GENERATION_CANCELLED", "pipeline", "Generation was cancelled by its deadline."), []);
    return fail(error instanceof GenerationError ? error : new GenerationError("REQUIREMENT_EXTRACTION_FAILED", "requirement_extraction", "Requirement extraction failed.", String(error)), []);
  }

  const warnings: string[] = [];
  const roleTitle = input.role?.trim() || extractedRole.title;
  let research: CombinedResearchResult;
  try {
    research = await (options.research ?? researchCompanyAndInterviews)({ company_url: input.company_url, company_name: input.company_name, role: roleTitle }, { ...options.researchOptions, signal: options.signal });
    warnings.push(...research.research_warnings);
    if (research.failed_sources.length && !warnings.includes("Some research sources failed; available evidence was retained.")) {
      warnings.push("Some research sources failed; available evidence was retained.");
    }
  } catch {
    if (options.signal?.aborted) return fail(new GenerationError("GENERATION_CANCELLED", "pipeline", "Generation was cancelled by its deadline."), warnings);
    research = emptyResearch(input);
    warnings.push("Company and interview research could not be completed; generation continued without research evidence.");
  }
  const context: PreparedResearchContext = buildResearchContext(research, {
    maxBytes: options.researchContextMaxBytes ?? config.researchContextMaxBytes,
    maxSources: options.researchContextMaxSources ?? config.researchContextMaxSources,
  });
  warnings.push(...context.warnings);

  let companyBrief;
  let questions;
  try {
    companyBrief = await generateCompanyBrief(context, provider, config, options.signal);
    questions = await generateQuestions({ requirements, role: roleTitle, research: context }, provider, { model: config.model, timeoutMs: config.timeoutMs, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return fail(new GenerationError("GENERATION_CANCELLED", "pipeline", "Generation was cancelled by its deadline."), warnings);
    const genError = error instanceof GenerationError
      ? error
      : new GenerationError("QUESTION_GENERATION_FAILED", "question_generation", "Question generation failed.", error instanceof Error ? error.message : "Unknown error.");
    return fail(genError, warnings);
  }

  const checkCoverage = options.checkCoverage ?? defaultCheckCoverage;
  let coverage;
  let coveragePasses = 1;
  try { coverage = checkCoverage(requirements, questions); }
  catch (error) {
    return fail(new GenerationError("COVERAGE_FAILURE", "validation", "Deterministic coverage checking failed.", error instanceof Error ? error.message : "Unknown coverage error."), warnings);
  }
  if (!coverage.passes) {
    const uncoveredSet = new Set(coverage.uncovered_requirement_ids);
    const uncoveredRequirements = requirements.filter((requirement) => uncoveredSet.has(requirement.id));
    try {
      const gapQuestions = await generateCoverageGaps({ uncoveredRequirements, role: roleTitle, research: context }, provider, { model: config.model, timeoutMs: config.timeoutMs, signal: options.signal });
      const merged = new Map(questions.map((question) => [question.id, question]));
      for (const question of gapQuestions) if (!merged.has(question.id)) merged.set(question.id, question);
      questions = [...merged.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      coveragePasses += 1;
      coverage = checkCoverage(requirements, questions);
    } catch (error) {
      if (options.signal?.aborted) return fail(new GenerationError("GENERATION_CANCELLED", "pipeline", "Generation was cancelled by its deadline."), warnings, coverage.uncovered_requirement_ids);
      const genError = error instanceof GenerationError ? error : new GenerationError("COVERAGE_FAILURE", "coverage_gap_generation", "The second coverage pass failed.", error instanceof Error ? error.message : "Unknown coverage error.");
      return fail(genError, warnings, coverage.uncovered_requirement_ids);
    }
  }
  if (!coverage.passes) {
    return fail(new GenerationError("COVERAGE_FAILURE", "coverage_gap_generation", "Must-have requirements remain uncovered after the second generation pass."), warnings, coverage.uncovered_requirement_ids);
  }
  const uncoveredNice = requirements.filter(({ id, priority }) => priority === "nice" && coverage.uncovered_requirement_ids.includes(id)).map(({ id }) => id);
  if (uncoveredNice.length) warnings.push("Some nice-to-have requirements remain uncovered.");

  let schedule;
  try { schedule = (options.allocateSchedule ?? defaultBuildSchedule)(requirements, questions, input.days); }
  catch (error) {
    return fail(new GenerationError("COVERAGE_FAILURE", "validation", "The deterministic schedule could not be built from the generated questions.", error instanceof Error ? error.message : "Unknown scheduler error."), warnings, coverage.uncovered_requirement_ids);
  }

  const urls = [...new Set([...research.company_sources.map(({ url }) => url), ...research.interview_sources.map(({ url }) => url)])];
  const companyName = research.company_name || input.company_name || "";
  const kit = {
    source: {
      company: companyName, company_url: input.company_url, role: roleTitle, location: input.location ?? "",
      jd_chars: input.jd.length, researched_at: new Date((options.now ?? Date.now)()).toISOString(), pages_used: urls,
    },
    company_brief: companyBrief,
    role: { title: roleTitle, seniority: extractedRole.seniority, responsibilities: extractedRole.responsibilities, requirements },
    questions,
    flashcards: [],
    schedule,
    coverage: { uncovered_requirement_ids: coverage.uncovered_requirement_ids, passes: coveragePasses },
  };
  try {
    const validated = (options.validateKit ?? validateBySchema)(kit);
    return {
      status: warnings.length ? "partial" : "ok", kit: validated,
      warnings: [...new Set(warnings)], uncovered_requirement_ids: coverage.uncovered_requirement_ids,
    };
  } catch (error) {
    const genError = error instanceof GenerationError ? error : new GenerationError("FINAL_VALIDATION_FAILED", "validation", "The generated kit failed final validation.", error instanceof Error ? error.message : "Unknown validation error.");
    return fail(genError, warnings, coverage.uncovered_requirement_ids);
  }
}
