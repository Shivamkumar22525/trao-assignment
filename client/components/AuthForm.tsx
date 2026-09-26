"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { api, ApiError, readableApiError } from "../lib/api";

type AuthMode = "login" | "register";

function nextPath(): string {
  const candidate = new URLSearchParams(window.location.search).get("next");
  if (!candidate) return "/dashboard";
  try {
    const target = new URL(candidate, window.location.origin);
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : "/dashboard";
  } catch { return "/dashboard"; }
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const isRegister = mode === "register";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const normalizedEmail = email.trim();
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Enter a valid email address (up to 254 characters).");
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError("Password must be between 8 and 128 characters.");
      return;
    }
    setLoading(true);
    try {
      const result = isRegister ? await api.register({ email: normalizedEmail, password }) : await api.login({ email: normalizedEmail, password });
      router.replace(nextPath());
      router.refresh();
      void result;
    } catch (requestError) {
      setError(requestError instanceof ApiError ? readableApiError(requestError) : readableApiError(requestError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-heading">
        <Link href="/login" className="brand-mark" aria-label="Trao home">trao<span>.</span></Link>
        <p className="eyebrow">INTERVIEW PREPARATION, MADE PERSONAL</p>
        <h1 id="auth-heading">{isRegister ? "Create your account" : "Welcome back"}</h1>
        <p className="auth-intro">{isRegister ? "Build a focused plan for the role you want." : "Sign in to pick up where you left off."}</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor={`${mode}-email`}>Email address</label>
          <input id={`${mode}-email`} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby={error ? "auth-error" : undefined} />
          <label htmlFor={`${mode}-password`}>Password</label>
          <input id={`${mode}-password`} name="password" type="password" autoComplete={isRegister ? "new-password" : "current-password"} required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p id="auth-error" className="form-error" role="alert">{error}</p>}
          <button className="button button-primary button-wide" type="submit" disabled={loading}>
            {loading ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          {isRegister ? "Already have an account? " : "New to Trao? "}
          <Link href={isRegister ? "/login" : "/register"}>{isRegister ? "Sign in" : "Create an account"}</Link>
        </p>
        <p className="auth-note">Your account is secured with a private server-side session.</p>
      </section>
      <aside className="auth-aside" aria-hidden="true">
        <div className="aside-orbit orbit-one" /><div className="aside-orbit orbit-two" />
        <div className="aside-copy"><span className="aside-kicker">A LITTLE MORE PREPARED</span><p>Walk into your next interview with a plan that feels like yours.</p><div className="aside-rule" /><small>Research · Practice · Confidence</small></div>
      </aside>
    </main>
  );
}
