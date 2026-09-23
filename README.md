# AI Interview Prep Kit

Scaffold for the Full-Stack Engineering Assessment. The project is organized as a modular monolith with a Next.js client and an Express API. Kit contracts and runtime validation are established alongside bounded retrieval services.

## Setup

Setup instructions are a placeholder while the initial contracts are being established.

```sh
npm install
```

Copy `.env.example` to `.env` and configure the values before starting the server. Client and server development commands are `npm run dev:client` and `npm run dev:server`. Run contract tests with `npm test`.

The required evaluator entry point is present but deliberately not implemented yet:

```sh
npm run evaluate -- --input <cases.json> --output <kits.json>
```

## Current scope

Appendix A types and Zod validation, initial persistence models, application-service contracts, deterministic coverage and schedule services, the bounded research pipeline, and multi-stage kit generation. Structural validation checks the exact contract shape and primitive constraints; business validation checks IDs, references, coverage, and schedule consistency. Requirement and question IDs are content-derived during generation; maintaining IDs through later user edits and regeneration belongs to persistence/editor logic.

Authentication flows, evaluator behavior, and frontend pages remain future work. Password hashes and session token hashes are excluded from default queries and JSON serialization. Run `npm run typecheck` to typecheck the server and client once dependencies are installed.

## Company Research Pipeline

The company-site retrieval layer discovers links from fetched pages and ranks them deterministically using anchor text, URL terms, and the referring page title; it does not depend on fixed careers/about paths. It crawls sequentially within configurable page, depth, response-size, total-byte, timeout, redirect, and request-interval limits. It reads `robots.txt` first, applies the crawler's allow/disallow rules and crawl delay, treats a missing 404 policy as no published rules, and blocks crawling when the policy cannot be retrieved safely or requests a delay above the configured maximum. Individual source failures are recorded while successful pages remain available with their URL, title, extracted content, content type, and fetch time. URL checks reject loopback and internal hosts, reject private/non-public resolutions in production, pin validated DNS addresses for the socket connection, and validate redirects before following them. Fetched text remains untrusted source data; it is not executed or treated as application instructions. This layer does not perform LLM research.

## Public Interview Research

Public interview research uses an `InterviewResearchProvider` adapter boundary; this repository includes a deterministic in-memory provider for unit tests and no production search service. Queries and fetched sources are bounded by configuration. Sources retain their URL, domain, search snippet, retrieved content, retrieval time, matched query, and source type. Search and page failures are recorded independently so partial results survive. The fetch path uses existing URL validation, content-type, byte, timeout, redirect, and robots controls and does not bypass authentication, paywalls, CAPTCHAs, or other access controls. Retrieved text is untrusted source data and must never be interpreted as application instructions.

## Combined Research

`researchCompanyAndInterviews` combines company-site and public interview retrieval while keeping their source collections separate for later generation. Failures include a stage label, and warnings preserve partial-research context.

## Multi-stage AI Pipeline

Generation is split into requirement extraction, bounded research-context preparation, a source-grounded company brief, initial question generation, deterministic coverage checking, second-pass generation for uncovered requirements, a second coverage check, deterministic schedule allocation, and final kit validation. Each model response is parsed and checked against a stage-specific Zod schema; requirement and question IDs are assigned by the application using SHA-256 over normalized content and stable references.

Coverage decisions and schedule allocation stay outside the LLM so they are reproducible application rules rather than model claims. The gap pass receives only uncovered requirements and adds questions without replacing valid first-pass questions. The current repository provides the provider abstraction and a test fake, but no production vendor adapter; generation reports missing/unavailable provider configuration clearly. Flashcards remain an empty Appendix A collection until a later controlled step implements their generation.
