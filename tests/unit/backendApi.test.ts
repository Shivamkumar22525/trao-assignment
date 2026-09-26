import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: [] as Array<{ _id: string; email: string; passwordHash: string }>,
  sessions: [] as Array<{ userId: string; tokenHash: string; expiresAt: Date }>,
  kits: [] as Array<any>,
  jobs: [] as Array<Record<string, unknown>>,
  kitFilters: [] as Array<Record<string, unknown>>,
  kitListFilters: [] as Array<Record<string, unknown>>,
  jobUpdates: [] as Array<Record<string, unknown>>,
  practice: [] as Array<any>,
  generation: { status: "failed", kit: null as unknown, warnings: [] as string[], uncovered_requirement_ids: [] as string[], error: { code: "LLM_NOT_CONFIGURED" as const, stage: "pipeline" as const, message: "Set GEMINI_API_KEY." } },
}));

vi.mock("../../server/models/User.js", () => ({ UserModel: {
  create: vi.fn(async (values: { email: string; passwordHash: string }) => {
    if (state.users.some((user) => user.email === values.email)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    const user = { _id: `user-${state.users.length + 1}`, ...values };
    state.users.push(user);
    return user;
  }),
  findOne: vi.fn((filter: { email: string }) => ({ select: async () => state.users.find((user) => user.email === filter.email) ?? null })),
  findById: vi.fn((id: string) => ({ select: () => ({ lean: async () => {
    const user = state.users.find((candidate) => candidate._id === id);
    return user ? { _id: user._id, email: user.email } : null;
  } }) })),
} }));

vi.mock("../../server/models/Session.js", () => ({ SessionModel: {
  create: vi.fn(async (values: { userId: string; tokenHash: string; expiresAt: Date }) => { state.sessions.push(values); return values; }),
  findOne: vi.fn((filter: { tokenHash: string }) => ({ select: () => ({ lean: async () => {
    const session = state.sessions.find((candidate) => candidate.tokenHash === filter.tokenHash && candidate.expiresAt > new Date());
    return session ? { userId: session.userId } : null;
  } }) })),
  deleteOne: vi.fn(async ({ tokenHash }: { tokenHash: string }) => { state.sessions = state.sessions.filter((session) => session.tokenHash !== tokenHash); }),
} }));

vi.mock("../../server/models/Kit.js", () => ({ KitModel: {
  findOne: vi.fn((filter: Record<string, unknown>) => {
    state.kitFilters.push(filter);
    const found = state.kits.find((kit) => kit._id === String(filter._id) && kit.ownerId === filter.ownerId) ?? null;
    return { then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(found)), select: () => ({ lean: async () => found ? { _id: found._id } : null }) };
  }),
  find: vi.fn((filter: Record<string, unknown>) => {
    state.kitListFilters.push(filter);
    return { sort: () => ({ skip: (offset: number) => ({ limit: (limit: number) => ({ lean: async () => state.kits.filter((kit) => kit.ownerId === filter.ownerId).slice(offset, offset + limit) }) }) }) };
  }),
  countDocuments: vi.fn(async (filter: Record<string, unknown>) => state.kits.filter((kit) => kit.ownerId === filter.ownerId).length),
  updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, any>) => {
    const document = state.kits.find((kit) => kit._id === String(filter._id) && kit.ownerId === filter.ownerId && kit.revision === filter.revision);
    if (!document) return { modifiedCount: 0 };
    Object.assign(document, update.$set ?? {});
    document.revision += update.$inc?.revision ?? 0;
    document.updatedAt = new Date();
    return { modifiedCount: 1 };
  }),
  create: vi.fn(async (values: Record<string, any>) => {
    const document: any = {
      _id: "0123456789abcdef01234567", createdAt: new Date(), updatedAt: new Date(), ...values,
      save: async () => { document.updatedAt = new Date(); },
    };
    state.kits.push(document);
    return document;
  }),
  deleteOne: vi.fn(async (filter: Record<string, unknown>) => { state.kits = state.kits.filter((kit) => kit._id !== filter._id || kit.ownerId !== filter.ownerId); }),
} }));

vi.mock("../../server/models/GenerationJob.js", () => ({ GenerationJobModel: {
  create: vi.fn(async (values: Record<string, unknown>) => { const job = { _id: `job-${state.jobs.length + 1}`, ...values }; state.jobs.push(job); return job; }),
  updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => { state.jobUpdates.push({ filter, update }); }),
  deleteMany: vi.fn(),
} }));

vi.mock("../../server/models/PracticeProgress.js", () => ({ PracticeProgressModel: {
  deleteMany: vi.fn(),
  find: vi.fn((filter: any) => ({ lean: async () => state.practice.filter((item) => item.userId === filter.userId && item.kitId === filter.kitId && filter.flashcardId.$in.includes(item.flashcardId)) })),
  findOneAndUpdate: vi.fn((filter: any, update: any) => ({ lean: async () => {
    let record = state.practice.find((item) => item.userId === filter.userId && item.kitId === filter.kitId && item.flashcardId === filter.flashcardId);
    if (!record) { record = { ...update.$setOnInsert, attempts: 0 }; state.practice.push(record); }
    Object.assign(record, update.$set); record.attempts += update.$inc.attempts;
    return record;
  } })),
} }));
vi.mock("../../server/services/pipeline/generateKit.js", () => ({ generateKit: vi.fn(async () => state.generation) }));
vi.mock("../fixtures/valid-kit.js", () => ({ validKit: {
  source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 100, researched_at: "2026-01-01T00:00:00Z", pages_used: ["https://example.com"] },
  company_brief: { summary: "A sample company.", what_they_do: "Builds sample products.", sources: ["https://example.com"] },
  role: { title: "Engineer", seniority: "Senior", responsibilities: ["Build reliable services"], requirements: [{ id: "r1", text: "Experience with TypeScript", kind: "technical", priority: "must" }] },
  questions: [{ id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "How do you use TypeScript?", answer_outline: "Discuss practical examples.", difficulty: 2 }],
  flashcards: [{ id: "f1", front: "What is TypeScript?", back: "A typed superset of JavaScript.", requirement_ids: ["r1"] }],
  schedule: { days_available: 1, days: [{ day: 1, focus: "TypeScript", question_ids: ["q1"], minutes: 30 }] },
  coverage: { uncovered_requirement_ids: [], passes: 2 },
} }));

const { app } = await import("../../server/app.js");
const { validKit } = await import("../fixtures/valid-kit.js");
const { resetAbuseControlsForTests } = await import("../../server/middleware/abuseControls.js");
let server: Server;
let baseUrl: string;

async function register(email = "User@example.com"): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `  ${email} `, password: "password-123" }),
  });
  expect(response.status).toBe(201);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to start.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

beforeEach(() => {
  resetAbuseControlsForTests();
  state.users = []; state.sessions = []; state.kits = []; state.jobs = []; state.kitFilters = []; state.kitListFilters = []; state.jobUpdates = []; state.practice = [];
  state.generation = { status: "failed", kit: null, warnings: [], uncovered_requirement_ids: [], error: { code: "LLM_NOT_CONFIGURED", stage: "pipeline", message: "Set GEMINI_API_KEY." } };
});

describe("backend auth and kit routes", () => {
  it("rate-limits registration and login with generic sanitized responses", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${attempt}` },
        body: JSON.stringify({ email: "bad", password: "short" }),
      });
      expect(response.status).toBe(400);
    }
    const registerLimited = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.99" },
      body: JSON.stringify({ email: "bad", password: "short" }),
    });
    expect(registerLimited.status).toBe(429);
    expect(await registerLimited.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", password: "short" }),
      });
      expect(response.status).toBe(400);
    }
    const loginLimited = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "wrong-password" }),
    });
    expect(loginLimited.status).toBe(429);
    const loginBody = await loginLimited.text();
    expect(loginBody).toContain('"code":"RATE_LIMITED"');
    expect(loginBody).not.toContain("person@example.com");
    expect(loginBody).not.toContain("wrong-password");
  });

  it("rate-limits generation per authenticated user without trusting body identity", async () => {
    const cookie = await register();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/kits`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ jd: "", company_url: "https://example.com", days: 5, userId: `user-${attempt}` }),
      });
      expect(response.status).toBe(400);
    }
    const limited = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(limited.status).toBe(429);
    const limitedBody = await limited.json();
    expect(limitedBody).toEqual({ error: { code: "GENERATION_LIMITED", message: "Generation capacity is currently limited. Please try again later." } });
    expect(JSON.stringify(limitedBody)).not.toContain("user-");
    expect(state.jobs).toHaveLength(0);
  });

  it("enforces per-user concurrency atomically and releases reservations after failure", async () => {
    let notifyStarted!: () => void;
    let resolveGeneration!: (value: typeof state.generation) => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const pending = new Promise<typeof state.generation>((resolve) => { resolveGeneration = resolve; });
    const { generateKit } = await import("../../server/services/pipeline/generateKit.js");
    vi.mocked(generateKit).mockImplementationOnce(async () => { notifyStarted(); return pending; });
    const userACookie = await register("first@example.com");
    const firstRequest = fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie: userACookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    await started;

    const duplicate = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie: userACookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(duplicate.status).toBe(429);
    expect(await duplicate.json()).toEqual({ error: { code: "GENERATION_LIMITED", message: "Generation capacity is currently limited. Please try again later." } });

    const userBCookie = await register("second@example.com");
    const otherUser = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie: userBCookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(otherUser.status).toBe(502);

    resolveGeneration(state.generation);
    expect((await firstRequest).status).toBe(502);
    vi.mocked(generateKit).mockRejectedValueOnce(new Error("raw upstream secret detail"));
    const thrown = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie: userACookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).not.toContain("raw upstream secret detail");
    const subsequent = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie: userACookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(subsequent.status).toBe(502);
  });

  it("registers with a password hash and opaque HttpOnly session cookie, then serves current user", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: " User@Example.com ", password: "password-123" }),
    });
    const body = await response.json() as { user: { email: string }; session?: string; passwordHash?: string };
    const cookie = response.headers.get("set-cookie")!;
    expect(response.status).toBe(201);
    expect(body).toEqual({ user: { id: "user-1", email: "user@example.com" } });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(state.users[0]!.passwordHash).not.toBe("password-123");
    expect(state.sessions[0]!.tokenHash).not.toBe(cookie.split("=", 2)[1]!.split(";", 1)[0]);
    const current = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookie.split(";", 1)[0]! } });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ user: { id: "user-1", email: "user@example.com" } });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "USER@example.com", password: "password-123" }),
    });
    expect(login.status).toBe(200);
  }, 15_000);

  it("rejects malformed credentials and body-supplied user identifiers", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short", userId: "someone-else" }),
    });
    expect(response.status).toBe(400);
    expect(state.users).toHaveLength(0);
  });

  it("allows credentialed preflight only from the configured frontend origin", async () => {
    const allowed = await fetch(`${baseUrl}/api/kits`, { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    const rejected = await fetch(`${baseUrl}/api/kits`, { method: "OPTIONS", headers: { origin: "https://attacker.example" } });
    expect(rejected.status).toBe(403);
  });

  it("requires a session and applies owner scope to kit retrieval", async () => {
    const anonymous = await fetch(`${baseUrl}/api/kits/0123456789abcdef01234567`);
    expect(anonymous.status).toBe(401);
    const cookie = await register();
    const response = await fetch(`${baseUrl}/api/kits/0123456789abcdef01234567`, { headers: { cookie } });
    expect(response.status).toBe(404);
    expect(state.kitFilters.at(-1)).toMatchObject({ ownerId: "user-1", _id: "0123456789abcdef01234567" });
  });

  it("scopes list, edit, and delete operations to the authenticated owner", async () => {
    const cookie = await register();
    const listed = await fetch(`${baseUrl}/api/kits`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(state.kitListFilters.at(-1)).toEqual({ ownerId: "user-1" });
    const id = "0123456789abcdef01234567";
    const edited = await fetch(`${baseUrl}/api/kits/${id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ edits: [] }),
    });
    const deleted = await fetch(`${baseUrl}/api/kits/${id}`, { method: "DELETE", headers: { cookie } });
    expect(edited.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(state.kitFilters.slice(-2)).toEqual([{ _id: id, ownerId: "user-1" }, { _id: id, ownerId: "user-1" }]);
  });

  it("records generation failure as a failed job and calls the shared generation pipeline", async () => {
    const { generateKit } = await import("../../server/services/pipeline/generateKit.js");
    const cookie = await register();
    const response = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Full stack engineer", company_url: "https://example.com", days: 5 }),
    });
    expect(response.status).toBe(502);
    expect(generateKit).toHaveBeenCalledWith({ jd: "Full stack engineer", company_url: "https://example.com", days: 5 });
    expect(state.jobUpdates.at(-1)).toMatchObject({ update: { $set: { status: "failed", currentStage: "pipeline", progress: 100 } } });
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });

  it("persists the Appendix A kit, keeps edits separate, and supports list, retrieval, edit, and delete", async () => {
    state.generation = { status: "ok", kit: validKit, warnings: [], uncovered_requirement_ids: [] };
    const cookie = await register();
    const created = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer role", company_url: "https://example.com", days: 1 }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { kit: { id: string; generated_kit: unknown; editor_state: unknown } };
    expect(createdBody.kit.generated_kit).toEqual(validKit);
    expect(createdBody.kit.editor_state).toEqual({ edits: [] });
    state.generation = { status: "failed", kit: null, warnings: [], uncovered_requirement_ids: [], error: { code: "LLM_NOT_CONFIGURED", stage: "pipeline", message: "Provider unavailable." } };
    const afterSuccessfulGeneration = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Another engineer role", company_url: "https://example.com", days: 1 }),
    });
    expect(afterSuccessfulGeneration.status).toBe(502);
    expect(state.kits).toHaveLength(1);
    const path = `/api/kits/${createdBody.kit.id}`;
    const edited = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ path: "/company_brief/summary", value: "My edited summary", state: "pinned" }] }),
    });
    const editedBody = await edited.json() as { kit: { generated_kit: { company_brief: { summary: string } }; effective_kit: { company_brief: { summary: string } }; editor_state: { edits: { state: string }[] } } };
    expect(editedBody.kit.generated_kit.company_brief.summary).toBe("A sample company.");
    expect(editedBody.kit.effective_kit.company_brief.summary).toBe("My edited summary");
    expect(editedBody.kit.editor_state.edits[0]!.state).toBe("pinned");
    const stale = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 0, edits: [{ path: "/company_brief/summary", value: "Stale overwrite" }] }),
    });
    expect(stale.status).toBe(409);
    const missingEditValue = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ path: "/company_brief/summary" }] }),
    });
    expect(missingEditValue.status).toBe(400);
    const removedMustCoverage = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, edits: [{ path: "/questions", value: [] }] }),
    });
    expect(removedMustCoverage.status).toBe(400);
    const unknownRequirement = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, edits: [{ path: "/questions", value: [{ ...validKit.questions[0]!, requirement_ids: ["missing"] }] }] }),
    });
    expect(unknownRequirement.status).toBe(400);
    expect((await fetch(`${baseUrl}/api/kits`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}${path}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}${path}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect(state.kits).toHaveLength(0);
  });

  it("regenerates one question category while preserving pinned questions and unrelated user edits", async () => {
    state.generation = { status: "ok", kit: validKit, warnings: [], uncovered_requirement_ids: [] };
    const cookie = await register();
    const created = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer role", company_url: "https://example.com", days: 1 }),
    });
    const { kit: createdKit } = await created.json() as { kit: { id: string } };
    const path = `/api/kits/${createdKit.id}`;
    const pinnedQuestion = { ...validKit.questions[0]!, prompt: "My pinned question" };
    const saved = await fetch(`${baseUrl}${path}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 0, edits: [
        { path: "/questions", value: [pinnedQuestion], state: "edited" },
        { path: "/questions/0", value: pinnedQuestion, state: "pinned" },
        { path: "/company_brief/summary", value: "My pinned company note", state: "pinned" },
      ] }),
    });
    expect(saved.status).toBe(200);
    state.generation = { status: "partial", kit: {
      ...validKit,
      company_brief: { ...validKit.company_brief, summary: "Fresh generated company brief" },
      questions: [{ ...validKit.questions[0]!, id: "q-fresh", prompt: "Fresh generated question" }],
      schedule: { days_available: 1, days: [{ day: 1, focus: "Technical fundamentals", question_ids: ["q-fresh"], minutes: 35 }] },
    }, warnings: ["Partial research"], uncovered_requirement_ids: [] };
    const { generateKit } = await import("../../server/services/pipeline/generateKit.js");
    const response = await fetch(`${baseUrl}${path}/regenerate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, section: "question_category", category: "technical" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { kit: { revision: number; generated_kit: typeof validKit; editor_state: { edits: { path: string; state: string }[] }; effective_kit: typeof validKit } };
    expect(generateKit).toHaveBeenLastCalledWith({ jd: "Engineer role", company_url: "https://example.com", days: 1 });
    expect(body.kit.generated_kit.questions.map(({ id }) => id)).toContain("q-fresh");
    expect(body.kit.effective_kit.questions.map(({ id }) => id)).toEqual([validKit.questions[0]!.id, "q-fresh"]);
    expect(body.kit.effective_kit.questions[0]!.prompt).toBe("My pinned question");
    expect(body.kit.generated_kit.company_brief.summary).toBe("A sample company.");
    expect(body.kit.effective_kit.company_brief.summary).toBe("My pinned company note");
    expect(body.kit.effective_kit.coverage.uncovered_requirement_ids).toEqual([]);
    expect(body.kit.effective_kit.schedule.days[0]!.question_ids).toEqual(["q-fresh", validKit.questions[0]!.id]);
    expect(body.kit.editor_state.edits.some(({ path, state: editState }) => path === "/questions/0" && editState === "pinned")).toBe(true);
    expect(body.kit.revision).toBe(2);

    state.generation = { status: "partial", kit: { ...validKit, company_brief: { ...validKit.company_brief, summary: "Regenerated brief" } }, warnings: ["Research warnings retained."], uncovered_requirement_ids: [] };
    const briefResponse = await fetch(`${baseUrl}${path}/regenerate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: 2, section: "company_brief" }),
    });
    expect(briefResponse.status).toBe(200);
    const briefBody = await briefResponse.json() as { kit: { revision: number; generated_kit: typeof validKit; effective_kit: typeof validKit }; generation: { status: string; warnings: string[] } };
    expect(briefBody.kit.generated_kit.company_brief.summary).toBe("Regenerated brief");
    expect(briefBody.kit.effective_kit.company_brief.summary).toBe("My pinned company note");
    expect(briefBody.generation).toMatchObject({ status: "partial", warnings: ["Research warnings retained."] });
    expect(briefBody.kit.revision).toBe(3);
  });

  it("validates and owner-scopes section regeneration", async () => {
    const anonymous = await fetch(`${baseUrl}/api/kits/0123456789abcdef01234567/regenerate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ section: "company_brief" }),
    });
    expect(anonymous.status).toBe(401);
    const cookie = await register();
    const invalid = await fetch(`${baseUrl}/api/kits/0123456789abcdef01234567/regenerate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ section: "not-a-section" }),
    });
    expect(invalid.status).toBe(400);
    const otherOwner = await fetch(`${baseUrl}/api/kits/0123456789abcdef01234567/regenerate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ section: "company_brief" }),
    });
    expect(otherOwner.status).toBe(404);
    expect(state.kitFilters.at(-1)).toMatchObject({ ownerId: "user-1", _id: "0123456789abcdef01234567" });
  });

  it("persists owner-scoped practice progress and validates effective flashcard IDs", async () => {
    const cookie = await register();
    const id = "0123456789abcdef01234567";
    state.kits.push({ _id: id, ownerId: "user-1", originalInput: { days: 1 }, kit: validKit, editorState: { edits: [] }, revision: 0 });
    const path = `/api/kits/${id}/practice-progress`;
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    const initial = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ progress: [] });
    const invalid = await fetch(`${baseUrl}${path}/missing`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ covered: true }) });
    expect(invalid.status).toBe(400);
    const invalidBody = await fetch(`${baseUrl}${path}/f1`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ covered: true, userId: "user-2" }) });
    expect(invalidBody.status).toBe(400);
    const mark = async (covered: boolean) => fetch(`${baseUrl}${path}/f1`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ covered }) });
    expect((await mark(true)).status).toBe(200);
    expect((await mark(true)).status).toBe(200);
    expect((await mark(false)).status).toBe(200);
    expect(state.practice).toHaveLength(1);
    expect(state.practice[0]).toMatchObject({ userId: "user-1", kitId: id, flashcardId: "f1", covered: false, attempts: 3 });
    const listed = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    expect(await listed.json()).toMatchObject({ progress: [{ flashcard_id: "f1", covered: false, attempts: 3 }] });
    const otherOwnerCookie = await register("other@example.com");
    const otherOwner = await fetch(`${baseUrl}${path}/f1`, { method: "PATCH", headers: { cookie: otherOwnerCookie, "content-type": "application/json" }, body: JSON.stringify({ covered: true }) });
    expect(otherOwner.status).toBe(404);
    expect(state.practice).toHaveLength(1);
  });

  it("does not overwrite edits committed while section regeneration is running", async () => {
    state.generation = { status: "ok", kit: validKit, warnings: [], uncovered_requirement_ids: [] };
    const cookie = await register();
    const created = await fetch(`${baseUrl}/api/kits`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jd: "Engineer role", company_url: "https://example.com", days: 1 }),
    });
    const { kit: createdKit } = await created.json() as { kit: { id: string; revision: number } };
    const { generateKit } = await import("../../server/services/pipeline/generateKit.js");
    vi.mocked(generateKit).mockImplementationOnce(async () => {
      state.kits[0]!.editorState = { edits: [{ path: "/company_brief/summary", value: "Concurrent saved edit", state: "pinned" }] };
      state.kits[0]!.revision += 1;
      return { status: "ok", kit: validKit, warnings: [], uncovered_requirement_ids: [] };
    });
    const response = await fetch(`${baseUrl}/api/kits/${createdKit.id}/regenerate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ revision: createdKit.revision, section: "company_brief" }),
    });
    expect(response.status).toBe(409);
    expect(state.kits[0]!.editorState).toEqual({ edits: [{ path: "/company_brief/summary", value: "Concurrent saved edit", state: "pinned" }] });
  });

  it("revokes a session on logout", async () => {
    const cookie = await register();
    const response = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const current = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(current.status).toBe(401);
  });
});
