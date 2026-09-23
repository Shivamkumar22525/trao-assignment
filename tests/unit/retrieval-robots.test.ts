import { describe, expect, it } from "vitest";
import { getResearchConfig } from "../../server/services/retrieval/config.js";
import { loadRobotsPolicy, parseRobotsTxt } from "../../server/services/retrieval/robots.js";
import type { PageFetchResult } from "../../server/services/retrieval/fetchPage.js";

const config = { ...getResearchConfig({ NODE_ENV: "test" }), minRequestIntervalMs: 0 };
const pageResult = (url: string, body: string, bytes = body.length): PageFetchResult => ({
  ok: true, url, finalUrl: url, status: 200, contentType: "text/plain", html: body, bytes,
});

describe("robots.txt", () => {
  it("applies longest matching allow/disallow rules and crawl-delay", () => {
    const decide = parseRobotsTxt(`User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 2.5`, "TraoInterviewPrepBot/1.0");
    expect(decide("https://example.com/private/data")).toEqual({ allowed: false, crawlDelayMs: 2_500 });
    expect(decide("https://example.com/private/public/info")).toEqual({ allowed: true, crawlDelayMs: 2_500 });
    expect(decide("https://example.com/jobs")).toEqual({ allowed: true, crawlDelayMs: 2_500 });
  });

  it("prefers a matching crawler-specific group over wildcard rules", () => {
    const decide = parseRobotsTxt(`User-agent: *
Disallow: /

User-agent: TraoInterviewPrepBot
Allow: /research`, "TraoInterviewPrepBot/1.0");
    expect(decide("https://example.com/research").allowed).toBe(true);
    expect(decide("https://example.com/other").allowed).toBe(true);
  });

  it("keeps blank-line-separated user-agent groups independent", () => {
    const robots = "User-agent: *\n\nUser-agent: TraoInterviewPrepBot\nDisallow: /bot-only";
    expect(parseRobotsTxt(robots, "TraoInterviewPrepBot/1.0", 10_000)("https://example.com/bot-only").allowed).toBe(false);
    expect(parseRobotsTxt(robots, "OtherBot/1.0", 10_000)("https://example.com/bot-only").allowed).toBe(true);
  });

  it("treats a missing robots file as no published restrictions", async () => {
    const policy = await loadRobotsPolicy("https://example.com", config, {
      fetcher: async (url) => ({ ok: false, url, status: 404, error: { code: "HTTP_ERROR", message: "Not found" } }),
    });
    expect(policy.status).toBe("missing");
    expect(policy.isAllowed("https://example.com/about")).toBe(true);
  });

  it("fails closed and reports robots server failures", async () => {
    const policy = await loadRobotsPolicy("https://example.com", config, {
      fetcher: async (url) => ({ ok: false, url, status: 503, error: { code: "HTTP_ERROR", message: "Unavailable" } }),
    });
    expect(policy.status).toBe("unavailable");
    expect(policy.isAllowed("https://example.com/about")).toBe(false);
    expect(policy.failure).toMatchObject({ code: "ROBOTS_UNAVAILABLE" });
  });

  it("reports crawl delay from a retrieved policy", async () => {
    const policy = await loadRobotsPolicy("https://example.com", config, {
      fetcher: async (url) => pageResult(url, "User-agent: *\nAllow: /\nCrawl-delay: 1"),
    });
    expect(policy.status).toBe("available");
    expect(policy.crawlDelayMs).toBe(1_000);
  });

  it("blocks rather than crawling faster than an excessive requested delay", async () => {
    const policy = await loadRobotsPolicy("https://example.com", { ...config, maxCrawlDelayMs: 100 }, {
      fetcher: async (url) => pageResult(url, "User-agent: *\nCrawl-delay: 5"),
    });
    expect(policy.status).toBe("blocked");
    expect(policy.crawlDelayMs).toBe(5_000);
    expect(policy.isAllowed("https://example.com/about")).toBe(false);
    expect(policy.failure).toMatchObject({ code: "ROBOTS_CRAWL_DELAY_LIMIT" });
  });
});
