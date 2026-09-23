export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ExtractedLink {
  anchorText: string;
  href: string;
}

export interface DiscoveredLink extends ExtractedLink {
  url: string;
}

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  links: ExtractedLink[];
}

export interface ResearchSource {
  url: string;
  requested_url: string;
  title: string;
  description: string;
  content: string;
  content_type: string;
  fetched_at: string;
}

export interface FailedSource {
  url: string;
  code: string;
  message: string;
}

export type RobotsStatus = "available" | "missing" | "blocked" | "unavailable";

export interface CompanyResearchResult {
  company_url: string;
  pages: ResearchSource[];
  failed_sources: FailedSource[];
  /** Structured, provenance-preserving input for a later company-brief stage. */
  summary_inputs: ResearchSource[];
  robots: {
    url: string;
    status: RobotsStatus;
    crawl_delay_ms: number;
  };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain?: string;
  published_at?: string;
}

export interface InterviewResearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

export type InterviewSourceType = "company_hiring" | "candidate_experience" | "technical_blog" | "discussion" | "interview_prep" | "public_article" | "other";

export interface InterviewResearchSource {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  content: string;
  published_at?: string;
  retrieved_at: string;
  source_type: InterviewSourceType;
  matched_query: string;
}

export interface InterviewResearchResult {
  company_name: string;
  company_url: string;
  role?: string;
  queries: string[];
  sources: InterviewResearchSource[];
  failed_sources: FailedSource[];
  search_failures: Array<{ query: string; code: string; message: string }>;
  warnings: string[];
}

export interface CombinedResearchResult {
  company_url: string;
  company_name: string;
  role?: string;
  company_sources: ResearchSource[];
  interview_sources: InterviewResearchSource[];
  failed_sources: Array<FailedSource & { stage: "company" | "interview" | "search" }>;
  research_warnings: string[];
}
