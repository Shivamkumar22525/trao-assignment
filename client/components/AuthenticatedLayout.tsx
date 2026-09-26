"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, ApiUser, readableApiError } from "../lib/api";

const AuthUserContext = createContext<ApiUser | null>(null);
export function useAuthUser(): ApiUser | null { return useContext(AuthUserContext); }

export function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [error, setError] = useState("");

  const loadUser = useCallback(async () => {
    setLoading(true);
    setError("");
    try { const result = await api.currentUser(); setUser(result.user); }
    catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname || "/dashboard")}`);
        return;
      }
      setError(readableApiError(requestError));
    } finally { setLoading(false); }
  }, [pathname, router]);

  useEffect(() => { void loadUser(); }, [loadUser]);

  async function logout() {
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await api.logout();
      router.replace("/login");
      router.refresh();
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        router.replace("/login");
        router.refresh();
      } else setLogoutError(readableApiError(requestError));
    } finally { setLogoutBusy(false); }
  }

  if (loading) return <main className="center-state" role="status"><span className="spinner" />Checking your session…</main>;
  if (!user) return <main className="center-state"><div className="state-card"><span className="state-icon">!</span><h1>We couldn’t load your account</h1><p>{error || "Your session may have expired."}</p><button className="button button-primary" onClick={() => void loadUser()}>Try again</button></div></main>;

  return (
    <div className="app-frame">
      <header className="app-header">
        <Link href="/dashboard" className="brand-mark">trao<span>.</span></Link>
        <nav aria-label="Main navigation" className="main-nav"><Link href="/dashboard" aria-current={pathname === "/dashboard" ? "page" : undefined}>Workspace</Link></nav>
        <div className="account-actions"><span className="user-chip"><span className="avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span><span>{user.email}</span></span><button className="button button-quiet" onClick={logout} disabled={logoutBusy}>{logoutBusy ? "Signing out…" : "Sign out"}</button></div>
      </header>
      <AuthUserContext.Provider value={user}><main className="app-main">{logoutError && <div className="notice notice-error" role="alert">{logoutError}</div>}{children}</main></AuthUserContext.Provider>
      <footer className="app-footer"><span>trao<span className="accent-dot">.</span></span><span>Your next good answer starts here.</span></footer>
    </div>
  );
}
