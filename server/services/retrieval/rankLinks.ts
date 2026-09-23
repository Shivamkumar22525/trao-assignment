import type { DiscoveredLink } from "./types.js";

export interface RankedLink extends DiscoveredLink {
  score: number;
}

const SIGNAL_WEIGHTS: ReadonlyArray<{ words: readonly string[]; weight: number }> = [
  { words: ["about", "company"], weight: 10 },
  { words: ["product", "products", "platform", "solution", "solutions", "mission"], weight: 8 },
  { words: ["career", "careers", "job", "jobs", "hiring", "interview"], weight: 9 },
  { words: ["role", "roles", "opportunity", "opportunities"], weight: 7 },
  { words: ["team", "culture", "work", "engineering", "technology", "people"], weight: 6 },
];

const NEGATIVE_WORDS = ["privacy", "terms", "cookie", "login", "signin", "sign-in"] as const;

function toWords(value: string): Set<string> {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Keep malformed escapes as ordinary text. */ }
  return new Set(decoded.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Semantic scoring only: no particular careers/about URL path is required. */
export function scoreLink(link: DiscoveredLink, pageTitle = ""): number {
  const words = toWords(`${link.anchorText} ${link.url} ${pageTitle}`);
  let score = 0;
  for (const signal of SIGNAL_WEIGHTS) {
    if (signal.words.some((word) => words.has(word))) score += signal.weight;
  }
  for (const word of NEGATIVE_WORDS) {
    if (words.has(word)) score -= 5;
  }
  return score;
}

export function rankLinks(links: readonly DiscoveredLink[], pageTitle = ""): RankedLink[] {
  return links.map((link) => ({ ...link, score: scoreLink(link, pageTitle) }))
    .sort((left, right) => right.score - left.score
      || (left.url < right.url ? -1 : left.url > right.url ? 1 : 0)
      || (left.anchorText < right.anchorText ? -1 : left.anchorText > right.anchorText ? 1 : 0));
}
