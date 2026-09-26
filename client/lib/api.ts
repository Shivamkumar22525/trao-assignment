export interface ApiUser { id: string; email: string; }

export interface AppendixKit {
  source: { company: string; company_url: string; role: string; location: string; jd_chars: number; researched_at: string; pages_used: string[] };
  company_brief: { summary: string; what_they_do: string; sources: string[] };
  role: { title: string; seniority: string; responsibilities: string[]; requirements: { id: string; text: string; kind: "technical" | "behavioural" | "domain"; priority: "must" | "nice" }[] };
  questions: { id: string; requirement_ids: string[]; category: "technical" | "behavioural" | "system-design" | "company-fit"; prompt: string; answer_outline: string; difficulty: 1 | 2 | 3 }[];
  flashcards: { id: string; front: string; back: string; requirement_ids: string[] }[];
  schedule: { days_available: number; days: { day: number; focus: string; question_ids: string[]; minutes: number }[] };
  coverage: { uncovered_requirement_ids: string[]; passes: number };
}
export type KitQuestion = AppendixKit["questions"][number];
export type KitFlashcard = AppendixKit["flashcards"][number];

export interface KitRecord {
  id: string;
  original_input: { jd: string; company_url: string; days: number; company_name?: string; role?: string; location?: string };
  generated_kit: AppendixKit;
  editor_state: { edits: { path: string; value: unknown; state: "edited" | "pinned" }[] };
  effective_kit: AppendixKit;
  revision: number;
  created_at?: string;
  updated_at?: string;
}

export interface KitListResponse { kits: KitRecord[]; page: number; limit: number; total: number; }
export interface PracticeProgress { flashcard_id: string; covered: boolean; attempts: number; last_practiced_at?: string; }
export interface GenerateKitInput {
  jd: string;
  company_url: string;
  days: number;
  company_name?: string;
  role?: string;
  location?: string;
}
export interface GenerateKitResponse { job: { id: string; status: "succeeded" }; kit: KitRecord; }
export type KitEdit = { path: string; value: unknown; state?: "edited" | "pinned" };
export type RegenerateKitSectionInput = { section: "company_brief" } | { section: "question_category"; category: AppendixKit["questions"][number]["category"] };
export interface ApiErrorBody { error?: { code?: string; message?: string }; }
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, credentials: "include" });
  } catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new ApiError("The request timed out. Generation may still finish on the server; check your dashboard before trying again.", 0, "REQUEST_TIMEOUT");
    }
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0, "NETWORK_ERROR");
  }

  let payload: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try { payload = await response.json(); } catch { payload = undefined; }
  }
  if (!response.ok) {
    const body = payload && typeof payload === "object" ? payload as ApiErrorBody : undefined;
    const message = typeof body?.error?.message === "string" ? body.error.message : `Request failed (${response.status}).`;
    const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
    throw new ApiError(message, response.status, code, payload);
  }
  if (response.status === 204) return undefined as T;
  if (payload === undefined) throw new ApiError("The server returned an unreadable response.", response.status, "INVALID_RESPONSE");
  return payload as T;
}

export const api = {
  register: (input: { email: string; password: string }) => apiRequest<{ user: ApiUser }>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) => apiRequest<{ user: ApiUser }>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => apiRequest<void>("/api/auth/logout", { method: "POST" }),
  currentUser: () => apiRequest<{ user: ApiUser }>("/api/auth/me"),
  generateKit: (input: GenerateKitInput) => apiRequest<GenerateKitResponse>("/api/kits", {
    method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(300_000),
  }),
  listKits: (page = 1, limit = 20) => apiRequest<KitListResponse>(`/api/kits?page=${page}&limit=${limit}`),
  getKit: (id: string) => apiRequest<{ kit: KitRecord }>(`/api/kits/${encodeURIComponent(id)}`),
  updateKit: (id: string, revision: number, edits: KitEdit[]) => apiRequest<{ kit: KitRecord }>(`/api/kits/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ revision, edits }),
  }),
  regenerateKitSection: (id: string, revision: number, input: RegenerateKitSectionInput) => apiRequest<{ kit: KitRecord; generation: { status: "ok" | "partial"; warnings: string[]; uncovered_requirement_ids: string[] } }>(`/api/kits/${encodeURIComponent(id)}/regenerate`, {
    method: "POST", body: JSON.stringify({ revision, ...input }),
    signal: AbortSignal.timeout(300_000),
  }),
  getPracticeProgress: (id: string) => apiRequest<{ progress: PracticeProgress[] }>(`/api/kits/${encodeURIComponent(id)}/practice-progress`),
  markFlashcard: (id: string, flashcardId: string, covered: boolean) => apiRequest<{ progress: PracticeProgress }>(`/api/kits/${encodeURIComponent(id)}/practice-progress/${encodeURIComponent(flashcardId)}`, {
    method: "PATCH", body: JSON.stringify({ covered }),
  }),
  deleteKit: (id: string) => apiRequest<void>(`/api/kits/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export function readableApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Please try again.";
}
