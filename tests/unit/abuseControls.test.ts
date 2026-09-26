import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createFixedWindowRateLimit, createGenerationConcurrencyLimiter, getAbuseControlConfig } from "../../server/middleware/abuseControls.js";

function responseDouble() {
  const response = {
    statusCode: 200,
    headers: new Map<string, string>(),
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers.set(name, value); return this; },
    status(value: number) { this.statusCode = value; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  return response as unknown as Response & typeof response;
}

describe("in-memory API abuse controls", () => {
  it("uses validated configurable defaults and rejects out-of-range values", () => {
    expect(getAbuseControlConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      authLoginWindowMs: 900_000, authLoginMaxAttempts: 10,
      authRegisterWindowMs: 3_600_000, authRegisterMaxAttempts: 5,
      generationWindowMs: 3_600_000, generationMaxRequests: 5,
      generationMaxConcurrentPerUser: 1,
    });
    expect(() => getAbuseControlConfig({ GENERATION_RATE_MAX: "0" } as NodeJS.ProcessEnv)).toThrow("GENERATION_RATE_MAX");
    expect(() => getAbuseControlConfig({ AUTH_LOGIN_RATE_MAX: "not-a-number" } as NodeJS.ProcessEnv)).toThrow("AUTH_LOGIN_RATE_MAX");
  });

  it("returns a stable sanitized 429 and resets at the fixed-window boundary", () => {
    let now = 1_000;
    const next = vi.fn();
    const middleware = createFixedWindowRateLimit({ windowMs: 10_000, maxRequests: 1, key: (request) => request.socket.remoteAddress ?? "unknown", now: () => now });
    const request = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "attacker-controlled" } } as unknown as Request;
    const firstResponse = responseDouble();
    middleware(request, firstResponse, next);
    expect(next).toHaveBeenCalledOnce();

    const limitedResponse = responseDouble();
    middleware(request, limitedResponse, next);
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers.get("Retry-After")).toBe("10");
    expect(limitedResponse.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } });
    expect(JSON.stringify(limitedResponse.body)).not.toContain("attacker-controlled");

    now += 10_000;
    middleware(request, responseDouble(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("releases one-user concurrency reservations safely after success or failure", () => {
    const limiter = createGenerationConcurrencyLimiter(1);
    const release = limiter.acquire("user-a");
    expect(release).toBeTypeOf("function");
    expect(limiter.acquire("user-a")).toBeUndefined();
    expect(limiter.acquire("user-b")).toBeTypeOf("function");
    expect(limiter.activeFor("user-a")).toBe(1);

    // Route handlers use finally, so both a successful and a throwing operation
    // invoke this idempotent release function.
    try { release!(); } finally { release!(); }
    expect(limiter.activeFor("user-a")).toBe(0);
    expect(limiter.acquire("user-a")).toBeTypeOf("function");
  });
});
