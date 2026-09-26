import { Router } from "express";
import { z } from "zod";
import { UserModel } from "../models/User.js";
import { asyncRoute, HttpError } from "../http/errors.js";
import { requireAuth, readCookie, SESSION_COOKIE, type AuthenticatedRequest } from "../middleware/auth.js";
import { loginRateLimit, registrationRateLimit } from "../middleware/abuseControls.js";
import { authenticateUser, createSession, registerUser, revokeSession } from "../services/auth.js";

const CredentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
}).strict();
const cookieOptions = () => `Path=/api; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const clearCookieOptions = () => `Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const userResponse = (user: { _id: unknown; email: string }) => ({ id: String(user._id), email: user.email });

export const authRouter = Router();
authRouter.post("/register", registrationRateLimit, asyncRoute(async (request, response) => {
  const input = CredentialsSchema.parse(request.body);
  const user = await registerUser(input.email, input.password);
  const session = await createSession(user._id);
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; ${cookieOptions()}`);
  response.status(201).json({ user: userResponse(user) });
}));

authRouter.post("/login", loginRateLimit, asyncRoute(async (request, response) => {
  const input = CredentialsSchema.parse(request.body);
  const user = await authenticateUser(input.email, input.password);
  if (!user) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  const session = await createSession(user._id);
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; ${cookieOptions()}`);
  response.json({ user: userResponse(user) });
}));

authRouter.post("/logout", asyncRoute(async (request, response) => {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token) await revokeSession(token);
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${clearCookieOptions()}`);
  response.status(204).end();
}));

authRouter.get("/me", requireAuth, asyncRoute(async (request, response) => {
  const user = await UserModel.findById((request as AuthenticatedRequest).userId).select("email").lean() as { _id: unknown; email: string } | null;
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  response.json({ user: userResponse(user) });
}));
