import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiRequest, ApiError } from "../../client/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("frontend API client", () => {
  it("sends cookie credentials and matches the backend login contract", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { id: "u1", email: "person@example.com" } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.login({ email: "person@example.com", password: "password-123" });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/auth/login");
    expect(options).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(options.body))).toEqual({ email: "person@example.com", password: "password-123" });
    expect(JSON.stringify(options)).not.toContain("GEMINI_API_KEY");
  });

  it("posts a single kit request to the authenticated generation endpoint", async () => {
    const payload = { jd: "Role description", company_url: "https://company.example", days: 5, company_name: "Company", role: "Engineer" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ job: { id: "job-1", status: "succeeded" }, kit: { id: "kit-9" } }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await api.generateKit(payload);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/kits");
    expect(options).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(options.body))).toEqual(payload);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(result.kit.id).toBe("kit-9");
  });

  it("saves editor overlays with their revision and calls the typed section regeneration endpoint", async () => {
    const kit = { id: "kit-9" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ kit }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.updateKit("kit-9", 4, [{ path: "/questions", value: [], state: "edited" }]);
    let [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/kits/kit-9");
    expect(options).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(JSON.parse(String(options.body))).toEqual({ revision: 4, edits: [{ path: "/questions", value: [], state: "edited" }] });

    await api.regenerateKitSection("kit-9", 5, { section: "question_category", category: "technical" });
    [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toContain("/api/kits/kit-9/regenerate");
    expect(options).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(options.body))).toEqual({ revision: 5, section: "question_category", category: "technical" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses safe fallback errors for non-JSON and unreadable responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Unavailable</html>", { status: 503, headers: { "content-type": "text/html" } })));
    await expect(apiRequest("/api/auth/me")).rejects.toMatchObject({ name: "ApiError", status: 503, message: "Request failed (503)." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })));
    await expect(apiRequest("/api/auth/me")).rejects.toMatchObject({ name: "ApiError", code: "INVALID_RESPONSE" });
  });

  it("preserves sanitized backend error codes and handles 204 responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(api.currentUser()).rejects.toMatchObject({ name: "ApiError", status: 401, code: "UNAUTHENTICATED" } satisfies Partial<ApiError>);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it("classifies an aborted request as a generation timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Aborted", "AbortError"); }));
    await expect(apiRequest("/api/kits", { method: "POST", body: "{}", signal: controller.signal })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 0 });
  });
});
