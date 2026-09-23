export interface ResearchConfig {
  maxPages: number;
  maxDepth: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxRedirects: number;
  maxCrawlDelayMs: number;
  userAgent: string;
  production: boolean;
  interviewSearchMaxQueries: number;
  interviewSearchMaxResultsPerQuery: number;
  interviewResearchMaxSources: number;
  interviewResearchMaxContentBytes: number;
}

function integerValue(value: string | undefined, fallback: number, minimum = 0): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function getResearchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  return {
    maxPages: integerValue(env.RESEARCH_MAX_PAGES, 8, 1),
    maxDepth: integerValue(env.RESEARCH_MAX_DEPTH, 2),
    maxResponseBytes: integerValue(env.RESEARCH_MAX_RESPONSE_BYTES, 2 * 1024 * 1024, 1),
    maxTotalBytes: integerValue(env.RESEARCH_MAX_TOTAL_BYTES, 8 * 1024 * 1024, 1),
    requestTimeoutMs: integerValue(env.RESEARCH_REQUEST_TIMEOUT_MS, 8_000, 1),
    minRequestIntervalMs: integerValue(env.RESEARCH_MIN_REQUEST_INTERVAL_MS, 500),
    maxRetries: integerValue(env.RESEARCH_MAX_RETRIES, 2),
    retryBaseDelayMs: integerValue(env.RESEARCH_RETRY_BASE_DELAY_MS, 300),
    retryMaxDelayMs: integerValue(env.RESEARCH_RETRY_MAX_DELAY_MS, 2_000),
    maxRedirects: integerValue(env.RESEARCH_MAX_REDIRECTS, 5),
    maxCrawlDelayMs: integerValue(env.RESEARCH_MAX_CRAWL_DELAY_MS, 10_000),
    userAgent: env.RESEARCH_USER_AGENT?.trim() || "TraoInterviewPrepBot/1.0 (company research crawler)",
    production: env.NODE_ENV === "production",
    interviewSearchMaxQueries: integerValue(env.INTERVIEW_SEARCH_MAX_QUERIES, 6, 1),
    interviewSearchMaxResultsPerQuery: integerValue(env.INTERVIEW_SEARCH_MAX_RESULTS_PER_QUERY, 5, 1),
    interviewResearchMaxSources: integerValue(env.INTERVIEW_RESEARCH_MAX_SOURCES, 8, 1),
    interviewResearchMaxContentBytes: integerValue(env.INTERVIEW_RESEARCH_MAX_CONTENT_BYTES, 2 * 1024 * 1024, 1),
  };
}
