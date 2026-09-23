import * as http from "node:http";
import * as https from "node:https";
import type { ResearchConfig } from "./config.js";
import { getResearchConfig } from "./config.js";
import { UrlValidationError, validateUrl } from "./urlSecurity.js";
import type { ResolvedAddress } from "./types.js";

export type FetchErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_NOT_ALLOWED"
  | "UNSAFE_HOSTNAME"
  | "UNSAFE_ADDRESS"
  | "DNS_LOOKUP_FAILED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "HTTP_ERROR"
  | "TOO_MANY_REDIRECTS"
  | "CROSS_DOMAIN_REDIRECT";

export type PageFetchResult =
  | { ok: true; url: string; status: number; contentType: string; html: string; finalUrl: string; bytes: number }
  | { ok: false; url: string; status?: number; error: { code: FetchErrorCode; message: string } };

export interface FetchTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface FetchTransportOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export type FetchTransport = (
  url: URL,
  addresses: readonly ResolvedAddress[],
  options: FetchTransportOptions,
) => Promise<FetchTransportResponse>;

export interface FetchPageOptions {
  config?: ResearchConfig;
  maxResponseBytes?: number;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: FetchTransport;
  beforeRequest?: () => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  redirectAllowed?: (fromUrl: URL, toUrl: URL) => boolean;
}

class TransportFailure extends Error {
  constructor(public readonly code: "TIMEOUT" | "RESPONSE_TOO_LARGE" | "NETWORK_ERROR") {
    super(code);
    this.name = "TransportFailure";
  }
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target);
  return key ? headers[key] : undefined;
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value,
  ]));
}

const nativeTransport: FetchTransport = (url, addresses, options) => new Promise((resolve, reject) => {
  const destination = addresses[0];
  if (!destination) {
    reject(new TransportFailure("NETWORK_ERROR"));
    return;
  }
  const client = url.protocol === "https:" ? https : http;
  const pinnedLookup: NonNullable<http.RequestOptions["lookup"]> = (_hostname, lookupOptions, callback) => {
    const addressInfo = { address: destination.address, family: destination.family };
    if (typeof lookupOptions === "object" && lookupOptions.all) callback(null, [addressInfo]);
    else callback(null, addressInfo.address, addressInfo.family);
  };

  const request = client.request(url, {
    method: "GET",
    agent: false,
    lookup: pinnedLookup,
    headers: {
      "user-agent": options.userAgent,
      accept: "text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.1",
    },
  }, (response) => {
    const headers = normalizeHeaders(response.headers);
    const contentLength = Number(headerValue(headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      response.destroy();
      reject(new TransportFailure("RESPONSE_TOO_LARGE"));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    response.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > options.maxBytes) {
        settled = true;
        response.destroy();
        reject(new TransportFailure("RESPONSE_TOO_LARGE"));
        return;
      }
      chunks.push(bytes);
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
    });
    response.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new TransportFailure("NETWORK_ERROR"));
    });
  });

  const absoluteTimeout = setTimeout(() => request.destroy(new TransportFailure("TIMEOUT")), options.timeoutMs);
  absoluteTimeout.unref?.();
  request.on("close", () => clearTimeout(absoluteTimeout));
  request.setTimeout(options.timeoutMs, () => request.destroy(new TransportFailure("TIMEOUT")));
  request.on("error", (error: Error) => {
    reject(error instanceof TransportFailure ? error : new TransportFailure("NETWORK_ERROR"));
  });
  request.end();
});

function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return delay;
}

function mapValidationCode(error: UrlValidationError): FetchErrorCode {
  return error.code;
}

function failure(url: string, code: FetchErrorCode, message: string, status?: number): PageFetchResult {
  return { ok: false, url, ...(status === undefined ? {} : { status }), error: { code, message } };
}

/**
 * Fetches one HTML/XHTML/plain-text page. Redirect destinations are revalidated
 * and DNS answers are pinned to the socket lookup to reduce rebinding risk.
 */
export async function fetchPage(inputUrl: string, options: FetchPageOptions = {}): Promise<PageFetchResult> {
  const config = options.config ?? getResearchConfig();
  const maxBytes = options.maxResponseBytes ?? config.maxResponseBytes;
  const transport = options.transport ?? nativeTransport;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  let currentUrl = inputUrl;
  let previousUrl: URL | undefined;
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    let validated;
    try {
      validated = await validateUrl(currentUrl, {
        production: config.production,
        resolveHostname: options.resolveHostname,
        timeoutMs: config.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof UrlValidationError) return failure(inputUrl, mapValidationCode(error), error.message);
      return failure(inputUrl, "INVALID_URL", "The destination URL could not be validated.");
    }

    validated.url.hash = ""; // Fragments are client-side only and must not affect redirect-loop checks.
    const canonicalUrl = validated.url.href;
    if (previousUrl && options.redirectAllowed && !options.redirectAllowed(previousUrl, validated.url)) {
      return failure(inputUrl, "CROSS_DOMAIN_REDIRECT", "The redirect left the permitted company domain.");
    }
    if (visited.has(canonicalUrl)) return failure(inputUrl, "TOO_MANY_REDIRECTS", "The page redirected in a loop.");
    visited.add(canonicalUrl);

    let response: FetchTransportResponse | undefined;
    let retryDelayExceeded = false;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        await options.beforeRequest?.();
        response = await transport(validated.url, validated.addresses, {
          timeoutMs: config.requestTimeoutMs,
          maxBytes,
          userAgent: config.userAgent,
        });
      } catch (error) {
        if (error instanceof UrlValidationError) return failure(inputUrl, error.code, error.message);
        if (error instanceof TransportFailure) {
          const messages: Record<TransportFailure["code"], string> = {
            TIMEOUT: "The page request timed out.",
            RESPONSE_TOO_LARGE: "The page exceeded the configured response-size limit.",
            NETWORK_ERROR: "The page could not be fetched due to a network error.",
          };
          return failure(inputUrl, error.code, messages[error.code]);
        }
        return failure(inputUrl, "NETWORK_ERROR", "The page could not be fetched due to a network error.");
      }

      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === config.maxRetries) break;
      const backoff = Math.min(config.retryBaseDelayMs * (2 ** attempt), config.retryMaxDelayMs);
      const retryAfter = retryAfterMs(headerValue(response.headers, "retry-after"), now());
      if (retryAfter !== undefined && retryAfter > config.retryMaxDelayMs) {
        retryDelayExceeded = true;
        break;
      }
      await sleep(retryAfter ?? backoff);
    }

    if (!response) return failure(inputUrl, "NETWORK_ERROR", "The page could not be fetched.");
    if (retryDelayExceeded) {
      return failure(inputUrl, "HTTP_ERROR", "The source requested a retry delay beyond the configured limit; no early retry was sent.", response.status);
    }
    const location = headerValue(response.headers, "location");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!location) return failure(inputUrl, "HTTP_ERROR", "The page returned a redirect without a destination.", response.status);
      if (redirectCount === config.maxRedirects) return failure(inputUrl, "TOO_MANY_REDIRECTS", "The page exceeded the redirect limit.", response.status);
      try {
        previousUrl = validated.url;
        currentUrl = new URL(location, validated.url).href;
      } catch {
        return failure(inputUrl, "INVALID_URL", "The page returned an invalid redirect destination.", response.status);
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      return failure(inputUrl, "HTTP_ERROR", `The source returned HTTP ${response.status}.`, response.status);
    }
    const contentTypeHeader = headerValue(response.headers, "content-type") ?? "";
    const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();
    if (!new Set(["text/html", "application/xhtml+xml", "text/plain"]).has(contentType)) {
      return failure(inputUrl, "UNSUPPORTED_CONTENT_TYPE", "The source did not return supported text content.", response.status);
    }
    if (response.body.byteLength > maxBytes) {
      return failure(inputUrl, "RESPONSE_TOO_LARGE", "The page exceeded the configured response-size limit.", response.status);
    }

    return {
      ok: true,
      url: inputUrl,
      status: response.status,
      contentType,
      html: new TextDecoder().decode(response.body),
      finalUrl: validated.url.href,
      bytes: response.body.byteLength,
    };
  }

  return failure(inputUrl, "TOO_MANY_REDIRECTS", "The page exceeded the redirect limit.");
}
