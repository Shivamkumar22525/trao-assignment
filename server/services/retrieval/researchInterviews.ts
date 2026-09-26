import { getResearchConfig, type ResearchConfig } from "./config.js";
import { normalizeUrl } from "./discoverLinks.js";
import { extractPage } from "./extractPage.js";
import { fetchPage, type FetchPageOptions, type PageFetchResult } from "./fetchPage.js";
import { loadRobotsPolicy, type RobotsPolicy } from "./robots.js";
import { UrlValidationError, validateUrl } from "./urlSecurity.js";
import type { FailedSource, InterviewResearchProvider, InterviewResearchResult, InterviewResearchSource, InterviewSourceType, ResolvedAddress, SearchResult } from "./types.js";
import { abortReason, abortableDelay, raceWithAbort, throwIfAborted } from "../../utils/abort.js";

export interface ResearchInterviewsInput {
  company_url: string;
  company_name?: string;
  role?: string;
  search_terms?: string[];
}

export interface ResearchInterviewsOptions {
  provider?: InterviewResearchProvider;
  config?: Partial<ResearchConfig>;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetcher?: (url: string, options?: FetchPageOptions) => Promise<PageFetchResult>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

const INTERVIEW_TERMS = /\b(interview|hiring|recruit(?:ment|ing)?|candidate|rounds?|questions?|assessment|coding|technical|behavio[u]?ral|system design|experience)\b/i;
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "role", "engineer", "developer", "interview", "process", "company", "experience", "questions", "hiring", "technical", "coding"]);

function queryKey(value: string): string { return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " "); }

/** Stable and deliberately small query set; user-supplied terms are appended before the configured cap. */
export function buildInterviewSearchQueries(companyName: string, role?: string, searchTerms: readonly string[] = [], maxQueries = 6): string[] {
  const company = companyName.trim().replace(/\s+/g, " ");
  if (!company || maxQueries <= 0) return [];
  const title = role?.trim().replace(/\s+/g, " ");
  const candidates = [
    `${company} interview process`,
    ...(title ? [`${company} ${title} interview experience`] : []),
    `${company} technical interview`,
    `${company} coding interview`,
    `${company} hiring process`,
    ...(title ? [`${company} ${title} interview questions`] : []),
    ...searchTerms.map((term) => `${company} ${term.trim().replace(/\s+/g, " ")}`).filter((query) => query !== company),
  ];
  const seen = new Set<string>();
  return candidates.filter((query) => {
    const key = queryKey(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxQueries);
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function meaningfulCompanyTokens(company: string): string[] {
  return [...new Set(tokens(company).filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

function relevance(result: SearchResult, company: string, role?: string): number {
  const text = `${result.title} ${result.snippet} ${result.domain ?? ""}`.toLocaleLowerCase("en-US");
  const companyTokens = meaningfulCompanyTokens(company);
  const companyHits = companyTokens.filter((token) => text.includes(token)).length;
  const roleTokens = (role ? tokens(role) : []).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  const roleHits = roleTokens.filter((token) => text.includes(token)).length;
  const topical = INTERVIEW_TERMS.test(text);
  // Require company identity and topic evidence; a role match alone is insufficient.
  if (companyTokens.length > 0 && companyHits === 0) return -1;
  if (!topical) return -1;
  return 10 + companyHits * 4 + (roleTokens.length > 0 ? roleHits * 2 : 0) + (roleTokens.length > 0 && roleHits === roleTokens.length ? 2 : 0);
}

function inferSourceType(url: string, title: string, domain: string): InterviewSourceType {
  const value = `${url} ${title} ${domain}`.toLowerCase();
  if (/careers|jobs|hiring/.test(value)) return "company_hiring";
  if (/glassdoor|ambitionbox|interviewbit|teamblind|leetcode/.test(value)) return "candidate_experience";
  if (/reddit|quora|forum|discussion/.test(value)) return "discussion";
  if (/interview.?prep|questions|geeksforgeeks|educative/.test(value)) return "interview_prep";
  if (/blog|engineering|medium\.com|dev\.to/.test(value)) return "technical_blog";
  return "public_article";
}

function asFailure(url: string, result: Extract<PageFetchResult, { ok: false }>): FailedSource {
  return { url, code: result.error.code, message: result.error.message };
}

function emptySearchResult(input: ResearchInterviewsInput, companyName: string, queries: string[]): InterviewResearchResult {
  return {
    company_name: companyName, company_url: input.company_url,
    ...(input.role?.trim() ? { role: input.role.trim() } : {}),
    queries, sources: [], failed_sources: [], search_failures: [], warnings: [],
  };
}

/** Retrieves bounded public evidence. Returned page text remains untrusted data, never instructions. */
export async function researchInterviews(input: ResearchInterviewsInput, options: ResearchInterviewsOptions = {}): Promise<InterviewResearchResult> {
  const config = { ...getResearchConfig(), ...options.config };
  const companyName = input.company_name?.trim() || (() => {
    try { return new URL(input.company_url).hostname.replace(/^www\./i, ""); } catch { return ""; }
  })();
  const queries = buildInterviewSearchQueries(companyName, input.role, input.search_terms, config.interviewSearchMaxQueries);
  const result = emptySearchResult(input, companyName, queries);
  if (!options.provider) {
    result.search_failures.push({ query: "", code: "SEARCH_PROVIDER_NOT_CONFIGURED", message: "No public interview search provider is configured." });
    result.warnings.push("Public interview research is unavailable until a search provider is configured.");
    return result;
  }

  const ranked = new Map<string, { result: SearchResult; url: string; query: string; score: number; queryIndex: number }>();
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    throwIfAborted(options.signal);
    const query = queries[queryIndex];
    try {
      const results = await raceWithAbort(options.provider.search(query, { signal: options.signal }), options.signal);
      for (const candidate of results.slice(0, config.interviewSearchMaxResultsPerQuery)) {
        const canonical = normalizeUrl(candidate.url);
        if (!canonical) {
          result.failed_sources.push({ url: candidate.url, code: "INVALID_URL", message: "The search result URL is not a valid public HTTP(S) URL." });
          continue;
        }
        let domain: string;
        try { domain = new URL(canonical).hostname; } catch { continue; }
        const normalizedCandidate = { ...candidate, url: canonical, domain };
        const score = relevance(normalizedCandidate, companyName, input.role);
        if (score < 0) continue;
        const previous = ranked.get(canonical);
        if (!previous || score > previous.score || (score === previous.score && queryIndex < previous.queryIndex)) {
          ranked.set(canonical, { result: normalizedCandidate, url: canonical, query, score, queryIndex });
        }
      }
    } catch {
      if (options.signal?.aborted) throw abortReason(options.signal);
      result.search_failures.push({ query, code: "SEARCH_PROVIDER_ERROR", message: "The search provider failed for this query." });
    }
  }

  const candidates = [...ranked.values()].sort((a, b) => b.score - a.score || a.queryIndex - b.queryIndex || a.url.localeCompare(b.url));
  const fetcher = options.fetcher ?? fetchPage;
  const sleep = options.sleep ?? ((ms: number) => abortableDelay(ms, options.signal));
  const robotsByOrigin = new Map<string, Promise<RobotsPolicy>>();
  const requestTimes = new Map<string, number>();
  const beforeRequest = async (origin: string, crawlDelayMs = 0) => {
    const prior = requestTimes.get(origin);
    if (prior !== undefined) await raceWithAbort(sleep(Math.max(0, Math.max(config.minRequestIntervalMs, crawlDelayMs) - (Date.now() - prior))), options.signal);
    requestTimes.set(origin, Date.now());
  };
  let totalBytes = 0;
  for (const item of candidates.slice(0, config.interviewResearchMaxSources)) {
    throwIfAborted(options.signal);
    try {
      await validateUrl(item.url, { production: config.production, resolveHostname: options.resolveHostname, timeoutMs: config.requestTimeoutMs, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const code = error instanceof UrlValidationError ? error.code : "INVALID_URL";
      result.failed_sources.push({ url: item.url, code, message: error instanceof UrlValidationError ? error.message : "The search result URL could not be validated." });
      continue;
    }
    const origin = new URL(item.url).origin;
    let policyPromise = robotsByOrigin.get(origin);
    if (!policyPromise) {
      policyPromise = loadRobotsPolicy(origin, config, {
        fetcher: (url, fetchOptions) => fetcher(url, { ...fetchOptions, resolveHostname: options.resolveHostname, sleep, signal: options.signal }),
        beforeRequest: () => beforeRequest(origin),
      }).catch(() => ({
        url: new URL("/robots.txt", origin).href,
        status: "unavailable" as const,
        crawlDelayMs: 0,
        bytes: 0,
        isAllowed: () => false,
      }));
      robotsByOrigin.set(origin, policyPromise);
    }
    const policy = await policyPromise;
    if (policy.failure) result.failed_sources.push(policy.failure);
    if (policy.status === "blocked" || policy.status === "unavailable" || !policy.isAllowed(item.url)) {
      result.failed_sources.push({ url: item.url, code: policy.status === "blocked" || policy.status === "unavailable" ? "ROBOTS_CRAWL_BLOCKED" : "ROBOTS_DISALLOW", message: "The source was not fetched because robots policy did not permit safe access." });
      continue;
    }
    const remaining = config.interviewResearchMaxContentBytes - totalBytes;
    if (remaining <= 0) {
      result.failed_sources.push({ url: item.url, code: "TOTAL_BYTE_LIMIT", message: "The interview research content limit was reached." });
      continue;
    }
    let fetched: PageFetchResult;
    try {
      fetched = await fetcher(item.url, {
        config,
        maxResponseBytes: Math.min(config.maxResponseBytes, remaining),
        resolveHostname: options.resolveHostname,
        sleep,
        signal: options.signal,
        beforeRequest: () => beforeRequest(origin, policy.crawlDelayMs),
        redirectAllowed: (_from, to) => to.origin === origin && policy.isAllowed(to.href),
      });
    } catch {
      if (options.signal?.aborted) throw abortReason(options.signal);
      result.failed_sources.push({ url: item.url, code: "NETWORK_ERROR", message: "The source could not be fetched." });
      continue;
    }
    if (!fetched.ok) {
      result.failed_sources.push(asFailure(item.url, fetched));
      continue;
    }
    totalBytes += fetched.bytes;
    const extracted = extractPage(fetched.html);
    const title = extracted.title || item.result.title || item.url;
    result.sources.push({
      title, url: fetched.finalUrl, domain: new URL(fetched.finalUrl).hostname,
      snippet: item.result.snippet, content: extracted.text,
      ...(item.result.published_at ? { published_at: item.result.published_at } : {}),
      retrieved_at: new Date((options.now ?? Date.now)()).toISOString(),
      source_type: inferSourceType(fetched.finalUrl, title, new URL(fetched.finalUrl).hostname),
      matched_query: item.query,
    });
  }
  if (result.search_failures.length) result.warnings.push("Some interview searches failed; successful query results were retained.");
  if (result.failed_sources.length) result.warnings.push("Some public sources could not be safely retrieved; accessible sources were retained.");
  if (result.sources.length === 0 && result.search_failures.length === 0) result.warnings.push("No relevant public interview sources were retrieved.");
  return result;
}
