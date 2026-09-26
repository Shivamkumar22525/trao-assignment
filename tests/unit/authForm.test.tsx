// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), login: vi.fn(), register: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("../../client/lib/api", () => {
  class TestApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
  return { api: { login: mocks.login, register: mocks.register }, ApiError: TestApiError, readableApiError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error." };
});

import { AuthForm } from "../../client/components/AuthForm";

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, "", "/login"); });
afterEach(cleanup);

describe("auth form", () => {
  it("validates credentials client-side and exposes an accessible error", async () => {
    render(<AuthForm mode="login" />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address");
    expect(mocks.login).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("submits login credentials and navigates to a safe in-app destination", async () => {
    window.history.replaceState({}, "", "/login?next=%2Fkits%2Fabc");
    mocks.login.mockResolvedValue({ user: { id: "u1", email: "candidate@example.com" } });
    render(<AuthForm mode="login" />);
    await userEvent.type(screen.getByLabelText("Email address"), "candidate@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password-123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/kits/abc"));
    expect(mocks.login).toHaveBeenCalledWith({ email: "candidate@example.com", password: "password-123" });
  });

  it("sends registration to the backend-supported email/password contract and displays API errors", async () => {
    mocks.register.mockRejectedValue(new Error("An account with that email already exists."));
    render(<AuthForm mode="register" />);
    await userEvent.type(screen.getByLabelText("Email address"), "candidate@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "password-123");
    fireEvent.submit(screen.getByRole("button", { name: "Create account" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("An account with that email already exists.");
    expect(mocks.register).toHaveBeenCalledWith({ email: "candidate@example.com", password: "password-123" });
  });
});
