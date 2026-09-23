import type { InterviewResearchProvider, SearchResult } from "./types.js";

/** Deterministic in-memory adapter intended for unit tests and local examples only. */
export class InMemoryInterviewResearchProvider implements InterviewResearchProvider {
  readonly queries: string[] = [];

  constructor(
    private readonly results: Readonly<Record<string, readonly SearchResult[]>> = {},
    private readonly failureQueries: ReadonlySet<string> = new Set(),
  ) {}

  async search(query: string): Promise<SearchResult[]> {
    this.queries.push(query);
    if (this.failureQueries.has(query)) throw new Error("Configured in-memory search failure.");
    return [...(this.results[query] ?? [])].map((result) => ({ ...result }));
  }
}
