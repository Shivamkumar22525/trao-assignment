import { getLlmConfig } from "../llm/config.js";
import { GenerationError, type GenerationStage, type LlmProvider, type LlmRequest } from "../llm/types.js";
import type { ZodType } from "zod";

function parseJsonIfText(value: unknown, stage: GenerationStage): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch (error) {
    throw new GenerationError("INVALID_JSON", stage, "The model returned invalid JSON.", error instanceof Error ? error.message : "JSON parse failed.");
  }
}

export async function generateValidated<T>(
  provider: LlmProvider,
  stage: GenerationStage,
  systemInstruction: string,
  userInput: string,
  schema: ZodType<T>,
  timeoutMs = getLlmConfig().timeoutMs,
  model = getLlmConfig().model,
): Promise<T> {
  const controller = new AbortController();
  const request: LlmRequest = { stage, systemInstruction, userInput, model, timeoutMs, signal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GenerationError("LLM_TIMEOUT", stage, "The model request timed out."));
      }, timeoutMs);
    });
    const candidate = await Promise.race([provider.generateStructured<unknown>(request), timeout]);
    const parsed = parseJsonIfText(candidate, stage);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new GenerationError("SCHEMA_VALIDATION_FAILED", stage, "The model response did not match the required structured output.", result.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join("; "));
    }
    return result.data;
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("LLM_API_ERROR", stage, "The configured model provider could not complete the request.", error instanceof Error ? error.message : "Unknown provider error.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
