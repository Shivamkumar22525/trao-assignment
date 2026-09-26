import type { Question, Requirement } from "../../types/kit.js";
import type { LlmProvider } from "../llm/types.js";
import type { PreparedResearchContext } from "./buildResearchContext.js";
import { generateQuestions } from "./generateQuestions.js";
import { GenerationError } from "../llm/types.js";

export interface GenerateCoverageGapsInput {
  uncoveredRequirements: readonly Requirement[];
  role?: string;
  research: PreparedResearchContext;
}

/** The second pass receives only uncovered requirements, never the full question bank. */
export async function generateCoverageGaps(input: GenerateCoverageGapsInput, provider: LlmProvider, options: { timeoutMs?: number; model?: string; signal?: AbortSignal } = {}): Promise<Question[]> {
  if (input.uncoveredRequirements.length === 0) return [];
  try {
    const questions = await generateQuestions({ requirements: input.uncoveredRequirements, role: input.role, research: input.research, stage: "coverage_gap_generation" }, provider, options);
    const allowedIds = new Set(input.uncoveredRequirements.map(({ id }) => id));
    if (questions.some((question) => question.requirement_ids.some((id) => !allowedIds.has(id)))) {
      throw new GenerationError("SCHEMA_VALIDATION_FAILED", "coverage_gap_generation", "Gap generation referenced a requirement outside the uncovered set.");
    }
    return questions;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : error;
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("QUESTION_GENERATION_FAILED", "coverage_gap_generation", "Second-pass question generation failed.", error instanceof Error ? error.message : "Unknown generation error.");
  }
}
