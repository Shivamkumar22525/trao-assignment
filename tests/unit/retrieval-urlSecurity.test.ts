import { describe, expect, it } from "vitest";
import { isNonPublicAddress, UrlValidationError, validateUrl } from "../../server/services/retrieval/urlSecurity.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("validateUrl", () => {
  it("accepts HTTP(S) public hosts and returns the resolved address for pinning", async () => {
    const validated = await validateUrl("https://example.com/path", { resolveHostname: publicResolver });
    expect(validated.url.href).toBe("https://example.com/path");
    expect(validated.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects localhost and obvious internal hostnames", async () => {
    await expect(validateUrl("http://localhost/", { resolveHostname: publicResolver }))
      .rejects.toMatchObject({ code: "UNSAFE_HOSTNAME" });
    await expect(validateUrl("http://metadata.google.internal/", { resolveHostname: publicResolver }))
      .rejects.toMatchObject({ code: "UNSAFE_HOSTNAME" });
  });

  it("rejects loopback IPv4, IPv6, and IPv4-mapped IPv6 addresses", async () => {
    for (const url of ["http://127.0.0.1/", "http://127.20.0.2/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      await expect(validateUrl(url, { resolveHostname: publicResolver }))
        .rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
    }
  });

  it("rejects private addresses in production, including DNS answers", async () => {
    for (const address of ["10.1.2.3", "172.20.0.1", "192.168.1.4", "169.254.1.1", "fc00::1", "fe80::1"]) {
      expect(isNonPublicAddress(address)).toBe(true);
    }
    await expect(validateUrl("http://10.0.0.2/", { production: true }))
      .rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
    await expect(validateUrl("https://company.example/", {
      production: true,
      resolveHostname: async () => [{ address: "192.168.2.10", family: 4 }],
    })).rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
  });

  it("rejects unsupported protocols, malformed URLs, and embedded credentials", async () => {
    await expect(validateUrl("ftp://example.com", { resolveHostname: publicResolver }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    await expect(validateUrl("not a URL", { resolveHostname: publicResolver }))
      .rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(validateUrl("https://user:pass@example.com", { resolveHostname: publicResolver }))
      .rejects.toMatchObject({ code: "CREDENTIALS_NOT_ALLOWED" });
  });

  it("rejects hostnames resolving to loopback even outside production", async () => {
    await expect(validateUrl("https://public-looking.example/", {
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
    })).rejects.toBeInstanceOf(UrlValidationError);
  });
});
