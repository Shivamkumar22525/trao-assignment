import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmConfig } from "../config.js";
import { CompanyBriefDraftSchema, QuestionDraftSchema, RequirementDraftSchema } from "../../pipeline/schemas.js";
import { GenerationError, type LlmProvider, type LlmRequest } from "../types.js";

type GenerateContentMethod = GoogleGenAI["models"]["generateContent"];

/** Narrow client boundary permits SDK mocks in tests without constructing network clients. */
export interface GeminiClientLike {
  models: { generateContent: GenerateContentMethod };
}

type GeminiResponseLike = Pick<GenerateContentResponse, "text" | "candidates" | "promptFeedback">;

const STAGE_SCHEMAS = {
  requirement_extraction: RequirementDraftSchema,
  company_brief: CompanyBriefDraftSchema,
  question_generation: QuestionDraftSchema,
  coverage_gap_generation: QuestionDraftSchema,
} as const;

function responseJsonSchema(stage: LlmRequest["stage"]): object {
  const generated = zodToJsonSchema(STAGE_SCHEMAS[stage], { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  const { $schema: _schemaMarker, definitions: _definitions, ...schema } = generated;
  return schema;
}

function apiFailure(error: unknown, stage: LlmRequest["stage"], signal: AbortSignal): GenerationError {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new GenerationError("LLM_TIMEOUT", stage, "The Gemini request timed out.");
  }

  const status = error instanceof ApiError
    ? error.status
    : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  // Inspect provider wording only for classification; never retain or log raw messages or request URLs.
  const providerText = error instanceof Error ? error.message.toLowerCase() : "";
  if (status === 429 || /resource_exhausted|quota exceeded|rate limit/.test(providerText)) {
    return new GenerationError("LLM_RATE_LIMIT", stage, "Gemini rate or quota limits were reached. Check the API project's current limits and usage.", status ? `Gemini API HTTP ${status}` : "Gemini rate/quota response.");
  }
  if (/token.{0,24}(limit|maximum|exceed)|context length|too many tokens|input token count/.test(providerText)) {
    return new GenerationError("LLM_TOKEN_LIMIT", stage, "The Gemini request exceeded a model token limit. Reduce the supplied context or output size.", status ? `Gemini API HTTP ${status}; token limit.` : "Gemini token-limit response.");
  }
  if (status === 408 || status === 504) {
    return new GenerationError("LLM_TIMEOUT", stage, "The Gemini request timed out.", `Gemini API HTTP ${status}`);
  }
  return new GenerationError("LLM_API_ERROR", stage, "The Gemini API request failed.", status ? `Gemini API HTTP ${status}` : "Gemini API request failed without an HTTP status.");
}

function refusal(response: GeminiResponseLike): boolean {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason && !String(blockReason).endsWith("UNSPECIFIED")) return true;
  const reason = response.candidates?.[0]?.finishReason;
  return ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(String(reason));
}

export class GeminiProvider implements LlmProvider {
  constructor(private readonly client: GeminiClientLike, private readonly configuredModel: string) {}

  async generateStructured<T = unknown>(request: LlmRequest): Promise<T> {
    let response: GeminiResponseLike;
    try {
      response = await this.client.models.generateContent({
        model: request.model || this.configuredModel,
        contents: request.userInput,
        config: {
          systemInstruction: request.systemInstruction,
          responseMimeType: "application/json",
          responseJsonSchema: responseJsonSchema(request.stage),
          abortSignal: request.signal,
          temperature: 0.2,
        },
      });
    } catch (error) {
      throw apiFailure(error, request.stage, request.signal);
    }

    if (refusal(response)) {
      throw new GenerationError("LLM_REFUSAL", request.stage, "Gemini declined to generate a response for this request.");
    }
    if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      throw new GenerationError("LLM_TOKEN_LIMIT", request.stage, "Gemini reached the configured output-token limit. Reduce context or increase the provider's output budget.");
    }

    const text = response.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new GenerationError("LLM_EMPTY_RESPONSE", request.stage, "Gemini returned no structured response.");
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GenerationError("INVALID_JSON", request.stage, "Gemini returned malformed JSON for structured output.");
    }
  }
}

export function createGeminiProvider(config: LlmConfig): LlmProvider {
  if (!config.apiKey) {
    throw new GenerationError("LLM_NOT_CONFIGURED", "pipeline", "GEMINI_API_KEY must be configured before generation.");
  }
  return new GeminiProvider(new GoogleGenAI({ apiKey: config.apiKey }), config.model);
}
