import type { CompleteKit } from "../../server/types/kit.js";

export const validKit: CompleteKit = {
  source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "Remote", jd_chars: 100, researched_at: "2026-01-01T00:00:00Z", pages_used: ["https://example.com"] },
  company_brief: { summary: "A sample company.", what_they_do: "Builds sample products.", sources: ["https://example.com"] },
  role: {
    title: "Engineer",
    seniority: "Senior",
    responsibilities: ["Build reliable services"],
    requirements: [{ id: "r1", text: "Experience with TypeScript", kind: "technical", priority: "must" }],
  },
  questions: [{ id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "How do you use TypeScript?", answer_outline: "Discuss practical examples.", difficulty: 2 }],
  flashcards: [{ id: "f1", front: "What is TypeScript?", back: "A typed superset of JavaScript.", requirement_ids: ["r1"] }],
  schedule: { days_available: 1, days: [{ day: 1, focus: "TypeScript", question_ids: ["q1"], minutes: 30 }] },
  coverage: { uncovered_requirement_ids: [], passes: 2 },
};
