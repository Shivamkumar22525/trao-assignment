import { describe, expect, it } from "vitest";
import { getResearchConfig } from "../../server/services/retrieval/config.js";
import { fetchPage, type FetchTransport } from "../../server/services/retrieval/fetchPage.js";

const config = {
  ...getResearchConfig({ NODE_ENV: "test" }),
  maxRetries: 0,
  minRequestIntervalMs: 0,
  maxRedirects: 2,
};
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];
const response = (status: number, contentType = "text/html", body = "<h1>Example</h1>", headers: Record<string, string> = {}) => ({
  status,
  headers: { "content-type": contentType, ...headers },
  body: new TextEncoder().encode(body),
});

describe("fetchPage", () => {
  it("returns fetched HTML with final URL, type, status, and byte size", async () => {
    const transport: FetchTransport = async (_url, _addresses, options) => {
      expect(options.userAgent).toMatch(/TraoInterviewPrepBot/);
      return response(200);
    };
    await expect(fetchPage("https://example.com/", { config, resolveHostname: resolvePublic, transport }))
      .resolves.toMatchObject({ ok: true, finalUrl: "https://example.com/", contentType: "text/html", status: 200, bytes: 16 });
  });

  it("rejects unsupported content types", async () => {
    const result = await fetchPage("https://example.com/", {
      config,
      resolveHostname: resolvePublic,
      transport: async () => response(200, "application/pdf", "%PDF"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
  });

  it("rejects a body exceeding the configured byte limit", async () => {
    const result = await fetchPage("https://example.com/", {
      config,
      maxResponseBytes: 5,
      resolveHostname: resolvePublic,
      transport: async () => response(200, "text/html", "123456"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
  });

  it("revalidates redirects and rejects a redirect to loopback", async () => {
    let calls = 0;
    const result = await fetchPage("https://example.com/", {
      config,
      resolveHostname: resolvePublic,
      transport: async () => { calls += 1; return response(302, "text/html", "", { location: "http://127.0.0.1/private" }); },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_ADDRESS" } });
    expect(calls).toBe(1);
  });

  it("can reject a safe but cross-domain redirect for company crawling", async () => {
    const result = await fetchPage("https://example.com/", {
      config,
      resolveHostname: resolvePublic,
      redirectAllowed: (_from, to) => to.hostname.endsWith("example.com"),
      transport: async () => response(302, "text/html", "", { location: "https://elsewhere.example.net/" }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CROSS_DOMAIN_REDIRECT" } });
  });

  it("retries temporary statuses with bounded backoff and Retry-After", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await fetchPage("https://example.com/", {
      config: { ...config, maxRetries: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 500 },
      resolveHostname: resolvePublic,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      transport: async () => {
        calls += 1;
        return calls === 1
          ? response(503, "text/html", "busy", { "retry-after": "0.01" })
          : response(200);
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
  });

  it("does not retry a permanent 404 and returns a structured error", async () => {
    let calls = 0;
    const result = await fetchPage("https://example.com/missing", {
      config: { ...config, maxRetries: 3 },
      resolveHostname: resolvePublic,
      transport: async () => { calls += 1; return response(404); },
    });
    expect(result).toMatchObject({ ok: false, status: 404, error: { code: "HTTP_ERROR", message: "The source returned HTTP 404." } });
    expect(calls).toBe(1);
  });

  it("does not retry before a Retry-After delay that exceeds its bounded retry window", async () => {
    let calls = 0;
    const result = await fetchPage("https://example.com/", {
      config: { ...config, maxRetries: 3, retryMaxDelayMs: 500 },
      resolveHostname: resolvePublic,
      transport: async () => {
        calls += 1;
        return response(429, "text/html", "slow down", { "retry-after": "60" });
      },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "HTTP_ERROR", message: "The source requested a retry delay beyond the configured limit; no early retry was sent." },
    });
    expect(calls).toBe(1);
  });

  it("does not expose raw transport errors", async () => {
    const result = await fetchPage("https://example.com/", {
      config,
      resolveHostname: resolvePublic,
      transport: async () => { throw new Error("secret socket detail"); },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR", message: "The page could not be fetched due to a network error." } });
    expect(JSON.stringify(result)).not.toContain("secret socket detail");
  });
});
