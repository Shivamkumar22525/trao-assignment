"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, KitRecord, readableApiError } from "../lib/api";

function companyTitle(kit: KitRecord): string {
  if (kit.effective_kit.source.company) return kit.effective_kit.source.company;
  try { return new URL(kit.effective_kit.source.company_url).hostname; } catch { return "Interview preparation"; }
}

function dateLabel(value?: string): string {
  if (!value) return "Recently created";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Recently created" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function Dashboard({ userEmail }: { userEmail: string }) {
  const [kits, setKits] = useState<KitRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadKits = useCallback(async () => {
    setLoading(true);
    setError("");
    try { const result = await api.listKits(); setKits(result.kits); setTotal(result.total); }
    catch (requestError) { setError(readableApiError(requestError)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadKits(); }, [loadKits]);

  async function deleteKit(kit: KitRecord) {
    if (!window.confirm(`Delete the preparation kit for ${companyTitle(kit)}? This cannot be undone.`)) return;
    setDeletingId(kit.id);
    setError("");
    try {
      await api.deleteKit(kit.id);
      setKits((current) => current.filter(({ id }) => id !== kit.id));
      setTotal((current) => Math.max(0, current - 1));
    }
    catch (requestError) { setError(readableApiError(requestError)); }
    finally { setDeletingId(null); }
  }

  return (
    <div className="dashboard-page">
      <section className="welcome-panel">
        <div className="welcome-copy"><span className="eyebrow">YOUR INTERVIEW WORKSPACE</span><h1>Good to see you<span className="accent-dot">.</span></h1><p>Make your next interview feel a little more familiar.</p><span className="welcome-user">Signed in as {userEmail}</span></div>
        <div className="welcome-art" aria-hidden="true"><div className="art-card"><span className="art-line long"/><span className="art-line medium"/><span className="art-line short"/><div className="art-check">✓</div></div><div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✦</div></div>
        <Link href="/kits/new" className="button button-light welcome-cta"><span aria-hidden="true">＋</span> Create an interview kit</Link>
      </section>

      <section className="kits-section" aria-labelledby="kits-heading">
        <div className="section-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2 id="kits-heading">Your preparation kits</h2></div><span className="count-pill">{total} {total === 1 ? "kit" : "kits"}</span></div>
        {error && <div className="notice notice-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void loadKits()}>Try again</button></div>}
        {loading ? <div className="kit-grid" role="status" aria-label="Loading kits"><div className="kit-skeleton"/><div className="kit-skeleton"/><div className="kit-skeleton"/></div> : kits.length === 0 ? (
          <div className="empty-state"><div className="empty-illustration" aria-hidden="true"><span>✳</span><i/><i/><i/></div><h3>Your first step starts here</h3><p>Create a tailored preparation kit and keep all your research and practice in one place.</p><Link href="/kits/new" className="button button-primary">Create your first kit</Link></div>
        ) : (
          <div className="kit-grid">{kits.map((kit) => <article className="kit-card" key={kit.id}>
            <div className="kit-card-top"><span className="company-mark" aria-hidden="true">{companyTitle(kit).slice(0, 1).toUpperCase()}</span><button className="icon-button delete-button" aria-label={`Delete ${companyTitle(kit)} kit`} title="Delete kit" disabled={deletingId === kit.id} onClick={() => void deleteKit(kit)}><span aria-hidden="true">×</span></button></div>
            <Link href={`/kits/${encodeURIComponent(kit.id)}`} className="kit-card-link"><h3>{companyTitle(kit)}</h3><p>{kit.effective_kit.source.role || kit.effective_kit.role.title || "Interview preparation"}</p><div className="kit-meta"><span>{kit.effective_kit.schedule.days_available} day plan</span><span>·</span><span>{kit.effective_kit.questions.length} questions</span></div><span className="kit-date">Updated {dateLabel(kit.updated_at || kit.created_at)}</span><span className="card-open">Open kit <span aria-hidden="true">↗</span></span></Link>
            {deletingId === kit.id && <span className="deleting-label" role="status">Deleting…</span>}
          </article>)}</div>
        )}
      </section>
    </div>
  );
}
