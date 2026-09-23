import type { CompleteKit } from "../types/kit.js";

export type KitSection = "company_brief" | "question_category" | "schedule";

export interface GenerateKitInput {
  jd: string;
  company_url: string;
  days: number;
  userId?: string;
}

export interface RegenerateSectionInput {
  kit: CompleteKit;
  section: KitSection;
  category?: CompleteKit["questions"][number]["category"];
}

export interface CoverageResult {
  uncoveredRequirementIds: string[];
}

export interface KitGenerationService {
  generateKit(input: GenerateKitInput): Promise<CompleteKit>;
  regenerateSection(input: RegenerateSectionInput): Promise<CompleteKit>;
  checkCoverage(kit: CompleteKit): CoverageResult;
  allocateSchedule(kit: CompleteKit, days: number): CompleteKit["schedule"];
  validateKit(value: unknown): CompleteKit;
}
