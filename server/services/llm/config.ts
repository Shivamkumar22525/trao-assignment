import { GenerationError } from "./types.js";
import { createGeminiProvider } from "./providers/gemini.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  researchContextMaxBytes: number;
  researchContextMaxSources: number;
}

export function getLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    provider: env.LLM_PROVIDER?.trim() || "gemini",
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    apiKey: env.GEMINI_API_KEY?.trim() ?? "",
    timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 45_000,
    researchContextMaxBytes: positiveInteger(env.LLM_RESEARCH_CONTEXT_MAX_BYTES, 65_536),
    researchContextMaxSources: positiveInteger(env.LLM_RESEARCH_CONTEXT_MAX_SOURCES, 12),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type LlmProviderFactory = (config: LlmConfig) => import("./types.js").LlmProvider;

/** Real vendor adapters are registered explicitly; configuration alone never implies a working integration. */
export function createLlmProvider(
  config: LlmConfig = getLlmConfig(),
  factories: Readonly<Record<string, LlmProviderFactory>> = {},
): import("./types.js").LlmProvider {
  if (!config.provider || !config.model || !config.apiKey) {
    throw new GenerationError("LLM_NOT_CONFIGURED", "pipeline", "Set LLM_PROVIDER=gemini and configure GEMINI_API_KEY; GEMINI_MODEL defaults to a supported Flash model.");
  }
  const factory = { gemini: createGeminiProvider, ...factories }[config.provider];
  if (!factory) {
    throw new GenerationError("LLM_PROVIDER_UNAVAILABLE", "pipeline", `No adapter is registered for LLM provider '${config.provider}'.`);
  }
  return factory(config);
}
