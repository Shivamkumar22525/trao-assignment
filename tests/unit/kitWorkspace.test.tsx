// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getKit: vi.fn(), updateKit: vi.fn(), regenerateKitSection: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "kit-42" }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../client/lib/api", () => {
  class TestApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
  return { api: mocks, ApiError: TestApiError, readableApiError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error." };
});

import KitWorkspacePage from "../../client/app/(authenticated)/kits/[id]/page";
import { ApiError } from "../../client/lib/api";

const question = { id: "q1", requirement_ids: ["r1"], category: "technical" as const, prompt: "How do you use TypeScript?", answer_outline: "Give an example.", difficulty: 2 as const };
const baseRecord = {
  id: "kit-42", original_input: { jd: "role", company_url: "https://acme.example", days: 2 },
  generated_kit: {
    source: { company: "Acme", company_url: "https://acme.example", role: "Engineer", location: "Remote", jd_chars: 4, researched_at: "2026-01-01", pages_used: ["https://acme.example/about", "https://interviews.example/acme"] },
    company_brief: { summary: "Original summary", what_they_do: "Builds tools", sources: ["https://acme.example/about"] },
    role: { title: "Engineer", seniority: "Senior", responsibilities: ["Build software"], requirements: [{ id: "r1", text: "TypeScript experience", kind: "technical" as const, priority: "must" as const }, { id: "r2", text: "Mentoring", kind: "behavioural" as const, priority: "nice" as const }] },
    questions: [question], flashcards: [{ id: "f1", front: "What is TS?", back: "Typed JavaScript", requirement_ids: ["r1"] }],
    schedule: { days_available: 2, days: [{ day: 1, focus: "Technical", question_ids: ["q1"], minutes: 35 }, { day: 2, focus: "Review", question_ids: [], minutes: 15 }] },
    coverage: { uncovered_requirement_ids: ["r2"], passes: 2 },
  },
  editor_state: { edits: [] as { path: string; value: unknown; state: "edited" | "pinned" }[] }, revision: 3,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
};

function record(overrides: Record<string, any> = {}) {
  const generated = structuredClone(baseRecord.generated_kit);
  const effective = structuredClone(generated);
  return { ...structuredClone(baseRecord), generated_kit: generated, effective_kit: effective, ...overrides };
}

beforeEach(() => { vi.clearAllMocks(); mocks.getKit.mockResolvedValue({ kit: record() }); vi.stubGlobal("confirm", vi.fn(() => true)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("kit editor workspace", () => {
  it("displays role requirements, grouped editable questions, coverage, sources, and the schedule", async () => {
    render(<KitWorkspacePage />);
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("Must-have")).toBeInTheDocument();
    expect(screen.getByLabelText("Question prompt")).toHaveValue(question.prompt);
    expect(screen.getByText("No question reported")).toBeInTheDocument();
    expect(screen.getByText("Additional research references")).toBeInTheDocument();
    expect(screen.getByText("DAY 1")).toBeInTheDocument();
  });

  it("adds, reorders, deletes, pins, and saves questions with the current revision", async () => {
    const user = userEvent.setup();
    mocks.updateKit.mockImplementation(async (_id: string, revision: number, edits: any[]) => {
      const next = record({ revision: revision + 1, editor_state: { edits } });
      const questionEdit = edits.find((edit) => edit.path === "/questions");
      if (questionEdit) next.effective_kit.questions = questionEdit.value;
      return { kit: next };
    });
    render(<KitWorkspacePage />);
    await screen.findByLabelText("Question prompt");
    await user.click(screen.getByRole("button", { name: "Add question" }));
    expect(screen.getAllByLabelText("Question prompt")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Move question 2 up" }));
    expect(screen.getAllByLabelText("Question prompt").map((field) => (field as HTMLTextAreaElement).value)).toEqual(["", question.prompt]);
    await user.click(screen.getByRole("button", { name: "Delete question: Custom question" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(screen.getAllByLabelText("Question prompt")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    await waitFor(() => expect(mocks.updateKit).toHaveBeenCalled());
    const [, revision, edits] = mocks.updateKit.mock.calls[0]!;
    expect(revision).toBe(3);
    expect(edits.some((edit: any) => edit.path === "/questions")).toBe(true);
    expect(edits.some((edit: any) => edit.path === "/questions/0" && edit.state === "pinned")).toBe(true);
    expect(await screen.findByRole("status")).toHaveTextContent("All changes saved");
  });

  it("saves prompt and answer edits and surfaces revision conflicts without discarding drafts", async () => {
    mocks.updateKit.mockRejectedValue(new ApiError("stale", 409, "KIT_REVISION_CONFLICT"));
    render(<KitWorkspacePage />);
    const prompt = await screen.findByLabelText("Question prompt");
    fireEvent.change(prompt, { target: { value: "Updated prompt" } });
    fireEvent.change(screen.getByLabelText("Answer outline"), { target: { value: "Updated answer" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");
    expect(screen.getByLabelText("Question prompt")).toHaveValue("Updated prompt");
  });

  it("regenerates a category using the current revision and adopts the returned saved kit", async () => {
    const regenerated = record({ revision: 4 });
    regenerated.effective_kit.questions = [{ ...question, id: "q2", prompt: "Regenerated prompt" }];
    mocks.regenerateKitSection.mockResolvedValue({ kit: regenerated, generation: { status: "partial", warnings: ["Some sources were unavailable."], uncovered_requirement_ids: [] } });
    render(<KitWorkspacePage />);
    await screen.findByLabelText("Question prompt");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate technical" }));
    await waitFor(() => expect(mocks.regenerateKitSection).toHaveBeenCalledWith("kit-42", 3, { section: "question_category", category: "technical" }));
    expect(await screen.findByLabelText("Question prompt")).toHaveValue("Regenerated prompt");
    expect(await screen.findByText("Research may be incomplete")).toBeInTheDocument();
  });

  it("keeps the original brief visible after a regeneration error and reports the failure", async () => {
    mocks.regenerateKitSection.mockRejectedValue(new ApiError("failed", 502, "REGENERATION_FAILED"));
    render(<KitWorkspacePage />);
    expect(await screen.findByText("Original summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate brief" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload the kit before trying again");
  });
});
