import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SessionModel } from "../models/Session.js";
import { UserModel } from "../models/User.js";
import { HttpError } from "../http/errors.js";

export interface AuthenticatedRequest extends Request { userId?: string; }
export const SESSION_COOKIE = "trao_session";

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return undefined; }
    }
  }
  return undefined;
}

export const requireAuth = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
  try {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token || token.length > 256) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in to continue.");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await SessionModel.findOne({ tokenHash, expiresAt: { $gt: new Date() } }).select("userId").lean() as { userId: unknown } | null;
    if (!session) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in to continue.");
    const user = await UserModel.findById(session.userId).select("_id").lean() as { _id: unknown } | null;
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in to continue.");
    (request as AuthenticatedRequest).userId = String(user._id);
    next();
  } catch (error) { next(error); }
};
