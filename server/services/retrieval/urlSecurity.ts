import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ResolvedAddress } from "./types.js";

export type UrlValidationErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_NOT_ALLOWED"
  | "UNSAFE_HOSTNAME"
  | "UNSAFE_ADDRESS"
  | "DNS_LOOKUP_FAILED";

export class UrlValidationError extends Error {
  constructor(public readonly code: UrlValidationErrorCode, message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

export interface UrlValidationOptions {
  production?: boolean;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
  timeoutMs?: number;
}

export interface ValidatedUrl {
  url: URL;
  addresses: ResolvedAddress[];
}

const defaultResolver = async (hostname: string): Promise<ResolvedAddress[]> => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return octets;
}

function isNonPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function ipv6Groups(address: string): number[] | undefined {
  let input = address.toLowerCase().split("%")[0];
  const mappedPrefix = input.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedPrefix) {
    const octets = parseIpv4(mappedPrefix[1]);
    if (!octets) return undefined;
    return [0, 0, 0, 0, 0, 0xffff, (octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
  }
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const octets = parseIpv4(input.slice(lastColon + 1));
    if (!octets) return undefined;
    input = `${input.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 1 && left.length !== 8 || zeros < 0) return undefined;
  const groups = [...left, ...Array.from({ length: zeros }, () => 0), ...right];
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? groups
    : undefined;
}

function isNonPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const allZeroExceptLast = groups.slice(0, 7).every((part) => part === 0);
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) return true; // unspecified / loopback
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isNonPublicIpv4(v4);
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast
  // Only global-unicast 2000::/3 is accepted in production. Exclude documentation space.
  if ((groups[0] & 0xe000) !== 0x2000) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family === 6) return isNonPublicIpv6(address);
  return true;
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return parseIpv4(address)?.[0] === 127;
  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const zeroPrefix = groups.slice(0, 7).every((part) => part === 0);
  if (zeroPrefix && groups[7] === 1) return true;
  const mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  if (!mapped) return false;
  return (groups[6] >> 8) === 127;
}

function hostnameIsObviousInternal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return false;
  return host === "localhost" || host.endsWith(".localhost")
    || host.endsWith(".local") || host.endsWith(".internal")
    || host.endsWith(".lan") || host.endsWith(".home")
    || host === "metadata" || host === "metadata.google.internal"
    || host === "instance-data" || !host.includes(".");
}

export async function validateUrl(input: string, options: UrlValidationOptions = {}): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlValidationError("INVALID_URL", "The supplied URL is malformed.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlValidationError("UNSUPPORTED_PROTOCOL", "Only http and https URLs can be fetched.");
  }
  if (url.username || url.password) {
    throw new UrlValidationError("CREDENTIALS_NOT_ALLOWED", "URLs containing credentials are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostnameIsObviousInternal(hostname)) {
    throw new UrlValidationError("UNSAFE_HOSTNAME", "Local and internal hostnames are not allowed.");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isLoopbackAddress(hostname)) {
      throw new UrlValidationError("UNSAFE_ADDRESS", "Loopback addresses are not allowed.");
    }
    if (options.production && isNonPublicAddress(hostname)) {
      throw new UrlValidationError("UNSAFE_ADDRESS", "Private or non-public IP addresses are not allowed in production.");
    }
  }

  let addresses: ResolvedAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    try {
      const resolver = options.resolveHostname ?? defaultResolver;
      addresses = await new Promise<ResolvedAddress[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DNS validation timed out")), options.timeoutMs ?? 5_000);
        resolver(hostname).then(
          (resolved) => { clearTimeout(timer); resolve(resolved); },
          () => { clearTimeout(timer); reject(new Error("DNS validation failed")); },
        );
        timer.unref?.();
      });
    } catch {
      throw new UrlValidationError("DNS_LOOKUP_FAILED", "The destination hostname could not be resolved safely.");
    }
    if (addresses.length === 0) throw new UrlValidationError("DNS_LOOKUP_FAILED", "The destination hostname returned no addresses.");
  }

  for (const resolved of addresses) {
    if (isLoopbackAddress(resolved.address)) {
      throw new UrlValidationError("UNSAFE_ADDRESS", "Loopback addresses are not allowed.");
    }
    if (options.production && isNonPublicAddress(resolved.address)) {
      throw new UrlValidationError("UNSAFE_ADDRESS", "The destination resolves to a private or non-public address.");
    }
  }

  return { url, addresses };
}
