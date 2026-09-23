import type { ResearchConfig } from "./config.js";
import { fetchPage } from "./fetchPage.js";
import type { PageFetchResult } from "./fetchPage.js";
import type { FailedSource, RobotsStatus } from "./types.js";

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs?: number;
  hasDirectives: boolean;
}

export interface RobotsPolicy {
  url: string;
  status: RobotsStatus;
  crawlDelayMs: number;
  bytes: number;
  failure?: FailedSource;
  isAllowed(url: string): boolean;
}

export type RobotsFetcher = (url: string, options: Parameters<typeof fetchPage>[1]) => Promise<PageFetchResult>;

function emptyPolicy(url: string, status: RobotsStatus, crawlDelayMs: number, failure?: FailedSource, bytes = 0): RobotsPolicy {
  return {
    url,
    status,
    crawlDelayMs,
    bytes,
    ...(failure ? { failure } : {}),
    isAllowed: () => status !== "blocked" && status !== "unavailable",
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function ruleMatches(rulePath: string, targetPath: string): boolean {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith("$");
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*").map(escapeRegex).join(".*");
  try {
    return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(targetPath);
  } catch {
    return false;
  }
}

/** Parse robots groups for the named product token and apply longest-match rules. */
export function parseRobotsTxt(text: string, targetUserAgent: string): (url: string) => { allowed: boolean; crawlDelayMs: number } {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup = { agents: [], rules: [], hasDirectives: false };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) {
      if (current.agents.length > 0) {
        groups.push(current);
        current = { agents: [], rules: [], hasDirectives: false };
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "user-agent") {
      if (current.hasDirectives) {
        groups.push(current);
        current = { agents: [], rules: [], hasDirectives: false };
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (current.agents.length === 0) continue;
    if (name === "allow" || name === "disallow") {
      current.hasDirectives = true;
      if (value) current.rules.push({ allow: name === "allow", path: value });
    } else if (name === "crawl-delay") {
      current.hasDirectives = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = seconds * 1000;
    }
  }
  if (current.agents.length > 0) groups.push(current);

  const productToken = targetUserAgent.split(/[\s/]/, 1)[0].toLowerCase();
  const matches = groups.map((group) => ({
    group,
    specificity: Math.max(-1, ...group.agents.map((agent) => agent === "*" ? 0 : productToken.startsWith(agent) ? agent.length : -1)),
  })).filter(({ specificity }) => specificity >= 0);
  const bestSpecificity = Math.max(-1, ...matches.map(({ specificity }) => specificity));
  const selected = matches.filter(({ specificity }) => specificity === bestSpecificity).map(({ group }) => group);
  const rules = selected.flatMap(({ rules: groupRules }) => groupRules);
  const crawlDelayMs = selected.reduce((delay, group) => Math.max(delay, group.crawlDelayMs ?? 0), 0);

  return (inputUrl: string) => {
    let targetPath = "/";
    try {
      const url = new URL(inputUrl);
      targetPath = `${url.pathname}${url.search}`;
    } catch { /* A malformed target remains at the conservative root path. */ }
    const matching = rules.filter(({ path }) => ruleMatches(path, targetPath));
    const longest = Math.max(0, ...matching.map(({ path }) => path.replace(/[\*$]/g, "").length));
    const mostSpecific = matching.filter(({ path }) => path.replace(/[\*$]/g, "").length === longest);
    const allowed = mostSpecific.length === 0 || mostSpecific.some(({ allow }) => allow);
    return { allowed, crawlDelayMs };
  };
}

export async function loadRobotsPolicy(
  origin: string,
  config: ResearchConfig,
  options: {
    fetcher?: RobotsFetcher;
    beforeRequest?: () => Promise<void>;
  } = {},
): Promise<RobotsPolicy> {
  const robotsUrl = new URL("/robots.txt", origin).href;
  const fetcher = options.fetcher ?? fetchPage;
  const result = await fetcher(robotsUrl, { config, beforeRequest: options.beforeRequest });

  if (!result.ok) {
    if (result.status === 404) return emptyPolicy(robotsUrl, "missing", 0);
    const blocked = result.status === 401 || result.status === 403;
    const code = blocked ? "ROBOTS_FORBIDDEN" : "ROBOTS_UNAVAILABLE";
    const message = blocked
      ? "Robots policy could not be read; crawling is blocked for safety."
      : "Robots policy could not be retrieved; crawling is blocked for safety.";
    return emptyPolicy(robotsUrl, blocked ? "blocked" : "unavailable", 0, { url: robotsUrl, code, message });
  }

  const decide = parseRobotsTxt(result.html, config.userAgent);
  const rootDecision = decide(new URL("/", origin).href);
  if (rootDecision.crawlDelayMs > config.maxCrawlDelayMs) {
    return emptyPolicy(robotsUrl, "blocked", rootDecision.crawlDelayMs, {
      url: robotsUrl,
      code: "ROBOTS_CRAWL_DELAY_LIMIT",
      message: "The requested robots.txt crawl delay exceeds the configured limit; crawling is blocked rather than ignoring it.",
    }, result.bytes);
  }
  return {
    url: robotsUrl,
    status: "available",
    crawlDelayMs: rootDecision.crawlDelayMs,
    bytes: result.bytes,
    isAllowed: (url) => decide(url).allowed,
  };
}
