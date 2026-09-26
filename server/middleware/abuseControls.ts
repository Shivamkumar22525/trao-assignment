import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";

const RATE_LIMIT_BODY = Object.freeze({
  error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
});
const GENERATION_LIMIT_BODY = Object.freeze({
  error: { code: "GENERATION_LIMITED", message: "Generation capacity is currently limited. Please try again later." },
});

export interface AbuseControlConfig {
  authLoginWindowMs: number;
  authLoginMaxAttempts: number;
  authRegisterWindowMs: number;
  authRegisterMaxAttempts: number;
  generationWindowMs: number;
  generationMaxRequests: number;
  generationMaxConcurrentPerUser: number;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Reads bounded single-process abuse-control settings; invalid values fail startup clearly. */
export function getAbuseControlConfig(env: NodeJS.ProcessEnv = process.env): AbuseControlConfig {
  return {
    authLoginWindowMs: boundedInteger(env, "AUTH_LOGIN_RATE_WINDOW_MS", 15 * 60_000, 1_000, 24 * 60 * 60_000),
    authLoginMaxAttempts: boundedInteger(env, "AUTH_LOGIN_RATE_MAX", 10, 1, 10_000),
    authRegisterWindowMs: boundedInteger(env, "AUTH_REGISTER_RATE_WINDOW_MS", 60 * 60_000, 1_000, 24 * 60 * 60_000),
    authRegisterMaxAttempts: boundedInteger(env, "AUTH_REGISTER_RATE_MAX", 5, 1, 10_000),
    generationWindowMs: boundedInteger(env, "GENERATION_RATE_WINDOW_MS", 60 * 60_000, 1_000, 24 * 60 * 60_000),
    generationMaxRequests: boundedInteger(env, "GENERATION_RATE_MAX", 5, 1, 10_000),
    generationMaxConcurrentPerUser: boundedInteger(env, "GENERATION_MAX_CONCURRENT_PER_USER", 1, 1, 100),
  };
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  key: (request: Request) => string;
  now?: () => number;
  maxKeys?: number;
  body?: typeof RATE_LIMIT_BODY | typeof GENERATION_LIMIT_BODY;
}

interface WindowRecord { startedAt: number; count: number; }

/** Fixed-window counter with bounded memory and explicit reset for deterministic tests. */
export function createFixedWindowRateLimit(options: RateLimitOptions): RequestHandler & { reset: () => void } {
  const records = new Map<string, WindowRecord>();
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const body = options.body ?? RATE_LIMIT_BODY;

  const middleware = ((request: Request, response: Response, next: NextFunction) => {
    const currentTime = now();
    for (const [key, record] of records) {
      if (currentTime - record.startedAt >= options.windowMs) records.delete(key);
    }

    const key = options.key(request) || "unknown";
    let record = records.get(key);
    if (!record || currentTime - record.startedAt >= options.windowMs) {
      if (records.size >= maxKeys) {
        const oldestKey = records.keys().next().value as string | undefined;
        if (oldestKey !== undefined) records.delete(oldestKey);
      }
      record = { startedAt: currentTime, count: 0 };
      records.set(key, record);
    }

    if (record.count >= options.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((options.windowMs - (currentTime - record.startedAt)) / 1_000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json(body);
      return;
    }
    record.count += 1;
    next();
  }) as RequestHandler & { reset: () => void };
  middleware.reset = () => records.clear();
  return middleware;
}

export interface GenerationConcurrencyLimiter {
  acquire(userId: string): (() => void) | undefined;
  reset(): void;
  activeFor(userId: string): number;
}

/** Synchronous reservation makes acquire atomic within this Node.js process. */
export function createGenerationConcurrencyLimiter(maxConcurrentPerUser: number): GenerationConcurrencyLimiter {
  const active = new Map<string, number>();
  return {
    acquire(userId: string): (() => void) | undefined {
      const count = active.get(userId) ?? 0;
      if (count >= maxConcurrentPerUser) return undefined;
      active.set(userId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (active.get(userId) ?? 1) - 1;
        if (remaining <= 0) active.delete(userId);
        else active.set(userId, remaining);
      };
    },
    reset: () => active.clear(),
    activeFor: (userId) => active.get(userId) ?? 0,
  };
}

// Deliberately use the socket peer address. X-Forwarded-For is ignored because
// this repository does not configure or trust a reverse proxy.
const peerAddress = (request: Request) => request.socket.remoteAddress ?? "unknown";
const authenticatedUserKey = (request: Request) => (request as AuthenticatedRequest).userId ?? "unauthenticated";

interface ControlSet {
  login: ReturnType<typeof createFixedWindowRateLimit>;
  registration: ReturnType<typeof createFixedWindowRateLimit>;
  generation: ReturnType<typeof createFixedWindowRateLimit>;
  concurrency: GenerationConcurrencyLimiter;
}

let controlSet: ControlSet | undefined;
function getControlSet(): ControlSet {
  if (controlSet) return controlSet;
  const config = getAbuseControlConfig();
  controlSet = {
    login: createFixedWindowRateLimit({ windowMs: config.authLoginWindowMs, maxRequests: config.authLoginMaxAttempts, key: peerAddress }),
    registration: createFixedWindowRateLimit({ windowMs: config.authRegisterWindowMs, maxRequests: config.authRegisterMaxAttempts, key: peerAddress }),
    generation: createFixedWindowRateLimit({ windowMs: config.generationWindowMs, maxRequests: config.generationMaxRequests, key: authenticatedUserKey, body: GENERATION_LIMIT_BODY }),
    concurrency: createGenerationConcurrencyLimiter(config.generationMaxConcurrentPerUser),
  };
  return controlSet;
}

export const loginRateLimit: RequestHandler = (request, response, next) => getControlSet().login(request, response, next);
export const registrationRateLimit: RequestHandler = (request, response, next) => getControlSet().registration(request, response, next);
export const generationRateLimit: RequestHandler = (request, response, next) => getControlSet().generation(request, response, next);
export const generationConcurrency: GenerationConcurrencyLimiter = {
  acquire: (userId) => getControlSet().concurrency.acquire(userId),
  reset: () => controlSet?.concurrency.reset(),
  activeFor: (userId) => controlSet?.concurrency.activeFor(userId) ?? 0,
};

/** Resettable hooks are used by isolated route tests; production state remains process-local. */
export function resetAbuseControlsForTests(): void {
  controlSet?.login.reset();
  controlSet?.registration.reset();
  controlSet?.generation.reset();
  controlSet?.concurrency.reset();
}

