import { describe, expect, it } from "vitest";
import { getResearchConfig } from "../../server/services/retrieval/config.js";
import { researchCompany } from "../../server/services/retrieval/researchCompany.js";
import type { PageFetchResult } from "../../server/services/retrieval/fetchPage.js";

const htmlResult = (url: string, html: string): PageFetchResult => ({
  ok: true,
  url,
  finalUrl: url,
  status: 200,
  contentType: "text/html",
  html,
  bytes: Buffer.byteLength(html),
});

const config = {
  ...getResearchConfig({ NODE_ENV: "test" }),
  maxPages: 3,
  maxDepth: 2,
  maxResponseBytes: 100_000,
  maxTotalBytes: 200_000,
  minRequestIntervalMs: 0,
};
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];
const robotsText = "User-agent: *\nAllow: /";

describe("researchCompany", () => {
  it("preserves successful sources and records one failed page without aborting", async () => {
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<PageFetchResult> => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return htmlResult(url, robotsText);
      if (url === "https://example.com/") return htmlResult(url, `<html><head><title>Acme</title></head><body>
        <main><h1>About Acme</h1><p>Acme builds tools.</p>
        <a href="/careers">Careers</a><a href="/about">About us</a><a href="/team">Team</a></main>
        </body></html>`);
      if (url === "https://example.com/about") return htmlResult(url, "<html><body><h1>About</h1><p>Useful details.</p></body></html>");
      if (url === "https://example.com/careers") return {
        ok: false, url, status: 404, error: { code: "HTTP_ERROR", message: "The source returned HTTP 404." },
      };
      return { ok: false, url, error: { code: "NETWORK_ERROR", message: "Unavailable." } };
    };

    const result = await researchCompany("https://example.com/", {
      config,
      resolveHostname: resolvePublic,
      fetcher,
      now: () => Date.parse("2026-09-23T00:00:00Z"),
      sleep: async () => {},
    });
    expect(requested).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/careers",
    ]);
    expect(result.pages.map(({ url }) => url)).toEqual(["https://example.com/", "https://example.com/about"]);
    expect(result.pages[1]).toMatchObject({ title: "About", content: "About\nUseful details.", fetched_at: "2026-09-23T00:00:00.000Z" });
    expect(result.failed_sources).toEqual([{
      url: "https://example.com/careers", code: "HTTP_ERROR", message: "The source returned HTTP 404.",
    }]);
    expect(result.summary_inputs).toEqual(result.pages);
    expect(result.robots).toMatchObject({ status: "available", crawl_delay_ms: 0 });
  });

  it("respects the page bound and still records the homepage", async () => {
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<PageFetchResult> => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return htmlResult(url, robotsText);
      return htmlResult(url, `<html><body><h1>Company</h1><p>Company information.</p>
        <a href="/about">About</a><a href="/careers">Careers</a></body></html>`);
    };
    const result = await researchCompany("https://example.com/", {
      config: { ...config, maxPages: 1 }, resolveHostname: resolvePublic, fetcher, sleep: async () => {},
    });
    expect(result.pages).toHaveLength(1);
    expect(requested).toEqual(["https://example.com/robots.txt", "https://example.com/"]);
  });

  it("does not crawl when robots.txt is unavailable", async () => {
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<PageFetchResult> => {
      requested.push(url);
      return { ok: false, url, status: 503, error: { code: "HTTP_ERROR", message: "Unavailable" } };
    };
    const result = await researchCompany("https://example.com/", {
      config, resolveHostname: resolvePublic, fetcher, sleep: async () => {},
    });
    expect(requested).toEqual(["https://example.com/robots.txt"]);
    expect(result.pages).toEqual([]);
    expect(result.failed_sources.map(({ code }) => code)).toEqual(["ROBOTS_UNAVAILABLE", "ROBOTS_CRAWL_BLOCKED"]);
  });
});
