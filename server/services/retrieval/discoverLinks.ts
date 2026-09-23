import type { DiscoveredLink, ExtractedLink } from "./types.js";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

export function normalizeUrl(input: string, baseUrl?: string): string | undefined {
  let url: URL;
  try {
    url = baseUrl ? new URL(input, baseUrl) : new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function baseDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

export function isSameCompanyDomain(candidateUrl: string, companyUrl: string): boolean {
  try {
    const candidateHost = baseDomain(new URL(candidateUrl).hostname.replace(/^\[|\]$/g, ""));
    const companyHost = baseDomain(new URL(companyUrl).hostname.replace(/^\[|\]$/g, ""));
    return candidateHost === companyHost || candidateHost.endsWith(`.${companyHost}`);
  } catch {
    return false;
  }
}

/** Resolve relative links and keep only safe HTTP(S) links on the company domain. */
export function discoverLinks(
  links: readonly ExtractedLink[],
  pageUrl: string,
  companyUrl: string,
): DiscoveredLink[] {
  const unique = new Map<string, DiscoveredLink>();
  for (const link of links) {
    const href = link.href.trim();
    if (!href || href.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;
    const url = normalizeUrl(href, pageUrl);
    if (!url || !isSameCompanyDomain(url, companyUrl)) continue;
    if (!unique.has(url)) unique.set(url, { anchorText: link.anchorText.trim(), href, url });
  }
  return [...unique.values()].sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
}
