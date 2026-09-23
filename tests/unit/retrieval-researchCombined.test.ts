import { describe, expect, it } from "vitest";
import { getResearchConfig } from "../../server/services/retrieval/config.js";
import { researchCompanyAndInterviews } from "../../server/services/retrieval/researchCompanyAndInterviews.js";
import type { PageFetchResult } from "../../server/services/retrieval/fetchPage.js";

const config = { ...getResearchConfig({ NODE_ENV: "test" }), maxPages: 1, maxDepth: 0, maxResponseBytes: 100_000, maxTotalBytes: 100_000, minRequestIntervalMs: 0, interviewSearchMaxQueries: 1, interviewSearchMaxResultsPerQuery: 5, interviewResearchMaxSources: 3, interviewResearchMaxContentBytes: 100_000 };
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];
const html = (url: string, body: string): PageFetchResult => ({ ok: true, url, finalUrl: url, status: 200, contentType: "text/html", html: body, bytes: Buffer.byteLength(body) });
const fetcher = async (url: string): Promise<PageFetchResult> => {
  if (url.endsWith("/robots.txt")) return html(url, "User-agent: *\nAllow: /");
  if (new URL(url).hostname === "acme.example") return html(url, "<html><head><title>Acme | Home</title></head><body><h1>Acme</h1><p>Company information.</p></body></html>");
  return html(url, "<html><head><title>Acme interview process</title></head><body><h1>Acme interview process</h1><p>Candidate reports public interview stages.</p></body></html>");
};
const provider = { search: async () => [{ title: "Acme interview process", url: "https://public.example/interview", snippet: "Acme candidate interview rounds and assessment" }] };

describe("combined research orchestration", () => {
  const run = () => researchCompanyAndInterviews({ company_url: "https://acme.example/", role: "Backend Engineer" }, {
    company: { config, resolveHostname: resolvePublic, fetcher, sleep: async () => {}, now: () => 0 },
    interviews: { config, resolveHostname: resolvePublic, fetcher, provider, sleep: async () => {}, now: () => 0 },
  });

  it("preserves company website sources separately", async () => expect((await run()).company_sources[0].title).toBe("Acme | Home"));
  it("preserves public interview sources separately", async () => expect((await run()).interview_sources[0].matched_query).toBe("Acme interview process"));
  it("preserves stage-labelled failures", async () => {
    const result = await researchCompanyAndInterviews({ company_url: "http://127.0.0.1/", company_name: "Acme" }, { interviews: { config, provider: { search: async () => { throw new Error("search down"); } } } });
    expect(result.failed_sources.map(({ stage }) => stage)).toContain("search");
    expect(result.failed_sources.map(({ stage }) => stage)).toContain("company");
  });
  it("preserves partial-research warnings", async () => {
    const result = await researchCompanyAndInterviews({ company_url: "https://acme.example/", company_name: "Acme" }, { company: { config, resolveHostname: resolvePublic, fetcher: async (url) => url.endsWith("/robots.txt") ? html(url, "User-agent: *\nAllow: /") : { ok: false, url, status: 503, error: { code: "HTTP_ERROR", message: "Unavailable" } }, sleep: async () => {} }, interviews: { config, provider: undefined } });
    expect(result.research_warnings).toEqual(expect.arrayContaining([expect.stringContaining("company website"), expect.stringContaining("search provider")]));
  });
  it("is deterministic for identical inputs and injected times", async () => expect(await run()).toEqual(await run()));
});
