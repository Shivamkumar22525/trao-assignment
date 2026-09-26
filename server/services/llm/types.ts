export type GenerationStage = "requirement_extraction" | "company_brief" | "question_generation" | "coverage_gap_generation";

export interface LlmRequest {
  stage: GenerationStage;
  systemInstruction: string;
  userInput: string;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Provider adapters return a candidate value; every pipeline stage validates it locally. */
export interface LlmProvider {
  generateStructured<T = unknown>(request: LlmRequest): Promise<T>;
}

export type GenerationErrorCode =
  | "LLM_NOT_CONFIGURED" | "LLM_PROVIDER_UNAVAILABLE" | "LLM_TIMEOUT" | "LLM_API_ERROR"
  | "LLM_EMPTY_RESPONSE" | "LLM_REFUSAL" | "LLM_RATE_LIMIT" | "LLM_TOKEN_LIMIT"
  | "INVALID_JSON" | "SCHEMA_VALIDATION_FAILED" | "REQUIREMENT_EXTRACTION_FAILED"
  | "QUESTION_GENERATION_FAILED" | "COVERAGE_FAILURE" | "FINAL_VALIDATION_FAILED" | "GENERATION_CANCELLED";

export class GenerationError extends Error {
  constructor(
    public readonly code: GenerationErrorCode,
    public readonly stage: GenerationStage | "pipeline" | "validation",
    message: string,
    public readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface GenerationResult<TKit = unknown> {
  status: "ok" | "partial" | "failed";
  kit: TKit | null;
  warnings: string[];
  uncovered_requirement_ids: string[];
  error?: { code: GenerationErrorCode; stage: GenerationError["stage"]; message: string };
}
