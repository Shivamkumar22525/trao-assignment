# AI Interview Prep Kit

Scaffold for the Full-Stack Engineering Assessment. The project is organized as a modular monolith with a Next.js client and an Express API. Kit contracts and runtime validation are established before implementation of the retrieval and generation pipeline.

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

Appendix A types and Zod validation, initial persistence models, application-service contracts, and schema tests. Retrieval, LLM generation, authentication flows, coverage and schedule algorithms, evaluator behavior, and frontend pages remain future work.
