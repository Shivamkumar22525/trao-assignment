"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";
import { api, ApiError, GenerateKitInput, readableApiError } from "../lib/api";

interface FieldErrors { company_name?: string; company_url?: string; role?: string; jd?: string; days?: string; }

function validate(input: { company_name: string; company_url: string; role: string; jd: string; days: string }): { errors: FieldErrors; payload?: GenerateKitInput } {
  const errors: FieldErrors = {};
  const companyName = input.company_name.trim();
  const role = input.role.trim();
  const urlValue = input.company_url.trim();
  const jd = input.jd.trim();
  if (companyName.length > 200) errors.company_name = "Company name must be 200 characters or fewer.";
  if (!urlValue) errors.company_url = "Enter the company's public website.";
  else if (urlValue.length > 2048) errors.company_url = "Website URL must be 2,048 characters or fewer.";
  else {
    try {
      const parsed = new URL(urlValue);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) errors.company_url = "Use a public HTTP or HTTPS URL without a username or password.";
    } catch { errors.company_url = "Enter a valid company website URL, including https://."; }
  }
  if (role.length > 200) errors.role = "Job title must be 200 characters or fewer.";
  if (!jd) errors.jd = "Paste the job description to continue.";
  else if (jd.length > 30_000) errors.jd = "Job description must be 30,000 characters or fewer.";
  const days = input.days.trim() ? Number(input.days) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > 30) errors.days = "Enter a whole number from 1 to 30.";
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    payload: {
      jd,
      company_url: urlValue,
      days,
      ...(companyName ? { company_name: companyName } : {}),
      ...(role ? { role } : {}),
    },
  };
}

function friendlyGenerationError(error: unknown): { message: string; uncertain: boolean } {
  if (error instanceof ApiError) {
    const message = error.message.toLowerCase();
    if (error.code === "REQUEST_TIMEOUT" || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE") {
      return { message: "We couldn't confirm whether the server finished this request. Check your saved kits before trying again to avoid creating a duplicate.", uncertain: true };
    }
    if (error.status === 429 || /rate.?limit|quota/.test(message)) {
      return { message: "The AI service is rate-limited or its API quota is currently unavailable. Please try again later or ask the administrator to check API usage.", uncertain: false };
    }
    if (/not configured|gemini_api_key|llm_provider|api key/.test(message)) {
      return { message: "Kit generation is not configured on the server yet. Please contact the administrator.", uncertain: false };
    }
    if (/timed out|timeout/.test(message)) {
      return { message: "Generation timed out and the server reported that it did not finish. Please try again in a moment.", uncertain: false };
    }
    return { message: readableApiError(error), uncertain: false };
  }
  return { message: "We couldn't confirm whether the server finished this request. Check your saved kits before trying again to avoid creating a duplicate.", uncertain: true };
}

export function CreateKitForm() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [companyName, setCompanyName] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [days, setDays] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || outcomeUnknown) return;
    setFormError("");
    const result = validate({ company_name: companyName, company_url: companyUrl, role, jd, days });
    setFieldErrors(result.errors);
    if (!result.payload) {
      const firstInvalid = Object.keys(result.errors)[0];
      if (firstInvalid) document.getElementById(`kit-${firstInvalid}`)?.focus();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const response = await api.generateKit(result.payload);
      if (!response?.kit?.id) {
        setOutcomeUnknown(true);
        setFormError("The server responded, but did not return a saved kit ID. Check your dashboard before trying again.");
        return;
      }
      router.push(`/kits/${encodeURIComponent(response.kit.id)}`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/kits/new")}`);
        return;
      }
      const friendly = friendlyGenerationError(error);
      setFormError(friendly.message);
      setOutcomeUnknown(friendly.uncertain);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="create-kit-page">
      <Link href="/dashboard" className="back-link">&larr; Back to workspace</Link>
      <div className="create-kit-heading"><span className="eyebrow">START WITH THE ROLE</span><h1>Create an interview kit<span className="accent-dot">.</span></h1><p>Share the job description and company website. We'll prepare a saved kit for this opportunity.</p></div>
      <div className="create-kit-layout">
        <form className="create-kit-card" onSubmit={submit} noValidate aria-busy={submitting}>
          <div className="form-section-heading"><span className="step-number">01</span><div><h2>Company and role</h2><p>Tell us where you're interviewing.</p></div></div>
          <div className="form-grid">
            <div className="field-group"><label htmlFor="kit-company_name">Company name <span className="optional-label">Optional</span></label><input id="kit-company_name" name="company_name" autoComplete="organization" maxLength={200} value={companyName} onChange={(event) => setCompanyName(event.target.value)} aria-invalid={Boolean(fieldErrors.company_name)} aria-describedby={fieldErrors.company_name ? "kit-company_name-error" : "kit-company_name-help"} /><span id="kit-company_name-help" className="field-help">If blank, we'll use the website name.</span>{fieldErrors.company_name && <span id="kit-company_name-error" className="field-error">{fieldErrors.company_name}</span>}</div>
            <div className="field-group"><label htmlFor="kit-role">Job title / role <span className="optional-label">Optional</span></label><input id="kit-role" name="role" autoComplete="organization-title" maxLength={200} value={role} onChange={(event) => setRole(event.target.value)} aria-invalid={Boolean(fieldErrors.role)} aria-describedby={fieldErrors.role ? "kit-role-error" : "kit-role-help"} /><span id="kit-role-help" className="field-help">If blank, we'll use the role described in the job posting.</span>{fieldErrors.role && <span id="kit-role-error" className="field-error">{fieldErrors.role}</span>}</div>
            <div className="field-group field-span"><label htmlFor="kit-company_url">Company website <span className="required-label">Required</span></label><input id="kit-company_url" name="company_url" type="url" inputMode="url" autoComplete="url" placeholder="https://company.com" maxLength={2048} required value={companyUrl} onChange={(event) => setCompanyUrl(event.target.value)} aria-invalid={Boolean(fieldErrors.company_url)} aria-describedby={fieldErrors.company_url ? "kit-company_url-error" : "kit-company_url-help"} /><span id="kit-company_url-help" className="field-help">Use the company's public website, not a private or login-only page.</span>{fieldErrors.company_url && <span id="kit-company_url-error" className="field-error">{fieldErrors.company_url}</span>}</div>
          </div>

          <div className="form-divider" />
          <div className="form-section-heading"><span className="step-number">02</span><div><h2>Job description and timing</h2><p>Use the actual posting so preparation stays relevant.</p></div></div>
          <div className="field-group"><label htmlFor="kit-jd">Job description <span className="required-label">Required</span></label><textarea id="kit-jd" name="jd" rows={9} maxLength={30_000} required placeholder="Paste the full job description here..." value={jd} onChange={(event) => setJd(event.target.value)} aria-invalid={Boolean(fieldErrors.jd)} aria-describedby={fieldErrors.jd ? "kit-jd-error" : "kit-jd-help"} /><div className="field-meta"><span id="kit-jd-help" className="field-help">Paste the complete posting, including responsibilities and requirements.</span><span className="character-count">{jd.length.toLocaleString()} / 30,000</span></div>{fieldErrors.jd && <span id="kit-jd-error" className="field-error">{fieldErrors.jd}</span>}</div>
          <div className="field-group days-field"><label htmlFor="kit-days">Days until your interview <span className="required-label">Required</span></label><input id="kit-days" name="days" type="number" inputMode="numeric" min={1} max={30} step={1} placeholder="e.g. 7" required value={days} onChange={(event) => setDays(event.target.value)} aria-invalid={Boolean(fieldErrors.days)} aria-describedby={fieldErrors.days ? "kit-days-error" : "kit-days-help"} /><span id="kit-days-help" className="field-help">Choose 1 to 30 whole days.</span>{fieldErrors.days && <span id="kit-days-error" className="field-error">{fieldErrors.days}</span>}</div>

          {formError && <div className={`generation-error${outcomeUnknown ? " generation-uncertain" : ""}`} role="alert"><strong>{outcomeUnknown ? "Check before retrying" : "We couldn't create the kit"}</strong><span>{formError}</span>{outcomeUnknown && <Link href="/dashboard" className="text-button">Check your saved kits</Link>}</div>}
          {submitting && <div className="generation-status" role="status" aria-live="polite"><span className="spinner"/><span><strong>Generating and saving your kit...</strong><small>This request can take a few minutes. Keep this page open while it runs.</small></span></div>}
          <div className="form-actions"><button type="button" className="button button-quiet" disabled={submitting} onClick={() => router.push("/dashboard")}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting || outcomeUnknown}>{submitting ? "Working..." : outcomeUnknown ? "Check saved kits" : "Generate interview kit"}</button></div>
        </form>
        <aside className="create-kit-aside"><div className="aside-icon" aria-hidden="true">*</div><span className="eyebrow">A GOOD PLACE TO START</span><h2>Make it specific.</h2><p>Paste the actual job description and share the company's public website. Those details help make the preparation relevant to this role.</p><div className="aside-detail"><span aria-hidden="true">&rarr;</span><span>Your kit is saved to your account when generation succeeds.</span></div><div className="aside-detail"><span aria-hidden="true">&rarr;</span><span>Coverage and research references are available in the saved kit overview.</span></div></aside>
      </div>
    </div>
  );
}



