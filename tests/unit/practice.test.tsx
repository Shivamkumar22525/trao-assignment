// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getKit: vi.fn(), getPracticeProgress: vi.fn(), markFlashcard: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "kit-42" }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../client/lib/api", () => ({ api: mocks, readableApiError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error." }));

import PracticePage from "../../client/app/(authenticated)/kits/[id]/practice/page";
import KitWorkspacePage from "../../client/app/(authenticated)/kits/[id]/page";

const kit = {
  id: "kit-42", original_input: { jd: "role", company_url: "https://example.com", days: 2 }, revision: 1, editor_state: { edits: [] },
  generated_kit: {
    source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 4, researched_at: "2026-01-01", pages_used: [] },
    company_brief: { summary: "", what_they_do: "", sources: [] },
    role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] },
    questions: [{ id: "q1", requirement_ids: [], category: "technical", prompt: "Question one", answer_outline: "", difficulty: 1 }, { id: "q2", requirement_ids: [], category: "technical", prompt: "Question two", answer_outline: "", difficulty: 2 }],
    flashcards: [], schedule: { days_available: 2, days: [] }, coverage: { uncovered_requirement_ids: [], passes: 1 },
  },
  effective_kit: {
    source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 4, researched_at: "2026-01-01", pages_used: [] },
    company_brief: { summary: "", what_they_do: "", sources: [] },
    role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] },
    questions: [{ id: "q1", requirement_ids: [], category: "technical", prompt: "Question one", answer_outline: "", difficulty: 1 }, { id: "q2", requirement_ids: [], category: "technical", prompt: "Question two", answer_outline: "", difficulty: 2 }],
    flashcards: [{ id: "f1", front: "Front one", back: "Back one", requirement_ids: [] }, { id: "f2", front: "Front two", back: "Back two", requirement_ids: [] }],
    schedule: { days_available: 2, days: [{ day: 1, focus: "Focus one", question_ids: ["q1"], minutes: 30 }, { day: 2, focus: "Review", question_ids: [], minutes: 10 }] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  },
};

beforeEach(() => { vi.clearAllMocks(); mocks.getKit.mockResolvedValue({ kit: structuredClone(kit) }); mocks.getPracticeProgress.mockResolvedValue({ progress: [] }); mocks.markFlashcard.mockImplementation(async (_kit: string, flashcard_id: string, covered: boolean) => ({ progress: { flashcard_id, covered, attempts: 1, last_practiced_at: new Date().toISOString() } })); });
afterEach(() => cleanup());

describe("flashcard practice", () => {
  it("keeps the answer hidden until revealed and saves known/review marks while navigating", async () => {
    const user = userEvent.setup(); render(<PracticePage />);
    expect(await screen.findByRole("heading", { name: "Front one" })).toBeInTheDocument();
    expect(screen.queryByText("Back one")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal answer" }));
    expect(screen.getByRole("heading", { name: "Back one" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Known" }));
    expect(mocks.markFlashcard).toHaveBeenCalledWith("kit-42", "f1", true);
    expect(await screen.findByRole("heading", { name: "Front two" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal answer" }));
    await user.click(screen.getByRole("button", { name: "Needs review" }));
    expect(await screen.findByText(/Session finished/)).toBeInTheDocument();
    expect(screen.getByText(/reviewed 2 cards/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restart session" }));
    expect(screen.getByRole("heading", { name: "Front one" })).toBeInTheDocument();
  });

  it("supports previous and next card navigation and retains saved progress", async () => {
    const user = userEvent.setup(); render(<PracticePage />);
    await screen.findByRole("heading", { name: "Front one" });
    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByRole("heading", { name: "Front two" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Previous" }));
    expect(screen.getByRole("heading", { name: "Front one" })).toBeInTheDocument();
    expect(screen.queryByText("Back one")).not.toBeInTheDocument();
  });

  it("offers an editor link for empty flashcards and reports progress load/save errors", async () => {
    mocks.getKit.mockResolvedValueOnce({ kit: { ...structuredClone(kit), effective_kit: { ...kit.effective_kit, flashcards: [] } } });
    const { unmount } = render(<PracticePage />);
    expect(await screen.findByRole("heading", { name: "No flashcards yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add flashcards in the editor" })).toHaveAttribute("href", "/kits/kit-42#flashcards-title");
    unmount();
    mocks.getPracticeProgress.mockRejectedValueOnce(new Error("Progress service unavailable"));
    render(<PracticePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Progress service unavailable");
  });

  it("shows API save errors without silently advancing the card", async () => {
    mocks.markFlashcard.mockRejectedValueOnce(new Error("Could not save progress"));
    const user = userEvent.setup(); render(<PracticePage />);
    await screen.findByRole("heading", { name: "Front one" });
    await user.click(screen.getByRole("button", { name: "Reveal answer" }));
    await user.click(screen.getByRole("button", { name: "Needs review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save progress");
    expect(screen.getByRole("heading", { name: "Back one" })).toBeInTheDocument();
  });
});

describe("interactive saved schedule", () => {
  it("links scheduled questions into the editor and identifies an empty day", async () => {
    render(<KitWorkspacePage />);
    await screen.findByRole("heading", { name: "Acme" });
    const assigned = screen.getByRole("link", { name: "Question one" });
    expect(assigned).toHaveAttribute("href", "#question-q1");
    expect(screen.getByText("No questions assigned for this day.")).toBeInTheDocument();
    fireEvent.click(assigned);
    expect(screen.getByRole("status")).toHaveTextContent("Opened the editor");
  });
});
