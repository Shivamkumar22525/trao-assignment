import type { CombinedResearchResult, InterviewResearchSource, ResearchSource } from "../retrieval/types.js";

export interface ResearchContextSource {
  url: string;
  type: string;
  title: string;
  snippet: string;
  content: string;
}

export interface PreparedResearchContext {
  company_sources: ResearchContextSource[];
  interview_sources: ResearchContextSource[];
  warnings: string[];
  truncated: boolean;
  serialized: string;
}

export interface ResearchContextOptions { maxBytes?: number; maxSources?: number }

function toContextSource(source: ResearchSource | InterviewResearchSource, type: string): ResearchContextSource {
  return {
    url: source.url,
    type,
    title: source.title,
    snippet: "snippet" in source ? source.snippet : source.description,
    content: source.content,
  };
}

function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

/** Retains source boundaries and provenance while enforcing a byte cap on the serialized model context. */
export function buildResearchContext(research: CombinedResearchResult, options: ResearchContextOptions = {}): PreparedResearchContext {
  const maxBytes = Math.max(0, options.maxBytes ?? 64 * 1024);
  const maxSources = Math.max(0, options.maxSources ?? 12);
  const company = research.company_sources.map((source) => toContextSource(source, "company"));
  const interviews = research.interview_sources.map((source) => toContextSource(source, source.source_type));
  const all = [...company.map((source) => ({ group: "company_sources" as const, source })), ...interviews.map((source) => ({ group: "interview_sources" as const, source }))].slice(0, maxSources);
  let truncated = company.length + interviews.length > all.length;
  const context: Omit<PreparedResearchContext, "serialized"> = { company_sources: [], interview_sources: [], warnings: [...research.research_warnings], truncated: false };
  const serializeSources = () => JSON.stringify({ company_sources: context.company_sources, interview_sources: context.interview_sources });
  const noteTruncation = () => {
    truncated = true;
    context.truncated = true;
    if (!context.warnings.includes("Research context was truncated to respect the configured size limit.")) {
      context.warnings.push("Research context was truncated to respect the configured size limit.");
    }
  };
  if (truncated) noteTruncation();
  for (const { group, source } of all) {
    const target = context[group];
    const candidate = { ...source };
    target.push(candidate);
    if (byteLength(serializeSources()) > maxBytes) {
      candidate.content = "";
      noteTruncation();
      if (byteLength(serializeSources()) > maxBytes) {
        target.pop();
      } else {
        const points = [...source.content];
        let low = 0;
        let high = points.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          candidate.content = points.slice(0, middle).join("");
          if (byteLength(serializeSources()) <= maxBytes) low = middle;
          else high = middle - 1;
        }
        candidate.content = points.slice(0, low).join("");
        if (low < points.length) noteTruncation();
      }
    }
  }
  context.truncated = truncated;
  const serialized = serializeSources();
  // Even empty arrays plus warnings can exceed an intentionally tiny test limit; retain valid structure and report it.
  return { ...context, serialized };
}
