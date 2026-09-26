import { getLlmConfig } from "../llm/config.js";
import { GenerationError, type GenerationStage, type LlmProvider, type LlmRequest } from "../llm/types.js";
import type { ZodType } from "zod";
import { abortReason } from "../../utils/abort.js";

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
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    const reason = abortReason(signal);
    controller.abort(reason);
    rejectAbort(reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const request: LlmRequest = { stage, systemInstruction, userInput, model, timeoutMs, signal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new GenerationError("LLM_TIMEOUT", stage, "The model request timed out."));
        reject(new GenerationError("LLM_TIMEOUT", stage, "The model request timed out."));
      }, timeoutMs);
    });
    if (controller.signal.aborted) throw abortReason(signal);
    const candidate = await Promise.race([provider.generateStructured<unknown>(request), timeout, abortPromise]);
    const parsed = parseJsonIfText(candidate, stage);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new GenerationError("SCHEMA_VALIDATION_FAILED", stage, "The model response did not match the required structured output.", result.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join("; "));
    }
    return result.data;
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("LLM_API_ERROR", stage, "The configured model provider could not complete the request.", error instanceof Error ? error.message : "Unknown provider error.");
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
