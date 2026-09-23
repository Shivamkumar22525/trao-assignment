import { describe, expect, it } from "vitest";
import { getResearchConfig } from "../../server/services/retrieval/config.js";
import { InMemoryInterviewResearchProvider } from "../../server/services/retrieval/interviewResearchProvider.js";
import { buildInterviewSearchQueries, researchInterviews } from "../../server/services/retrieval/researchInterviews.js";
import type { PageFetchResult } from "../../server/services/retrieval/fetchPage.js";
import type { SearchResult } from "../../server/services/retrieval/types.js";

const config = { ...getResearchConfig({ NODE_ENV: "test" }), interviewSearchMaxQueries: 6, interviewSearchMaxResultsPerQuery: 5, interviewResearchMaxSources: 8, interviewResearchMaxContentBytes: 100_000, maxResponseBytes: 100_000, minRequestIntervalMs: 0 };
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];
const ok = (url: string, html: string): PageFetchResult => ({ ok: true, url, finalUrl: url, status: 200, contentType: "text/html", html, bytes: Buffer.byteLength(html) });
const source = (url: string, title = "Acme interview process", snippet = "Acme candidate interview rounds and coding assessment"): SearchResult => ({ title, url, snippet, published_at: "2025-01-01" });
const input = { company_url: "https://acme.example/", company_name: "Acme", role: "Backend Engineer" };
const allowRobotsFetcher = async (url: string): Promise<PageFetchResult> => url.endsWith("/robots.txt") ? ok(url, "User-agent: *\nAllow: /") : ok(url, "<html><head><title>Acme interview</title></head><body><h1>Acme interview process</h1><p>Public candidate interview rounds.</p></body></html>");

describe("public interview research", () => {
  it("builds company-only queries", () => expect(buildInterviewSearchQueries("Acme", undefined, [], 6)).toContain("Acme interview process"));
  it("includes company and role in role queries", () => expect(buildInterviewSearchQueries("Acme", "Backend Engineer")).toContain("Acme Backend Engineer interview experience"));
  it("removes duplicate queries deterministically", () => expect(buildInterviewSearchQueries("Acme", undefined, ["interview process"]).filter((q) => q === "Acme interview process")).toHaveLength(1));
  it("bounds query count", () => expect(buildInterviewSearchQueries("Acme", "Backend Engineer", ["remote"], 3)).toHaveLength(3));

  it("retains relevant company interview results with provenance", async () => {
    const provider = new InMemoryInterviewResearchProvider({ "Acme interview process": [source("https://public.example/acme-interview")] });
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher: allowRobotsFetcher, sleep: async () => {}, now: () => 0 });
    expect(result.sources[0]).toMatchObject({ url: "https://public.example/acme-interview", domain: "public.example", matched_query: "Acme interview process", published_at: "2025-01-01", source_type: "public_article", content: "Acme interview process\nPublic candidate interview rounds." });
  });
  it("filters clearly unrelated results", async () => {
    const provider = new InMemoryInterviewResearchProvider({ "Acme interview process": [source("https://public.example/other", "Globex interview process", "Globex hiring and candidate rounds")] });
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher: allowRobotsFetcher, sleep: async () => {} });
    expect(result.sources).toEqual([]);
  });
  it("deduplicates canonical URLs across queries", async () => {
    const provider = { search: async () => [source("https://public.example/acme-interview?utm_source=x")] };
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher: allowRobotsFetcher, sleep: async () => {} });
    expect(result.sources).toHaveLength(1);
  });
  it("preserves optional search provider published date", async () => {
    const provider = new InMemoryInterviewResearchProvider({ "Acme interview process": [source("https://public.example/acme")] });
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher: allowRobotsFetcher, sleep: async () => {}, now: () => 1 });
    expect(result.sources[0].retrieved_at).toBe("1970-01-01T00:00:00.001Z");
    expect(result.sources[0].published_at).toBe("2025-01-01");
  });
  it("retains successful pages when another source fails", async () => {
    const provider = { search: async () => [source("https://public.example/a"), source("https://public.example/b")] };
    const fetcher = async (url: string): Promise<PageFetchResult> => url.endsWith("/robots.txt") ? ok(url, "User-agent: *\nAllow: /") : url.endsWith("/b") ? { ok: false, url, status: 403, error: { code: "HTTP_ERROR", message: "Forbidden" } } : allowRobotsFetcher(url);
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher, sleep: async () => {} });
    expect(result.sources).toHaveLength(1);
    expect(result.failed_sources).toContainEqual({ url: "https://public.example/b", code: "HTTP_ERROR", message: "Forbidden" });
  });
  it("returns structured provider failures", async () => {
    const provider = new InMemoryInterviewResearchProvider({}, new Set(["Acme interview process"]));
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, sleep: async () => {} });
    expect(result.search_failures[0]).toMatchObject({ query: "Acme interview process", code: "SEARCH_PROVIDER_ERROR" });
  });
  it("records a source rejected by robots", async () => {
    const provider = { search: async () => [source("https://public.example/private")] };
    const fetcher = async (url: string): Promise<PageFetchResult> => url.endsWith("/robots.txt") ? ok(url, "User-agent: *\nDisallow: /private") : ok(url, "unexpected");
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher, sleep: async () => {} });
    expect(result.failed_sources.some(({ code }) => code === "ROBOTS_DISALLOW")).toBe(true);
  });
  it("rejects unsafe URLs through the URL security layer before fetching", async () => {
    const provider = { search: async () => [source("http://127.0.0.1/private")] };
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, fetcher: async () => { throw new Error("must not fetch"); }, sleep: async () => {} });
    expect(result.failed_sources[0].code).toBe("UNSAFE_ADDRESS");
  });
  it("records unsupported content returned by the shared fetch layer", async () => {
    const provider = { search: async () => [source("https://public.example/file")] };
    const fetcher = async (url: string): Promise<PageFetchResult> => url.endsWith("/robots.txt") ? ok(url, "User-agent: *\nAllow: /") : { ok: false, url, status: 200, error: { code: "UNSUPPORTED_CONTENT_TYPE", message: "The source did not return supported text content." } };
    const result = await researchInterviews({ ...input, role: undefined }, { provider, config, resolveHostname: resolvePublic, fetcher, sleep: async () => {} });
    expect(result.failed_sources[0].code).toBe("UNSUPPORTED_CONTENT_TYPE");
  });
});
