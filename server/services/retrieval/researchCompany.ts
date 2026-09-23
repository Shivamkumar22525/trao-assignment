import { getResearchConfig, type ResearchConfig } from "./config.js";
import { discoverLinks, isSameCompanyDomain, normalizeUrl } from "./discoverLinks.js";
import { extractPage } from "./extractPage.js";
import { fetchPage, type FetchPageOptions, type PageFetchResult } from "./fetchPage.js";
import { rankLinks } from "./rankLinks.js";
import { loadRobotsPolicy, type RobotsFetcher } from "./robots.js";
import { UrlValidationError, validateUrl } from "./urlSecurity.js";
import type { CompanyResearchResult, DiscoveredLink, FailedSource, ResearchSource, ResolvedAddress } from "./types.js";

export interface ResearchCompanyOptions {
  config?: Partial<ResearchConfig>;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetcher?: (url: string, options?: FetchPageOptions) => Promise<PageFetchResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface CrawlCandidate extends DiscoveredLink {
  score: number;
  depth: number;
}

function sourceFailure(url: string, result: Extract<PageFetchResult, { ok: false }>): FailedSource {
  return { url, code: result.error.code, message: result.error.message };
}

function compareCandidates(left: CrawlCandidate, right: CrawlCandidate): number {
  return right.score - left.score
    || left.depth - right.depth
    || (left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
}

function safelyParseUrl(input: string): URL | undefined {
  try { return new URL(input); } catch { return undefined; }
}

/**
 * Performs a bounded, sequential company-site crawl. Website text is preserved
 * as source data only; callers must keep it separate from application/model
 * instructions and must never execute or follow instructions found in it.
 */
export async function researchCompany(
  companyUrl: string,
  options: ResearchCompanyOptions = {},
): Promise<CompanyResearchResult> {
  const config: ResearchConfig = { ...getResearchConfig(), ...options.config };
  const fetcher = options.fetcher ?? fetchPage;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const result: CompanyResearchResult = {
    company_url: companyUrl,
    pages: [],
    failed_sources: [],
    summary_inputs: [],
    robots: { url: "", status: "unavailable", crawl_delay_ms: 0 },
  };

  let safeCompanyUrl: string;
  try {
    const validated = await validateUrl(companyUrl, {
      production: config.production,
      resolveHostname: options.resolveHostname,
      timeoutMs: config.requestTimeoutMs,
    });
    safeCompanyUrl = normalizeUrl(validated.url.href) ?? validated.url.href;
  } catch (error) {
    const code = error instanceof UrlValidationError ? error.code : "INVALID_URL";
    const message = error instanceof UrlValidationError ? error.message : "The company URL could not be validated.";
    result.failed_sources.push({ url: companyUrl, code, message });
    const parsed = safelyParseUrl(companyUrl);
    result.robots.url = parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")
      ? new URL("/robots.txt", parsed.origin).href
      : "";
    return result;
  }

  const companyDomainUrl = new URL(safeCompanyUrl);
  const origin = companyDomainUrl.origin;
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: CrawlCandidate[] = [];
  const maxQueuedLinks = config.maxPages * 25;
  let requestedPages = 0;
  let totalBytes = 0;
  let minIntervalMs = config.minRequestIntervalMs;
  let lastRequestStartedAt: number | undefined;
  const beforeRequest = async () => {
    if (lastRequestStartedAt !== undefined) {
      const waitMs = Math.max(0, minIntervalMs - (now() - lastRequestStartedAt));
      if (waitMs > 0) await sleep(waitMs);
    }
    lastRequestStartedAt = now();
  };

  const safeFetcher = async (url: string, fetchOptions?: FetchPageOptions): Promise<PageFetchResult> => {
    try {
      return await fetcher(url, fetchOptions);
    } catch {
      return { ok: false, url, error: { code: "NETWORK_ERROR", message: "The page could not be fetched due to a network error." } };
    }
  };
  const robotFetcher: RobotsFetcher = (url, fetchOptions) => safeFetcher(url, {
    ...fetchOptions,
    maxResponseBytes: Math.min(config.maxResponseBytes, config.maxTotalBytes),
    resolveHostname: options.resolveHostname,
    sleep,
    now,
  });
  const robots = await loadRobotsPolicy(origin, config, { fetcher: robotFetcher, beforeRequest });
  result.robots = { url: robots.url, status: robots.status, crawl_delay_ms: robots.crawlDelayMs };
  totalBytes += robots.bytes;
  if (robots.failure) result.failed_sources.push(robots.failure);
  minIntervalMs = Math.max(minIntervalMs, robots.crawlDelayMs);

  if (robots.status === "blocked" || robots.status === "unavailable") {
    result.failed_sources.push({
      url: safeCompanyUrl,
      code: "ROBOTS_CRAWL_BLOCKED",
      message: "Company pages were not fetched because robots.txt could not be read safely.",
    });
    return result;
  }
  if (!robots.isAllowed(safeCompanyUrl)) {
    result.failed_sources.push({
      url: safeCompanyUrl,
      code: "ROBOTS_DISALLOW",
      message: "The company URL is disallowed by robots.txt.",
    });
    return result;
  }

  const enqueueLinks = (sourceUrl: string, pageTitle: string, links: readonly { anchorText: string; href: string }[], depth: number) => {
    if (depth >= config.maxDepth) return;
    const discovered = discoverLinks(links, sourceUrl, safeCompanyUrl);
    const ranked = rankLinks(discovered, pageTitle)
      .filter(({ score, url }) => score > 0 && !visited.has(url) && !queued.has(url));
    for (const link of ranked) {
      queue.push({ ...link, depth: depth + 1 });
      queued.add(link.url);
    }
    queue.sort(compareCandidates);
    if (queue.length > maxQueuedLinks) {
      const removed = queue.splice(maxQueuedLinks);
      for (const link of removed) queued.delete(link.url);
    }
  };

  const fetchAndStore = async (url: string): Promise<{ source: ResearchSource; links: DiscoveredLink[] } | undefined> => {
    const remainingBytes = config.maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      result.failed_sources.push({ url, code: "TOTAL_BYTE_LIMIT", message: "The research byte limit was reached before this page could be fetched." });
      return undefined;
    }
    const pageResult = await safeFetcher(url, {
      config,
      maxResponseBytes: Math.min(config.maxResponseBytes, remainingBytes),
      resolveHostname: options.resolveHostname,
      beforeRequest,
      sleep,
      now,
      redirectAllowed: (_from, to) => isSameCompanyDomain(to.href, safeCompanyUrl),
    });
    requestedPages += 1;
    if (!pageResult.ok) {
      result.failed_sources.push(sourceFailure(url, pageResult));
      return undefined;
    }

    totalBytes += pageResult.bytes;
    const extracted = extractPage(pageResult.html);
    const source: ResearchSource = {
      url: pageResult.finalUrl,
      requested_url: url,
      title: extracted.title,
      description: extracted.description,
      content: extracted.text,
      content_type: pageResult.contentType,
      fetched_at: new Date(now()).toISOString(),
    };
    result.pages.push(source);
    return {
      source,
      links: discoverLinks(extracted.links, pageResult.finalUrl, safeCompanyUrl),
    };
  };

  visited.add(safeCompanyUrl);
  const homepage = await fetchAndStore(safeCompanyUrl);
  if (homepage) enqueueLinks(homepage.source.url, homepage.source.title, homepage.links, 0);

  while (queue.length > 0 && requestedPages < config.maxPages && totalBytes < config.maxTotalBytes) {
    queue.sort(compareCandidates);
    const candidate = queue.shift();
    if (!candidate) break;
    queued.delete(candidate.url);
    if (visited.has(candidate.url)) continue;
    visited.add(candidate.url);

    if (!robots.isAllowed(candidate.url)) {
      result.failed_sources.push({
        url: candidate.url,
        code: "ROBOTS_DISALLOW",
        message: "The page was skipped because robots.txt disallows this path.",
      });
      continue;
    }

    const fetched = await fetchAndStore(candidate.url);
    if (fetched) enqueueLinks(fetched.source.url, fetched.source.title, fetched.links, candidate.depth);
  }

  // Each summary input retains its own URL/title/content provenance; no anonymous concatenation.
  result.summary_inputs = [...result.pages];
  return result;
}
