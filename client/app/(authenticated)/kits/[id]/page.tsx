"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type KitRecord, type KitQuestion, type KitFlashcard, readableApiError } from "../../../../lib/api";

const CATEGORIES: { id: KitQuestion["category"]; label: string }[] = [
  { id: "technical", label: "Technical" },
  { id: "behavioural", label: "Behavioural" },
  { id: "system-design", label: "System design" },
  { id: "company-fit", label: "Company fit" },
];

function pinnedIds(record: KitRecord): Set<string> {
  const pins = new Set<string>();
  for (const edit of record.editor_state.edits) {
    const match = edit.path.match(/^\/questions\/(\d+)$/);
    if (edit.state === "pinned" && match) {
      const question = record.effective_kit.questions[Number(match[1])];
      if (question) pins.add(question.id);
    }
  }
  return pins;
}

export default function KitWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [kit, setKit] = useState<KitRecord | null>(null);
  const [questions, setQuestions] = useState<KitQuestion[]>([]);
  const [flashcards, setFlashcards] = useState<KitFlashcard[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [newCategory, setNewCategory] = useState<KitQuestion["category"]>("technical");
  const [newRequirement, setNewRequirement] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [generationWarnings, setGenerationWarnings] = useState<string[]>([]);
  const [scheduleNotice, setScheduleNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setGenerationWarnings([]);
    try {
      const response = await api.getKit(id);
      setKit(response.kit);
      setQuestions(response.kit.effective_kit.questions.map((question) => ({ ...question, requirement_ids: [...question.requirement_ids] })));
      setFlashcards(response.kit.effective_kit.flashcards.map((card) => ({ ...card, requirement_ids: [...card.requirement_ids] })));
      setPins(pinnedIds(response.kit));
      setScheduleNotice("");
      setNewRequirement(response.kit.effective_kit.role.requirements[0]?.id ?? "");
      setDirty(false);
      setSaved(false);
    } catch (requestError) {
      setError(readableApiError(requestError));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const requirements = kit?.effective_kit.role.requirements ?? [];
  const requirementById = useMemo(() => new Map(requirements.map((requirement) => [requirement.id, requirement])), [requirements]);
  const uncovered = kit?.effective_kit.coverage.uncovered_requirement_ids ?? [];
  const companySources = kit?.effective_kit.company_brief.sources ?? [];
  const researchSources = kit?.effective_kit.source.pages_used ?? [];
  const additionalSources = researchSources.filter((url) => !companySources.includes(url));
  const blocked = saving || Boolean(regenerating) || loading;

  function mutateQuestions(next: KitQuestion[]) {
    setQuestions(next);
    setDirty(true);
    setSaved(false);
    setError("");
  }

  function editQuestion(questionId: string, field: "prompt" | "answer_outline", value: string) {
    mutateQuestions(questions.map((question) => question.id === questionId ? { ...question, [field]: value } : question));
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const reordered = [...questions];
    [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
    mutateQuestions(reordered);
  }

  async function save() {
    if (!kit || !dirty || saving || regenerating) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const edits = [
        { path: "/questions", value: questions, state: "edited" as const },
        ...questions.flatMap((question, index) => pins.has(question.id) ? [{ path: `/questions/${index}`, value: question, state: "pinned" as const }] : []),
        ...(JSON.stringify(flashcards) !== JSON.stringify(kit.effective_kit.flashcards) ? [{ path: "/flashcards", value: flashcards, state: "edited" as const }] : []),
      ];
      const response = await api.updateKit(kit.id, kit.revision, edits);
      setKit(response.kit);
      setQuestions(response.kit.effective_kit.questions);
      setFlashcards(response.kit.effective_kit.flashcards);
      setPins(pinnedIds(response.kit));
      setDirty(false);
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.status === 409
        ? "This kit changed in another session. Reload the latest version before saving your edits."
        : readableApiError(requestError));
    } finally {
      setSaving(false);
    }
  }

  function reloadLatest() {
    if (dirty && !window.confirm("Discard your unsaved edits and reload the latest saved kit?")) return;
    void load();
  }

  async function regenerate(section: "company_brief" | "question_category", category?: KitQuestion["category"]) {
    if (!kit || blocked || dirty) {
      if (dirty) setError("Save your edits before regenerating this section.");
      return;
    }
    const label = section === "company_brief" ? "company brief" : `${category} questions`;
    if (!window.confirm(`Regenerate the ${label}? Unpinned content in this section may be replaced.`)) return;
    setRegenerating(label);
    setError("");
    try {
      const input = section === "company_brief" ? { section } as const : { section, category: category! } as const;
      const response = await api.regenerateKitSection(kit.id, kit.revision, input);
      setKit(response.kit);
      setQuestions(response.kit.effective_kit.questions);
      setFlashcards(response.kit.effective_kit.flashcards);
      setGenerationWarnings(response.generation.warnings);
      setPins(pinnedIds(response.kit));
      setDirty(false);
      setSaved(false);
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.status === 409
        ? "This kit changed while regeneration was running. Reload it to see the latest saved version."
        : requestError instanceof ApiError && [0, 502].includes(requestError.status)
          ? "Regeneration could not be confirmed or completed. Reload the kit before trying again."
          : readableApiError(requestError));
    } finally {
      setRegenerating("");
    }
  }

  function addQuestion() {
    if (blocked || !newRequirement) return;
    const question: KitQuestion = {
      id: `custom-${crypto.randomUUID()}`, requirement_ids: [newRequirement], category: newCategory,
      prompt: "", answer_outline: "", difficulty: 2,
    };
    mutateQuestions([...questions, question]);
  }

  function deleteQuestion(question: KitQuestion) {
    if (!window.confirm("Delete this question from your saved kit? You can restore it by regenerating the section.")) return;
    mutateQuestions(questions.filter(({ id: questionId }) => questionId !== question.id));
  }

  if (loading) return <div className="center-state" role="status"><span className="spinner" />Loading your interview workspace...</div>;
  if (!kit) return <section className="state-card inline-state"><h1>Kit unavailable</h1><p>{error || "This kit could not be found."}</p><Link href="/dashboard" className="button button-primary">Back to workspace</Link></section>;
  const content = kit.effective_kit;
  const briefWasEdited = JSON.stringify(content.company_brief) !== JSON.stringify(kit.generated_kit.company_brief);

  return <main className="kit-workspace">
    <Link href="/dashboard" className="back-link">&larr; Back to workspace</Link>
    <header className="workspace-heading">
      <div><span className="eyebrow">INTERVIEW PREPARATION WORKSPACE</span><h1>{content.source.company || "Interview kit"}</h1><p>{content.source.role || content.role.title} - {content.source.location || "Location not specified"}</p><a className="company-site-link" href={content.source.company_url} target="_blank" rel="noreferrer">Company website <span aria-hidden="true">↗</span></a></div>
      <div className="workspace-actions"><span className="revision-label">Revision {kit.revision}</span><button type="button" className="button button-primary" onClick={() => void save()} disabled={!dirty || blocked}>{saving ? "Saving..." : "Save changes"}</button></div>
    </header>
    <p className="editor-source-note">Generated content remains saved as the source. Your edits and pinned questions are stored separately.</p>
    {saved && <p className="save-confirmation" role="status">All changes saved.</p>}
    {generationWarnings.length > 0 && <div className="generation-warning" role="status"><strong>Research may be incomplete</strong><ul>{generationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>{kit.effective_kit.coverage.uncovered_requirement_ids.length > 0 && <p>Uncovered requirement IDs remain visible in the coverage section below.</p>}</div>}
    {error && <div className="editor-error" role="alert"><span>{error}</span>{error.includes("Reload") && <button type="button" className="text-button" onClick={reloadLatest}>Reload kit</button>}</div>}
    {regenerating && <div className="generation-status" role="status" aria-live="polite"><span className="spinner"/><span><strong>Regenerating {regenerating}...</strong><small>This may take a few minutes. Your other saved sections and pinned questions will be kept.</small></span></div>}

    <div className="workspace-stats"><div><strong>{questions.length}</strong><span>Questions</span></div><div><strong>{content.role.requirements.length}</strong><span>Requirements</span></div><div><strong>{content.schedule.days_available}</strong><span>Study days</span></div><div><strong>{uncovered.length}</strong><span>Saved uncovered IDs</span></div></div>

    <section className="workspace-section" aria-labelledby="brief-title">
      <div className="workspace-section-heading"><div><span className="eyebrow">01 - COMPANY CONTEXT</span><h2 id="brief-title">Company brief</h2></div><button className="button button-secondary" type="button" disabled={blocked || dirty} onClick={() => void regenerate("company_brief")}>{regenerating === "company brief" ? "Regenerating..." : "Regenerate brief"}</button></div>
      <div className="workspace-card brief-grid">
        <span className="content-origin">{briefWasEdited ? "Edited overlay" : "Generated source"}</span>
        <div><h3>What they do</h3><p>{content.company_brief.what_they_do || "No company summary was produced for this kit."}</p><h3>Brief summary</h3><p>{content.company_brief.summary || "No supporting summary is available."}</p></div>
        <div className="source-column"><h3>Company sources</h3><SourceList urls={companySources} /><h3>Additional research references</h3><p className="source-note">The saved kit combines research URLs and does not mark each URL's source type.</p><SourceList urls={additionalSources} /></div>
      </div>
    </section>

    <section className="workspace-section" aria-labelledby="requirements-title">
      <div className="workspace-section-heading"><div><span className="eyebrow">02 - ROLE PROFILE</span><h2 id="requirements-title">Requirements and responsibilities</h2></div></div>
      <div className="workspace-card"><p className="role-meta">{content.role.title} - {content.role.seniority}</p>{content.role.responsibilities.length > 0 && <ul className="responsibility-list">{content.role.responsibilities.map((item) => <li key={item}>{item}</li>)}</ul>}
        <div className="requirement-list">{requirements.map((requirement) => <article className="requirement-item" key={requirement.id}><span className={`priority-pill ${requirement.priority}`}>{requirement.priority === "must" ? "Must-have" : "Nice-to-have"}</span><div><strong>{requirement.text}</strong><small>{requirement.kind} - {requirement.id}</small></div>{uncovered.includes(requirement.id) && <span className="coverage-gap">No question reported</span>}</article>)}</div>
      </div>
    </section>

    <section className="workspace-section" aria-labelledby="questions-title">
      <div className="workspace-section-heading"><div><span className="eyebrow">03 - PRACTICE MATERIAL</span><h2 id="questions-title">Interview questions</h2><p>Edit prompts and answer outlines, then save to update the effective kit.</p></div></div>
      {CATEGORIES.map(({ id: category, label }) => {
        const group = questions.filter((question) => question.category === category);
        return <section className="question-group" key={category} aria-labelledby={`category-${category}`}>
          <div className="question-group-heading"><h3 id={`category-${category}`}>{label}<span>{group.length}</span></h3><button type="button" className="text-button" disabled={blocked || dirty} onClick={() => void regenerate("question_category", category)}>{regenerating === `${category} questions` ? "Regenerating..." : `Regenerate ${label.toLowerCase()}`}</button></div>
          {group.length === 0 && <p className="section-empty">No questions in this category.</p>}
          {group.map((question) => {
            const index = questions.findIndex(({ id: questionId }) => questionId === question.id);
            return <article id={`question-${encodeURIComponent(question.id)}`} tabIndex={-1} className={`question-editor${pins.has(question.id) ? " question-pinned" : ""}`} key={question.id}>
              <div className="question-editor-top"><span className="difficulty-label">Difficulty {question.difficulty}/3</span><span className="question-requirements">{question.requirement_ids.map((requirementId) => requirementById.get(requirementId)?.text ?? requirementId).join(" - ")}</span><div className="question-tools"><button type="button" aria-label={`Move question ${index + 1} up`} disabled={blocked || index === 0} onClick={() => moveQuestion(index, -1)}>&uarr;</button><button type="button" aria-label={`Move question ${index + 1} down`} disabled={blocked || index === questions.length - 1} onClick={() => moveQuestion(index, 1)}>&darr;</button><button type="button" aria-pressed={pins.has(question.id)} onClick={() => { const nextPins = new Set(pins); nextPins.has(question.id) ? nextPins.delete(question.id) : nextPins.add(question.id); setPins(nextPins); setDirty(true); setSaved(false); }} disabled={blocked}>{pins.has(question.id) ? "Unpin" : "Pin"}</button><button type="button" aria-label={`Delete question: ${question.prompt || "Custom question"}`} onClick={() => deleteQuestion(question)} disabled={blocked}>Delete</button></div></div>
              <label className="editor-field"><span>Question prompt</span><textarea value={question.prompt} rows={2} onChange={(event) => editQuestion(question.id, "prompt", event.target.value)} disabled={blocked} /></label>
              <label className="editor-field"><span>Answer outline</span><textarea value={question.answer_outline} rows={3} onChange={(event) => editQuestion(question.id, "answer_outline", event.target.value)} disabled={blocked} /></label>
              <small className="edit-origin">{pins.has(question.id) ? "Pinned question - preserved during section regeneration" : (() => { const generated = kit.generated_kit.questions.find((item) => item.id === question.id); return !generated ? "Your custom question" : generated.prompt !== question.prompt || generated.answer_outline !== question.answer_outline ? "Edited from generated content" : "Generated question"; })()}</small>
            </article>;
          })}
        </section>;
      })}
      <div className="add-question-panel"><h3>Add a custom question</h3><div className="add-question-controls"><label>Category<select value={newCategory} onChange={(event) => setNewCategory(event.target.value as KitQuestion["category"])} disabled={blocked}><option value="technical">Technical</option><option value="behavioural">Behavioural</option><option value="system-design">System design</option><option value="company-fit">Company fit</option></select></label><label>Requirement<select value={newRequirement} onChange={(event) => setNewRequirement(event.target.value)} disabled={blocked}>{requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.priority}: {requirement.text}</option>)}</select></label><button type="button" className="button button-secondary" onClick={addQuestion} disabled={blocked || !requirements.length}>Add question</button></div><p>Every question must reference an existing requirement so coverage and scheduling can be recalculated.</p></div>
    </section>

    <section className="workspace-section" aria-labelledby="coverage-title">
      <div className="workspace-section-heading"><div><span className="eyebrow">04 - VALIDATION</span><h2 id="coverage-title">Coverage</h2></div></div>
      <div className={`workspace-card coverage-summary${uncovered.length ? " has-gaps" : ""}`}><div><strong>{uncovered.length ? `${uncovered.length} uncovered requirement${uncovered.length === 1 ? "" : "s"} reported` : "No uncovered requirement IDs are reported"}</strong><p>{dirty ? "Coverage below reflects the last saved version. Save these edits to recalculate it on the server." : "Coverage is recalculated by the server from question requirement IDs when edits are saved."}</p></div>{uncovered.length > 0 && <ul>{uncovered.map((requirementId) => <li key={requirementId}>{requirementById.get(requirementId)?.text ?? requirementId} <span>({requirementById.get(requirementId)?.priority ?? "unknown"})</span></li>)}</ul>}</div>
    </section>

    <section className="workspace-section" aria-labelledby="schedule-title">
      <div className="workspace-section-heading"><div><span className="eyebrow">05 - PREPARATION PLAN</span><h2 id="schedule-title">Study schedule</h2><p>{dirty ? "Showing the last saved allocation; save changes for the server to rebuild it." : "The server rebuilds this plan deterministically after question edits are saved."}</p></div></div>
      <div className="schedule-grid">{content.schedule.days.map((day) => <article className="schedule-card" key={day.day}><div><span>DAY {day.day}</span><strong>{day.minutes} min</strong></div><h3>{day.focus}</h3>{day.question_ids.length ? <ul>{day.question_ids.map((questionId) => { const assigned = content.questions.find(({ id: itemId }) => itemId === questionId); return <li key={questionId}>{assigned ? <a href={`#question-${encodeURIComponent(questionId)}`} onClick={() => setScheduleNotice(`Opened the editor for: ${assigned.prompt}`)}>{assigned.prompt}</a> : questionId}</li>; })}</ul> : <p className="section-empty">No questions assigned for this day.</p>}</article>)}</div>
      {scheduleNotice && <p className="schedule-notice" role="status">{scheduleNotice}</p>}
    </section>

    <section className="workspace-section" aria-labelledby="flashcards-title"><div className="workspace-section-heading"><div><span className="eyebrow">06 - QUICK REVIEW</span><h2 id="flashcards-title">Flashcards</h2><p>Edit the front or back; practice progress is saved separately.</p></div><Link className="button button-secondary" href={`/kits/${encodeURIComponent(id)}/practice`}>Practice flashcards</Link></div>{flashcards.length === 0 ? <p className="section-empty">No flashcards are saved in this kit yet.</p> : <div className="flashcard-grid">{flashcards.map((card, index) => <article className="workspace-card flashcard-editor" key={card.id}><label className="editor-field"><span>Card {index + 1} - Front</span><textarea rows={2} value={card.front} disabled={blocked} onChange={(event) => { setFlashcards(flashcards.map((item) => item.id === card.id ? { ...item, front: event.target.value } : item)); setDirty(true); setSaved(false); }} /></label><label className="editor-field"><span>Back</span><textarea rows={3} value={card.back} disabled={blocked} onChange={(event) => { setFlashcards(flashcards.map((item) => item.id === card.id ? { ...item, back: event.target.value } : item)); setDirty(true); setSaved(false); }} /></label></article>)}</div>}</section>
    <div className="workspace-bottom-actions"><span>{dirty ? "Unsaved changes" : `Updated ${kit.updated_at ? new Date(kit.updated_at).toLocaleString() : "just now"}`}</span><button type="button" className="button button-primary" onClick={() => void save()} disabled={!dirty || blocked}>{saving ? "Saving..." : "Save changes"}</button></div>
  </main>;
}

function SourceList({ urls }: { urls: string[] }) {
  if (!urls.length) return <p className="source-empty">No source references are included.</p>;
  return <ul className="source-list">{urls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul>;
}



