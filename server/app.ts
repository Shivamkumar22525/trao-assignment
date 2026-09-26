import { resolve } from "node:path";
import dotenv from "dotenv";
import express from "express";
import { connectDatabase } from "./db/connect.js";
import { apiErrorHandler, notFoundHandler } from "./http/errors.js";
import { authRouter } from "./routes/auth.js";
import { kitsRouter } from "./routes/kits.js";
import { getAbuseControlConfig } from "./middleware/abuseControls.js";

// The API is server-only; support either repo-root .env or server/.env in local development.
dotenv.config({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "server/.env"), resolve(process.cwd(), "../.env")] });
// Validate rate/capacity settings after dotenv is loaded and before serving requests.
getAbuseControlConfig();

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  const allowedOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";
  if (origin && origin === allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") { response.status(204).end(); return; }
  } else if (request.method === "OPTIONS") {
    response.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "This browser origin is not allowed." } });
    return;
  }
  next();
});
app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use("/api/auth", authRouter);
app.use("/api/kits", kitsRouter);
app.use(notFoundHandler);
app.use(apiErrorHandler);

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4000);
  void connectDatabase().then(() => {
    app.listen(port, () => console.info(`API listening on port ${port}`));
  }).catch(() => {
    console.error("API startup failed because the database connection could not be established.");
    process.exitCode = 1;
  });
}
