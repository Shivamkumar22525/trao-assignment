// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), generateKit: vi.fn(), getKit: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: mocks.refresh }), useParams: () => ({ id: "kit-42" }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../client/lib/api", () => {
  class TestApiError extends Error {
    constructor(message: string, public status: number, public code?: string, public details?: unknown) { super(message); }
  }
  return { api: { generateKit: mocks.generateKit, getKit: mocks.getKit }, ApiError: TestApiError, readableApiError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error." };
});

import { CreateKitForm } from "../../client/components/CreateKitForm";
import KitOverviewPage from "../../client/app/(authenticated)/kits/[id]/page";
import { ApiError } from "../../client/lib/api";

const successfulResponse = { job: { id: "job-1", status: "succeeded" as const }, kit: { id: "kit-42" } };

async function fillForm() {
  fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: "  Acme  " } });
  fireEvent.change(screen.getByLabelText(/Job title \/ role/), { target: { value: "  Platform Engineer  " } });
  fireEvent.change(screen.getByLabelText(/Company website/), { target: { value: "https://acme.example/careers" } });
  fireEvent.change(screen.getByLabelText(/Job description/), { target: { value: "  Build reliable software systems.  " } });
  fireEvent.change(screen.getByLabelText(/Days until your interview/), { target: { value: "7" } });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe("create-kit form", () => {
  it("validates required fields, HTTP/HTTPS URLs, and bounded whole days", async () => {
    render(<CreateKitForm />);
    fireEvent.submit(screen.getByRole("button", { name: "Generate interview kit" }).closest("form")!);
    expect(await screen.findByText(/Enter the company/)).toBeInTheDocument();
    expect(screen.getByText("Paste the job description to continue.")).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number from 1 to 30.")).toBeInTheDocument();
    expect(mocks.generateKit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Company website/), { target: { value: "javascript:alert(1)" } });
    fireEvent.change(screen.getByLabelText(/Job description/), { target: { value: "Role details" } });
    fireEvent.change(screen.getByLabelText(/Days until your interview/), { target: { value: "31" } });
    fireEvent.submit(screen.getByRole("button", { name: "Generate interview kit" }).closest("form")!);
    expect(screen.getByText(/public HTTP or HTTPS URL/)).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number from 1 to 30.")).toBeInTheDocument();
    expect(mocks.generateKit).not.toHaveBeenCalled();
  });

  it("submits the actual backend payload and navigates using the returned kit ID", async () => {
    mocks.generateKit.mockResolvedValue(successfulResponse);
    render(<CreateKitForm />);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "Generate interview kit" }));
    await waitFor(() => expect(mocks.generateKit).toHaveBeenCalledWith({
      company_name: "Acme", company_url: "https://acme.example/careers", role: "Platform Engineer", jd: "Build reliable software systems.", days: 7,
    }));
    expect(mocks.push).toHaveBeenCalledWith("/kits/kit-42");
  });

  it("shows an honest synchronous loading state and prevents duplicate submissions", async () => {
    let resolveGeneration!: (value: typeof successfulResponse) => void;
    mocks.generateKit.mockReturnValue(new Promise((resolve) => { resolveGeneration = resolve; }));
    render(<CreateKitForm />);
    await fillForm();
    const form = screen.getByRole("button", { name: "Generate interview kit" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(await screen.findByRole("status")).toHaveTextContent("Generating and saving your kit");
    expect(screen.getByRole("button", { name: /Working/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(mocks.generateKit).toHaveBeenCalledTimes(1);
    resolveGeneration(successfulResponse);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/kits/kit-42"));
  });

  it("redirects unauthenticated submissions back through login", async () => {
    mocks.generateKit.mockRejectedValue(new ApiError("Please sign in to continue.", 401, "UNAUTHENTICATED"));
    render(<CreateKitForm />);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "Generate interview kit" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login?next=%2Fkits%2Fnew"));
  });

  it("shows safe validation, rate-limit, and configuration messages", async () => {
    const cases = [
      { error: new ApiError("Request input is invalid.", 400, "VALIDATION_ERROR"), shown: "Request input is invalid." },
      { error: new ApiError("Gemini rate or quota limits were reached.", 502, "GENERATION_FAILED"), shown: "rate-limited or its API quota" },
      { error: new ApiError("Set GEMINI_API_KEY and LLM_PROVIDER.", 502, "GENERATION_FAILED"), shown: "not configured on the server" },
    ];
    for (const current of cases) {
      cleanup();
      mocks.generateKit.mockRejectedValueOnce(current.error);
      render(<CreateKitForm />);
      await fillForm();
      await userEvent.click(screen.getByRole("button", { name: "Generate interview kit" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(current.shown);
    }
  });

  it("does not blindly retry after a network failure with an unknown outcome", async () => {
    mocks.generateKit.mockRejectedValue(new ApiError("Connection lost.", 0, "NETWORK_ERROR"));
    render(<CreateKitForm />);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "Generate interview kit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your saved kits before trying again");
    expect(screen.getByRole("button", { name: "Check saved kits" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Check your saved kits" })).toHaveAttribute("href", "/dashboard");
  });

  it("shows coverage and research references provided in the saved kit", async () => {
    const kit = {
      id: "kit-42", original_input: { jd: "", company_url: "https://acme.example", days: 7 },
      generated_kit: { source: { company: "Acme", company_url: "https://acme.example", role: "Engineer", location: "", jd_chars: 1, researched_at: "2026-01-01", pages_used: ["https://acme.example/about"] }, company_brief: { summary: "Summary", what_they_do: "Build products", sources: [] }, role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] }, questions: [], flashcards: [], schedule: { days_available: 7, days: [] }, coverage: { uncovered_requirement_ids: ["req-2"], passes: 2 } },
      effective_kit: { source: { company: "Acme", company_url: "https://acme.example", role: "Engineer", location: "", jd_chars: 1, researched_at: "2026-01-01", pages_used: ["https://acme.example/about"] }, company_brief: { summary: "Summary", what_they_do: "Build products", sources: [] }, role: { title: "Engineer", seniority: "Senior", responsibilities: [], requirements: [] }, questions: [], flashcards: [], schedule: { days_available: 7, days: [] }, coverage: { uncovered_requirement_ids: ["req-2"], passes: 2 } },
      editor_state: { edits: [] }, revision: 0,
    };
    mocks.getKit.mockResolvedValue({ kit });
    render(<KitOverviewPage />);
    expect(await screen.findByText("1 uncovered requirement reported")).toBeInTheDocument();
    expect(screen.getByText("req-2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://acme.example/about" })).toHaveAttribute("href", "https://acme.example/about");
  });
});



