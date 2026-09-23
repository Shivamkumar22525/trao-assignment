import type { CompleteKit, Question, Requirement, Schedule } from "../types/kit.js";
import type { CombinedResearchResult } from "./retrieval/types.js";
import type { GenerationResult } from "./llm/types.js";

export type { CombinedResearchResult, InterviewResearchProvider } from "./retrieval/types.js";

export interface ResearchService {
  research(input: { company_url: string; company_name?: string; role?: string; search_terms?: string[] }): Promise<CombinedResearchResult>;
}

export interface MultiStageKitGenerationService {
  generateKit(input: GenerateKitInput & { company_name?: string; role?: string; location?: string }): Promise<GenerationResult<CompleteKit>>;
}

export type KitSection = "company_brief" | "question_category" | "schedule";

export interface GenerateKitInput {
  jd: string;
  company_url: string;
  days: number;
  userId?: string;
}

export type RegenerateSectionInput =
  | { kit: CompleteKit; section: "company_brief" }
  | { kit: CompleteKit; section: "question_category"; category: CompleteKit["questions"][number]["category"] }
  | { kit: CompleteKit; section: "schedule" };

export interface CoverageResult {
  uncovered_requirement_ids: string[];
  passes: boolean;
}

export interface KitGenerationService {
  generateKit(input: GenerateKitInput): Promise<CompleteKit>;
  regenerateSection(input: RegenerateSectionInput): Promise<CompleteKit>;
  checkCoverage(requirements: readonly Requirement[], questions: readonly Question[]): CoverageResult;
  allocateSchedule(requirements: readonly Requirement[], questions: readonly Question[], daysAvailable: number): Schedule;
  validateKit(value: unknown): CompleteKit;
}
