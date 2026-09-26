"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type KitRecord, type PracticeProgress, readableApiError } from "../../../../../lib/api";

export default function PracticePage() {
  const { id } = useParams<{ id: string }>();
  const [kit, setKit] = useState<KitRecord | null>(null);
  const [progress, setProgress] = useState<Record<string, PracticeProgress>>({});
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const [sessionReviewed, setSessionReviewed] = useState<string[]>([]);
  const cards = kit?.effective_kit.flashcards ?? [];

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [kitResponse, progressResponse] = await Promise.all([api.getKit(id), api.getPracticeProgress(id)]);
      setKit(kitResponse.kit);
      setProgress(Object.fromEntries(progressResponse.progress.map((item) => [item.flashcard_id, item])));
    } catch (requestError) { setError(readableApiError(requestError)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, select")) return;
      if (event.key === "ArrowRight") { event.preventDefault(); setRevealed(false); setIndex((current) => Math.min(current + 1, Math.max(cards.length - 1, 0))); }
      if (event.key === "ArrowLeft") { event.preventDefault(); setRevealed(false); setIndex((current) => Math.max(current - 1, 0)); }
      if (event.key === " ") { event.preventDefault(); setRevealed((current) => !current); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length]);

  async function mark(covered: boolean) {
    const card = cards[index];
    if (!card || saving) return;
    setSaving(true); setError("");
    try {
      const response = await api.markFlashcard(id, card.id, covered);
      setProgress((current) => ({ ...current, [card.id]: response.progress }));
      setSessionReviewed((current) => current.includes(card.id) ? current : [...current, card.id]);
      if (index < cards.length - 1) { setIndex(index + 1); setRevealed(false); }
      else setFinished(true);
    } catch (requestError) { setError(readableApiError(requestError)); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="center-state" role="status">Loading practice session...</div>;
  if (!kit) return <main className="practice-page"><section className="state-card"><h1>Practice unavailable</h1><p role="alert">{error || "This kit could not be found."}</p><Link className="button button-secondary" href="/dashboard">Back to workspace</Link></section></main>;
  const editorHref = `/kits/${encodeURIComponent(id)}#flashcards-title`;
  const reviewedCount = Object.keys(progress).length;
  if (!cards.length) return <main className="practice-page"><Link className="back-link" href={`/kits/${encodeURIComponent(id)}`}>← Back to kit</Link><section className="state-card"><span className="eyebrow">FLASHCARD PRACTICE</span><h1>No flashcards yet</h1><p>Add flashcards in the kit workspace, save your changes, then return here to practice.</p><Link className="button button-primary" href={editorHref}>Add flashcards in the editor</Link></section></main>;
  const card = cards[Math.min(index, cards.length - 1)]!;

  return <main className="practice-page">
    <Link className="back-link" href={`/kits/${encodeURIComponent(id)}`}>← Back to kit workspace</Link>
    <header className="practice-heading"><div><span className="eyebrow">FLASHCARD PRACTICE</span><h1>{kit.effective_kit.source.company} · {kit.effective_kit.role.title}</h1><p>Review one card at a time. Reveal the answer when you are ready.</p></div><Link className="text-button" href={editorHref}>Edit flashcards</Link></header>
    {error && <p role="alert" className="editor-error">{error}</p>}
    {finished ? <section className="practice-finished" aria-live="polite"><span className="eyebrow">SESSION COMPLETE</span><h2>Session finished. You reviewed {sessionReviewed.length} {sessionReviewed.length === 1 ? "card" : "cards"}.</h2><p>{reviewedCount} cards have saved practice history for this kit. Known/review marks and attempt counts are saved as you go.</p><button className="button button-primary" type="button" onClick={() => { setIndex(0); setRevealed(false); setFinished(false); setSessionReviewed([]); }}>Restart session</button></section> : <>
      <div className="practice-progress-row"><span>Card {index + 1} of {cards.length}</span><span>{reviewedCount} with saved history</span></div>
      <div className="practice-progress-track" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={cards.length} aria-valuenow={index + 1}><span style={{ width: `${((index + 1) / cards.length) * 100}%` }} /></div>
      <section className="practice-card" aria-live="polite" aria-labelledby="practice-card-front"><span className="eyebrow">{revealed ? "ANSWER" : "QUESTION"}</span><h2 id="practice-card-front">{revealed ? card.back : card.front}</h2>{!revealed && <button type="button" className="button button-primary" onClick={() => setRevealed(true)}>Reveal answer</button>}{revealed && <div className="practice-mark-actions"><button type="button" className="button button-secondary" disabled={saving} onClick={() => void mark(false)}>{saving ? "Saving..." : "Needs review"}</button><button type="button" className="button button-primary" disabled={saving} onClick={() => void mark(true)}>{saving ? "Saving..." : "Known"}</button></div>}
        <div className="practice-navigation"><button type="button" className="text-button" disabled={index === 0 || saving} onClick={() => { setIndex(index - 1); setRevealed(false); }}>← Previous</button><span>{progress[card.id] ? `${progress[card.id]!.covered ? "Known" : "Needs review"} · ${progress[card.id]!.attempts} review${progress[card.id]!.attempts === 1 ? "" : "s"}` : "Not reviewed yet"}</span><button type="button" className="text-button" disabled={index === cards.length - 1 || saving} onClick={() => { setIndex(index + 1); setRevealed(false); }}>Next →</button></div>
      </section>
      <p className="practice-key-help">Keyboard: ← / → to move, Space to reveal or hide the answer.</p>
      <button type="button" className="text-button practice-finish-link" onClick={() => setFinished(true)}>Finish session</button>
    </>}
  </main>;
}
