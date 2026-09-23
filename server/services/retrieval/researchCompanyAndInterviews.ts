import { researchCompany, type ResearchCompanyOptions } from "./researchCompany.js";
import { researchInterviews, type ResearchInterviewsOptions } from "./researchInterviews.js";
import type { CombinedResearchResult, CompanyResearchResult, InterviewResearchResult } from "./types.js";

export interface ResearchCompanyAndInterviewsInput {
  company_url: string;
  company_name?: string;
  role?: string;
  search_terms?: string[];
}

export interface ResearchCompanyAndInterviewsOptions {
  company?: ResearchCompanyOptions;
  interviews?: ResearchInterviewsOptions;
}

function inferCompanyName(input: ResearchCompanyAndInterviewsInput, company: CompanyResearchResult): string {
  if (input.company_name?.trim()) return input.company_name.trim();
  const title = company.pages.find((page) => page.title.trim())?.title.trim();
  if (title) {
    const candidate = title.split(/\s+[|–—:-]\s+/)[0].trim();
    if (candidate) return candidate;
  }
  try { return new URL(input.company_url).hostname.replace(/^www\./i, ""); } catch { return ""; }
}

/** Runs both retrieval stages independently and keeps their evidence collections separate. */
export async function researchCompanyAndInterviews(
  input: ResearchCompanyAndInterviewsInput,
  options: ResearchCompanyAndInterviewsOptions = {},
): Promise<CombinedResearchResult> {
  let company: CompanyResearchResult;
  try {
    company = await researchCompany(input.company_url, options.company);
  } catch {
    company = { company_url: input.company_url, pages: [], summary_inputs: [], failed_sources: [{ url: input.company_url, code: "COMPANY_RESEARCH_ERROR", message: "Company website research could not be completed." }], robots: { url: "", status: "unavailable", crawl_delay_ms: 0 } };
  }
  const companyName = inferCompanyName(input, company);
  let interviews: InterviewResearchResult;
  try {
    interviews = await researchInterviews({ ...input, company_name: companyName }, options.interviews);
  } catch {
    interviews = {
      company_name: companyName, company_url: input.company_url,
      ...(input.role ? { role: input.role } : {}), queries: [], sources: [],
      failed_sources: [], search_failures: [{ query: "", code: "INTERVIEW_RESEARCH_ERROR", message: "Public interview research could not be completed." }],
      warnings: ["Public interview research could not be completed; company website research remains available."],
    };
  }
  const failed_sources: CombinedResearchResult["failed_sources"] = [
    ...company.failed_sources.map((failure) => ({ ...failure, stage: "company" as const })),
    ...interviews.failed_sources.map((failure) => ({ ...failure, stage: "interview" as const })),
    ...interviews.search_failures.map((failure) => ({ url: failure.query, code: failure.code, message: failure.message, stage: "search" as const })),
  ];
  const research_warnings = [
    ...(company.failed_sources.length ? ["Some company website sources were unavailable; successful pages were retained."] : []),
    ...interviews.warnings,
  ];
  return {
    company_url: input.company_url,
    company_name: companyName,
    ...(input.role?.trim() ? { role: input.role.trim() } : {}),
    company_sources: company.pages,
    interview_sources: interviews.sources,
    failed_sources,
    research_warnings: [...new Set(research_warnings)],
  };
}
