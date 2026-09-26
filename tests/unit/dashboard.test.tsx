// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listKits: vi.fn(), deleteKit: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../client/lib/api", () => ({ api: { listKits: mocks.listKits, deleteKit: mocks.deleteKit }, ApiError: class ApiError extends Error {}, readableApiError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error." }));

import { Dashboard } from "../../client/components/Dashboard";

const kit = {
  id: "kit-1", original_input: { jd: "role", company_url: "https://example.com", days: 3 },
  generated_kit: { source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 4, researched_at: "2026-01-01", pages_used: [] }, company_brief: { summary: "Brief", what_they_do: "Build software", sources: [] }, role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] }, questions: [], flashcards: [], schedule: { days_available: 3, days: [] }, coverage: { uncovered_requirement_ids: [], passes: 1 } },
  effective_kit: { source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 4, researched_at: "2026-01-01", pages_used: [] }, company_brief: { summary: "Brief", what_they_do: "Build software", sources: [] }, role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] }, questions: [], flashcards: [], schedule: { days_available: 3, days: [] }, coverage: { uncovered_requirement_ids: [], passes: 1 } },
  editor_state: { edits: [] }, revision: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("confirm", vi.fn(() => true)); });
afterEach(cleanup);

describe("dashboard kit states", () => {
  it("shows loading then the empty state", async () => {
    let resolveRequest!: (value: { kits: never[]; page: number; limit: number; total: number }) => void;
    mocks.listKits.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    render(<Dashboard userEmail="person@example.com" />);
    expect(screen.getByRole("status", { name: "Loading kits" })).toBeInTheDocument();
    resolveRequest({ kits: [], page: 1, limit: 20, total: 0 });
    expect(await screen.findByText("Your first step starts here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create your first kit" })).toHaveAttribute("href", "/kits/new");
  });

  it("shows saved kits with an individual route and removes a confirmed deletion", async () => {
    mocks.listKits.mockResolvedValue({ kits: [kit], page: 1, limit: 20, total: 1 });
    mocks.deleteKit.mockResolvedValue(undefined);
    render(<Dashboard userEmail="person@example.com" />);
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open kit/ })).toHaveAttribute("href", "/kits/kit-1");
    await userEvent.click(screen.getByRole("button", { name: "Delete Acme kit" }));
    await waitFor(() => expect(mocks.deleteKit).toHaveBeenCalledWith("kit-1"));
    expect(await screen.findByText("Your first step starts here")).toBeInTheDocument();
  });

  it("shows a readable load error and retries", async () => {
    mocks.listKits.mockRejectedValueOnce(new Error("Could not reach the server.")).mockResolvedValueOnce({ kits: [], page: 1, limit: 20, total: 0 });
    render(<Dashboard userEmail="person@example.com" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your first step starts here")).toBeInTheDocument();
  });
});
