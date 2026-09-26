import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export const asyncRoute = (handler: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  (request, response, next) => { void handler(request, response).catch(next); };

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "The requested endpoint was not found." } });
};

export const apiErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request input is invalid." } });
    return;
  }
  if (error && typeof error === "object" && "status" in error && (error.status === 400 || error.status === 413)) {
    const tooLarge = error.status === 413;
    response.status(error.status).json({ error: { code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON", message: tooLarge ? "The request body is too large." : "Request body must contain valid JSON." } });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === 11000) {
    response.status(409).json({ error: { code: "CONFLICT", message: "An account with that email already exists." } });
    return;
  }
  // Do not log error details: upstream/database errors can contain URLs or credentials.
  console.error("Unhandled API error.");
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred." } });
};
