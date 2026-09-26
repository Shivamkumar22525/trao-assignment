# AI Interview Prep Kit

Implementation for the Full-Stack Engineering Assessment. The project is organized as a modular monolith with a Next.js client and an Express API. Kit contracts, authenticated persistence, generation, and bounded retrieval services are provided.

## Setup

```sh
npm install
```

Copy `.env.example` to `.env`, start MongoDB, and configure `MONGODB_URI`, `CLIENT_ORIGIN`, and `GEMINI_API_KEY` before starting the server. For the client, copy `client/.env.example` to `client/.env.local` and set `NEXT_PUBLIC_API_BASE_URL` to the Express API origin. This is a public URL, never a place for credentials. Client and server development commands are `npm run dev:client` and `npm run dev:server`. Run tests with `npm test` and typecheck with `npm run typecheck`.

Run the required standalone batch evaluator (it uses the same retrieval, Gemini-backed multi-stage generation pipeline, coverage check, scheduler, and Appendix A validation as the application; it does not connect to MongoDB or require a login):

```sh
npm run evaluate -- --input <cases.json> --output <kits.json>
```

The input file is a JSON array. Each case has exactly these fields: `id` (non-empty string), `jd` (non-empty string), `company_url` (string), and `days` (integer from 1 through 366; this includes the assessment's 60-day case). A case with an invalid ID cannot be represented in the required output envelope and is a fatal input error. Other invalid cases with IDs are recorded individually and later cases continue. Example input: [`examples/evaluator-cases.json`](examples/evaluator-cases.json).

The output follows Appendix B: `{ "version": "1.0", "generated_at": "<UTC ISO-8601>", "kits": [...] }`. Every result contains only `id`, `status`, `kit`, and `error`. A generated valid kit has status `ok` even when research was partial; its Appendix A source and coverage fields preserve the gaps. A case that cannot produce a valid kit has status `failed`, `kit: null`, and a structured `{code,message}` error. Fatal file/argument errors exit non-zero; a completed batch with per-case failures exits zero because those failures are recorded in the output. Batch generation has a 14-minute overall deadline and a 135-second deadline per case; LLM stages are capped at 20 seconds including the provider's retries. Batch-only company research is limited to three pages plus robots retrieval, 3-second request and URL validation timeouts, one retry, retry delays capped at 500 ms, and crawl delays capped at one second. Public interview retrieval also receives bounded query, source, request, and retry limits. These evaluator limits do not change interactive generation defaults. Deadline failures are recorded with sanitized `CASE_TIMEOUT` or `BATCH_TIMEOUT` errors, and cancellation is propagated through model and retrieval stages. Configure `GEMINI_API_KEY`, `GEMINI_MODEL`, and `LLM_PROVIDER` in `.env` as described above. No database service is needed for this command.

## Current scope

Appendix A types and Zod validation, persistence models, application services, deterministic coverage and schedule services, the bounded research pipeline, multi-stage kit generation, and the Appendix B batch evaluator. Structural validation checks the exact contract shape and primitive constraints; business validation checks IDs, references, coverage, and schedule consistency. Requirement and question IDs are content-derived during generation; maintaining IDs through later user edits and regeneration belongs to persistence/editor logic.

Password hashes and session token hashes are excluded from default queries and JSON serialization. Kit edits are persisted as validated overlays with `edited` or `pinned` state; the generated Appendix A object remains separately preserved.

The frontend currently provides registration and login, a session-protected workspace dashboard, and a read-only overview route for saved kits. It uses the backend's cookie session and does not store session tokens in browser storage. Kit creation, editing, practice, and schedule views are separate follow-up steps.

## Backend API

The Express API exposes `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`. It stores opaque, expiring server-side sessions and sends the session token only in an HttpOnly, SameSite cookie (Secure in production). Set `CLIENT_ORIGIN` to the exact browser origin; credentialed CORS preflight is limited to that origin.

Authenticated kit operations are `POST /api/kits` (runs the shared multi-stage generator and records a generation job), `GET /api/kits` (owner-scoped pagination), `GET /api/kits/:id`, `PATCH /api/kits/:id` (validated editable overlay), and `DELETE /api/kits/:id`. The authenticated account determines ownership; request bodies cannot choose an owner. A failed generation is retained as a failed job with a sanitized error and does not create a kit.

## API abuse controls

Registration is limited by the connecting peer address to 5 requests per hour by default; login is limited to 10 requests per 15 minutes. Kit generation is limited to 5 requests per authenticated user per hour, with one concurrent generation per user. Configure these values with `AUTH_LOGIN_RATE_WINDOW_MS`, `AUTH_LOGIN_RATE_MAX`, `AUTH_REGISTER_RATE_WINDOW_MS`, `AUTH_REGISTER_RATE_MAX`, `GENERATION_RATE_WINDOW_MS`, `GENERATION_RATE_MAX`, and `GENERATION_MAX_CONCURRENT_PER_USER`. Values are validated as bounded positive integers at server startup. IP limits use the direct socket peer address; forwarded IP headers are ignored because no trusted reverse proxy is configured. These counters are in memory, reset when the process restarts, and do not coordinate across multiple server instances. They are a single-instance MVP control, not distributed enforcement.

## Company Research Pipeline

The company-site retrieval layer discovers links from fetched pages and ranks them deterministically using anchor text, URL terms, and the referring page title; it does not depend on fixed careers/about paths. It crawls sequentially within configurable page, depth, response-size, total-byte, timeout, redirect, and request-interval limits. It reads `robots.txt` first, applies the crawler's allow/disallow rules and crawl delay, treats a missing 404 policy as no published rules, and blocks crawling when the policy cannot be retrieved safely or requests a delay above the configured maximum. Individual source failures are recorded while successful pages remain available with their URL, title, extracted content, content type, and fetch time. URL checks reject loopback and internal hosts, reject private/non-public resolutions in production, pin validated DNS addresses for the socket connection, and validate redirects before following them. Fetched text remains untrusted source data; it is not executed or treated as application instructions. This layer does not perform LLM research.

## Public Interview Research

Public interview research uses an `InterviewResearchProvider` adapter boundary; this repository includes a deterministic in-memory provider for unit tests and no production search service. Queries and fetched sources are bounded by configuration. Sources retain their URL, domain, search snippet, retrieved content, retrieval time, matched query, and source type. Search and page failures are recorded independently so partial results survive. The fetch path uses existing URL validation, content-type, byte, timeout, redirect, and robots controls and does not bypass authentication, paywalls, CAPTCHAs, or other access controls. Retrieved text is untrusted source data and must never be interpreted as application instructions.

## Combined Research

`researchCompanyAndInterviews` combines company-site and public interview retrieval while keeping their source collections separate for later generation. Failures include a stage label, and warnings preserve partial-research context.

## Multi-stage AI Pipeline

Generation is split into requirement extraction, bounded research-context preparation, a source-grounded company brief, initial question generation, deterministic coverage checking, second-pass generation for uncovered requirements, a second coverage check, deterministic schedule allocation, and final kit validation. Each model response is parsed and checked against a stage-specific Zod schema; requirement and question IDs are assigned by the application using SHA-256 over normalized content and stable references.

Coverage decisions and schedule allocation stay outside the LLM so they are reproducible application rules rather than model claims. The gap pass receives only uncovered requirements and adds questions without replacing valid first-pass questions. The server uses Google's official `@google/genai` SDK through the existing provider abstraction. For local use, copy `.env.example` to `.env`, set `LLM_PROVIDER=gemini`, add a server-only `GEMINI_API_KEY`, and optionally change `GEMINI_MODEL` (default: `gemini-3.8-flash`). The Express server loads either the repository-root `.env` or `server/.env`; keep the key in one of those ignored server-side files or your process environment. Obtain a key from [Google AI Studio's API keys page](https://aistudio.google.com/apikey). Never use a `NEXT_PUBLIC_` variable or put the key in client code.

Gemini Advanced / Google AI Pro subscription benefits and Gemini API quotas or billing are separate. Check your own Google AI Studio API usage, [current quota and rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), and [Gemini API billing and pricing](https://ai.google.dev/gemini-api/docs/billing) before use. API rate limits depend on your project, tier, and model. Flashcards remain an empty Appendix A collection until a later controlled step implements their generation.
