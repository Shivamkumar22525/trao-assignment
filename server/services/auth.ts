import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SessionModel } from "../models/Session.js";
import { UserModel } from "../models/User.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export function hashSessionToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
// SHA-256 prehash keeps bcrypt's input below its 72-byte truncation boundary.
function passwordDigest(password: string): string { return createHash("sha256").update(password, "utf8").digest("hex"); }
export async function hashPassword(password: string): Promise<string> { return bcrypt.hash(passwordDigest(password), 12); }
export async function verifyPassword(password: string, hash: string): Promise<boolean> { return bcrypt.compare(passwordDigest(password), hash); }

export async function createSession(userId: unknown): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await SessionModel.create({ userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt };
}

export async function revokeSession(token: string): Promise<void> {
  await SessionModel.deleteOne({ tokenHash: hashSessionToken(token) });
}

export async function registerUser(email: string, password: string) {
  const passwordHash = await hashPassword(password);
  return UserModel.create({ email: email.trim().toLowerCase(), passwordHash });
}

export async function authenticateUser(email: string, password: string) {
  const user = await UserModel.findOne({ email: email.trim().toLowerCase() }).select("+passwordHash");
  if (!user || !await verifyPassword(password, user.passwordHash)) return null;
  return user;
}
