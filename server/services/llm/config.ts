import { GenerationError } from "./types.js";

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
    provider: env.LLM_PROVIDER?.trim() ?? "",
    model: env.LLM_MODEL?.trim() ?? "",
    apiKey: env.LLM_API_KEY?.trim() ?? "",
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
    throw new GenerationError("LLM_NOT_CONFIGURED", "pipeline", "LLM_PROVIDER, LLM_MODEL, and LLM_API_KEY must be configured before generation.");
  }
  const factory = factories[config.provider];
  if (!factory) {
    throw new GenerationError("LLM_PROVIDER_UNAVAILABLE", "pipeline", `No adapter is registered for LLM provider '${config.provider}'.`);
  }
  return factory(config);
}
