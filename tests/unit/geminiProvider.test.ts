import { describe, expect, it, vi } from "vitest";
import { getLlmConfig, createLlmProvider } from "../../server/services/llm/config.js";
import { GeminiProvider, type GeminiClientLike } from "../../server/services/llm/providers/gemini.js";
import { GenerationError, type LlmRequest } from "../../server/services/llm/types.js";
import { generateValidated } from "../../server/services/pipeline/llmCall.js";
import { RequirementDraftSchema } from "../../server/services/pipeline/schemas.js";

const request: LlmRequest = {
  stage: "requirement_extraction",
  systemInstruction: "Application instructions stay separate from source data.",
  userInput: JSON.stringify({ job_description: "TypeScript development" }),
  model: "gemini-test-model",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

function providerFor(response?: unknown, failure?: unknown): { provider: GeminiProvider; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async () => {
    if (failure) throw failure;
    return response as never;
  });
  const client = { models: { generateContent: call } } as unknown as GeminiClientLike;
  return { provider: new GeminiProvider(client, "configured-gemini-model"), call };
}

describe("Gemini structured-output provider", () => {
  it("sends server model, separate system instruction, JSON MIME type, abort signal and stage schema", async () => {
    const output = { requirements: [{ text: "TypeScript development", kind: "technical", priority: "must" }] };
    const { provider, call } = providerFor({ text: JSON.stringify(output), candidates: [{ finishReason: "STOP" }] });
    await expect(provider.generateStructured(request)).resolves.toEqual(output);
    const params = call.mock.calls[0][0];
    expect(params).toMatchObject({ model: "gemini-test-model", contents: request.userInput, config: {
      systemInstruction: request.systemInstruction,
      responseMimeType: "application/json",
      abortSignal: request.signal,
    } });
    expect(params.config.responseJsonSchema).toMatchObject({ type: "object", properties: { requirements: { type: "array" } } });
  });

  it("uses the configured fallback model only when a request omits its model", async () => {
    const { provider, call } = providerFor({ text: "{}" });
    await provider.generateStructured({ ...request, model: "" });
    expect(call.mock.calls[0][0].model).toBe("configured-gemini-model");
  });

  it("returns a sanitized empty-response error", async () => {
    const { provider } = providerFor({ text: "  ", candidates: [{ finishReason: "STOP" }] });
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "LLM_EMPTY_RESPONSE" });
  });

  it("rejects malformed JSON without returning raw model text", async () => {
    const { provider } = providerFor({ text: "{broken secret-looking output", candidates: [{ finishReason: "STOP" }] });
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "INVALID_JSON", message: "Gemini returned malformed JSON for structured output." });
  });

  it("maps safety refusals to a structured refusal error", async () => {
    const { provider } = providerFor({ text: undefined, candidates: [{ finishReason: "SAFETY" }] });
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "LLM_REFUSAL" });
  });

  it("maps rate-limit responses without surfacing provider response text", async () => {
    const { provider } = providerFor(undefined, Object.assign(new Error("quota key=DO_NOT_LEAK"), { status: 429 }));
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "LLM_RATE_LIMIT", message: expect.not.stringContaining("DO_NOT_LEAK"), diagnostic: "Gemini API HTTP 429" });
  });

  it("maps output token exhaustion", async () => {
    const { provider } = providerFor({ text: "", candidates: [{ finishReason: "MAX_TOKENS" }] });
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "LLM_TOKEN_LIMIT" });
  });

  it("maps Gemini request timeouts", async () => {
    const { provider } = providerFor(undefined, Object.assign(new Error("request aborted"), { name: "AbortError" }));
    await expect(provider.generateStructured(request)).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("aborts an in-flight LLM stage when the parent case deadline fires", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const pending = generateValidated({ generateStructured: (stageRequest) => {
      receivedSignal = stageRequest.signal;
      return new Promise(() => {});
    } }, request.stage, request.systemInstruction, request.userInput, RequirementDraftSchema, 10_000, request.model, controller.signal);
    controller.abort(new Error("case deadline"));
    await expect(pending).rejects.toThrow("case deadline");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("enforces the stage timeout and aborts the provider retry sequence", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const pending = generateValidated({ generateStructured: (stageRequest) => {
        receivedSignal = stageRequest.signal;
        return new Promise(() => {});
      } }, request.stage, request.systemInstruction, request.userInput, RequirementDraftSchema, 20_000, request.model);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
      expect(receivedSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("preserves local Zod validation after provider JSON parsing", async () => {
    const { provider } = providerFor({ text: JSON.stringify({ requirements: [{ text: "", kind: "invalid", priority: "must" }] }) });
    await expect(generateValidated(provider, request.stage, request.systemInstruction, request.userInput, RequirementDraftSchema, 1000, request.model)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("reads only Gemini server environment variables and defaults to the supported model", () => {
    expect(getLlmConfig({ GEMINI_API_KEY: "test-placeholder", GEMINI_MODEL: "custom-model" })).toMatchObject({ provider: "gemini", apiKey: "test-placeholder", model: "custom-model" });
    expect(getLlmConfig({ GEMINI_API_KEY: "test-placeholder" }).model).toBe("gemini-3.8-flash");
  });

  it("fails configuration when the Gemini key is missing", () => {
    expect(() => createLlmProvider(getLlmConfig({ GEMINI_MODEL: "gemini-3.8-flash", LLM_PROVIDER: "gemini" }))).toThrowError(expect.objectContaining({ code: "LLM_NOT_CONFIGURED" }));
  });
});
