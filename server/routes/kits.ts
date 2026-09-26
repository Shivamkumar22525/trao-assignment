import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { GenerationJobModel } from "../models/GenerationJob.js";
import { KitModel } from "../models/Kit.js";
import { PracticeProgressModel } from "../models/PracticeProgress.js";
import { CompleteKitSchema } from "../services/validation/kit.schema.js";
import { generateKit } from "../services/pipeline/generateKit.js";
import { checkCoverage } from "../services/coverage/checkCoverage.js";
import { buildSchedule } from "../services/scheduler/buildSchedule.js";
import { HttpError, asyncRoute } from "../http/errors.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const GenerateInputSchema = z.object({
  jd: z.string().trim().min(1).max(30_000),
  company_url: z.string().trim().url().max(2048).refine((value) => {
    try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
    catch { return false; }
  }, "Company URL must be an HTTP or HTTPS URL without credentials."),
  days: z.number().int().min(1).max(30),
  company_name: z.string().trim().max(200).optional(),
  role: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
}).strict();
const EditSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  edits: z.array(z.object({
    path: z.string().min(2).max(300),
    value: z.unknown(),
    state: z.enum(["edited", "pinned"]).default("edited"),
  }).strict().superRefine((edit, context) => {
    if (!Object.prototype.hasOwnProperty.call(edit, "value")) context.addIssue({ code: "custom", path: ["value"], message: "An edit value is required." });
  })).max(100),
}).strict();
const RegenerateSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("company_brief"), revision: z.number().int().nonnegative().optional() }).strict(),
  z.object({ section: z.literal("question_category"), category: z.enum(["technical", "behavioural", "system-design", "company-fit"]), revision: z.number().int().nonnegative().optional() }).strict(),
]);
const PracticeMarkSchema = z.object({ covered: z.boolean() }).strict();
const MAX_EDITOR_BYTES = 64 * 1024;
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function safeKitId(value: string): string {
  if (!isValidObjectId(value)) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  return value;
}

function pointerParts(path: string): string[] {
  if (!path.startsWith("/") || path === "/") throw new HttpError(400, "VALIDATION_ERROR", "Each edit must target a field within the kit.");
  const parts = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((part) => !part || FORBIDDEN_PATH_PARTS.has(part))) throw new HttpError(400, "VALIDATION_ERROR", "An edit path is invalid.");
  return parts;
}

function setAtPath(root: unknown, path: string, value: unknown): void {
  const parts = pointerParts(path);
  if (!parts.length) throw new HttpError(400, "VALIDATION_ERROR", "An edit path is invalid.");
  let current = root as Record<string, unknown> | unknown[];
  for (const part of parts.slice(0, -1)) {
    const next = (current as Record<string, unknown>)[part];
    if (!next || typeof next !== "object") throw new HttpError(400, "VALIDATION_ERROR", "An edit path does not identify an existing kit field.");
    current = next as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(current)) {
    if (!/^\d+$/.test(last) || Number(last) >= current.length) throw new HttpError(400, "VALIDATION_ERROR", "An edit path does not identify an existing kit field.");
    current[Number(last)] = value;
  } else {
    if (!(last in current)) throw new HttpError(400, "VALIDATION_ERROR", "An edit path does not identify an existing kit field.");
    current[last] = value;
  }
}

interface KitRecord {
  _id: unknown; originalInput: unknown; kit: unknown; editorState: unknown; revision: number; createdAt?: Date; updatedAt?: Date;
}
function serializeKit(document: KitRecord) {
  const generatedKit = document.kit as Record<string, unknown>;
  const editorState = document.editorState as { edits?: { path: string; value: unknown; state: "edited" | "pinned" }[] } | undefined;
  const effectiveKit = JSON.parse(JSON.stringify(generatedKit)) as Record<string, unknown>;
  for (const edit of editorState?.edits ?? []) setAtPath(effectiveKit, edit.path, edit.value);
  return {
    id: String(document._id), original_input: document.originalInput,
    generated_kit: generatedKit, editor_state: editorState ?? { edits: [] }, effective_kit: effectiveKit,
    revision: document.revision, created_at: document.createdAt, updated_at: document.updatedAt,
  };
}

export const kitsRouter = Router();
kitsRouter.use(requireAuth);

kitsRouter.post("/", asyncRoute(async (request, response) => {
  const input = GenerateInputSchema.parse(request.body);
  const userId = (request as AuthenticatedRequest).userId!;
  const job = await GenerationJobModel.create({ userId, status: "running", currentStage: "generation", progress: 10, errors: [] });
  try {
    const result = await generateKit(input);
    if (result.status === "failed" || !result.kit) {
      const error = result.error ?? { code: "GENERATION_FAILED", stage: "pipeline", message: "Kit generation failed." };
      await GenerationJobModel.updateOne({ _id: job._id, userId }, {
        $set: { status: "failed", currentStage: error.stage, progress: 100, errors: [{ code: error.code, stage: error.stage, message: error.message }] },
      });
      response.status(502).json({ error: { code: "GENERATION_FAILED", message: error.message }, job: { id: String(job._id), status: "failed" } });
      return;
    }
    const kit = await KitModel.create({ ownerId: userId, originalInput: input, kit: result.kit, editorState: { edits: [] }, revision: 0 });
    await GenerationJobModel.updateOne({ _id: job._id, userId }, {
      $set: { kitId: kit._id, status: "succeeded", currentStage: "complete", progress: 100, errors: [] },
    });
    response.status(201).json({ job: { id: String(job._id), status: "succeeded" }, kit: serializeKit(kit) });
  } catch (error) {
    await GenerationJobModel.updateOne({ _id: job._id, userId }, {
      $set: { status: "failed", currentStage: "persistence", progress: 100, errors: [{ code: "GENERATION_FAILED", message: "Kit generation or persistence failed." }] },
    }).catch(() => undefined);
    throw error;
  }
}));

kitsRouter.get("/", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const page = z.coerce.number().int().min(1).max(10_000).catch(1).parse(request.query.page);
  const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(request.query.limit);
  const [documents, total] = await Promise.all([
    KitModel.find({ ownerId: userId }).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean() as unknown as Promise<KitRecord[]>,
    KitModel.countDocuments({ ownerId: userId }),
  ]);
  response.json({ kits: documents.map((document) => serializeKit(document)), page, limit, total });
}));

kitsRouter.get("/:id", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const document = await KitModel.findOne({ _id: safeKitId(request.params.id), ownerId: userId }) as (KitRecord & { save: () => Promise<unknown> }) | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  response.json({ kit: serializeKit(document) });
}));

// Practice progress is keyed by the authenticated user, owned kit, and a flashcard
// ID that must still exist in the kit's effective (editable) flashcard collection.
kitsRouter.get("/:id/practice-progress", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const document = await KitModel.findOne({ _id: safeKitId(request.params.id), ownerId: userId }) as KitRecord | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  const flashcardIds = new Set((((serializeKit(document).effective_kit as { flashcards?: { id: string }[] }).flashcards) ?? []).map(({ id }) => id));
  const records = await PracticeProgressModel.find({ userId, kitId: document._id, flashcardId: { $in: [...flashcardIds] } }).lean() as unknown as { flashcardId: string; covered: boolean; attempts: number; lastPracticedAt?: Date }[];
  response.json({ progress: records.map(({ flashcardId, covered, attempts, lastPracticedAt }) => ({ flashcard_id: flashcardId, covered, attempts, last_practiced_at: lastPracticedAt })) });
}));

kitsRouter.patch("/:id/practice-progress/:flashcardId", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const document = await KitModel.findOne({ _id: safeKitId(request.params.id), ownerId: userId }) as KitRecord | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  const body = PracticeMarkSchema.parse(request.body);
  const effectiveKit = serializeKit(document).effective_kit as { flashcards?: { id: string }[] };
  if (!(effectiveKit.flashcards ?? []).some(({ id }) => id === request.params.flashcardId)) throw new HttpError(400, "INVALID_FLASHCARD", "This flashcard is not part of the saved kit.");
  const lastPracticedAt = new Date();
  const saved = await PracticeProgressModel.findOneAndUpdate(
    { userId, kitId: document._id, flashcardId: request.params.flashcardId },
    { $set: { covered: body.covered, lastPracticedAt }, $inc: { attempts: 1 }, $setOnInsert: { userId, kitId: document._id, flashcardId: request.params.flashcardId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean() as unknown as { flashcardId: string; covered: boolean; attempts: number; lastPracticedAt?: Date };
  response.json({ progress: { flashcard_id: saved.flashcardId, covered: saved.covered, attempts: saved.attempts, last_practiced_at: saved.lastPracticedAt } });
}));

kitsRouter.patch("/:id", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const document = await KitModel.findOne({ _id: safeKitId(request.params.id), ownerId: userId }) as (KitRecord & { save: () => Promise<unknown> }) | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  const expectedRevision = document.revision;
  const body = EditSchema.parse(request.body);
  if (body.revision !== undefined && body.revision !== expectedRevision) throw new HttpError(409, "KIT_REVISION_CONFLICT", "This kit changed since you opened it. Reload it before saving.");
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_EDITOR_BYTES) throw new HttpError(413, "EDIT_TOO_LARGE", "The edit payload exceeds the allowed size.");
  const merged = new Map<string, { path: string; value: unknown; state: "edited" | "pinned" }>();
  const existing = document.editorState as { edits?: { path: string; value: unknown; state: "edited" | "pinned" }[] };
  for (const edit of existing?.edits ?? []) merged.set(edit.path, edit);
  // Replacing an ordered collection invalidates all index-addressed overlays below it.
  if (body.edits.some((edit) => edit.path === "/questions")) {
    for (const path of merged.keys()) if (path.startsWith("/questions/")) merged.delete(path);
  }
  for (const edit of body.edits) {
    pointerParts(edit.path);
    merged.set(edit.path, { ...edit, value: JSON.parse(JSON.stringify(edit.value)) });
  }
  const edits = [...merged.values()];
  const candidate = JSON.parse(JSON.stringify(document.kit)) as Record<string, unknown>;
  for (const edit of edits) setAtPath(candidate, edit.path, edit.value);
  if (body.edits.some((edit) => edit.path === "/questions" || edit.path.startsWith("/questions/"))) {
    try {
      const role = candidate.role as { requirements: import("../types/kit.js").Requirement[] };
      const questions = candidate.questions as import("../types/kit.js").Question[];
      const coverage = checkCoverage(role.requirements, questions);
      if (!coverage.passes) throw new HttpError(400, "INVALID_KIT_EDIT", "Keep at least one question for every must-have requirement before saving.");
      const existingCoverage = candidate.coverage as { passes?: number };
      candidate.coverage = { uncovered_requirement_ids: coverage.uncovered_requirement_ids, passes: existingCoverage.passes ?? 1 };
      candidate.schedule = buildSchedule(role.requirements, questions, (document.originalInput as { days: number }).days);
      merged.set("/coverage", { path: "/coverage", value: candidate.coverage, state: "edited" });
      merged.set("/schedule", { path: "/schedule", value: candidate.schedule, state: "edited" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "INVALID_KIT_EDIT", "Question edits must use valid requirement IDs and preserve must-have coverage.");
    }
  }
  const validation = CompleteKitSchema.safeParse(candidate);
  if (!validation.success) throw new HttpError(400, "INVALID_KIT_EDIT", "Edits must preserve the generated kit structure and valid references.");
  const update = await KitModel.updateOne(
    { _id: document._id, ownerId: userId, revision: expectedRevision },
    { $set: { editorState: { edits: [...merged.values()] } }, $inc: { revision: 1 } },
  );
  if (update.modifiedCount !== 1) throw new HttpError(409, "KIT_REVISION_CONFLICT", "This kit changed while you were saving. Reload it before saving again.");
  const saved = await KitModel.findOne({ _id: document._id, ownerId: userId }) as KitRecord | null;
  if (!saved) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  response.json({ kit: serializeKit(saved) });
}));

kitsRouter.post("/:id/regenerate", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const id = safeKitId(request.params.id);
  const body = RegenerateSchema.parse(request.body);
  const document = await KitModel.findOne({ _id: id, ownerId: userId }) as KitRecord | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  const expectedRevision = document.revision;
  if (body.revision !== undefined && body.revision !== expectedRevision) throw new HttpError(409, "KIT_REVISION_CONFLICT", "This kit changed since you opened it. Reload it before regenerating.");
  const input = document.originalInput as { jd: string; company_url: string; days: number; company_name?: string; role?: string; location?: string };
  const result = await generateKit(input);
  if (result.status === "failed" || !result.kit) throw new HttpError(502, "REGENERATION_FAILED", result.error?.message ?? "Section regeneration failed.");
  const base = CompleteKitSchema.parse(JSON.parse(JSON.stringify(document.kit))) as unknown as import("../types/kit.js").CompleteKit;
  const regenerated = CompleteKitSchema.parse(result.kit) as import("../types/kit.js").CompleteKit;
  const state = document.editorState as { edits?: { path: string; value: unknown; state: "edited" | "pinned" }[] } | undefined;
  const oldSerialized = serializeKit(document);
  const effective = oldSerialized.effective_kit as unknown as import("../types/kit.js").CompleteKit;
  const mergedEdits = new Map((state?.edits ?? []).map((edit) => [edit.path, edit]));
  let next = JSON.parse(JSON.stringify(base)) as import("../types/kit.js").CompleteKit;

  if (body.section === "company_brief") {
    next.company_brief = regenerated.company_brief;
    for (const [path, edit] of mergedEdits) {
      if (path === "/company_brief" || path.startsWith("/company_brief/")) mergedEdits.delete(path);
    }
    const oldBriefEdits = (state?.edits ?? []).filter((edit) => edit.state === "pinned" && (edit.path === "/company_brief" || edit.path.startsWith("/company_brief/")));
    for (const edit of oldBriefEdits) mergedEdits.set(edit.path, { ...edit, value: JSON.parse(JSON.stringify(edit.path === "/company_brief" ? effective.company_brief : getAtPath(effective, edit.path))) });
  } else {
    const oldGeneratedIds = new Set(base.questions.map(({ id }) => id));
    const oldQuestionEdits = (state?.edits ?? []).filter((edit) => edit.path === "/questions" || edit.path.startsWith("/questions/"));
    const pinnedIndices = new Set(oldQuestionEdits.filter((edit) => edit.state === "pinned" && /^\/questions\/\d+$/.test(edit.path)).map((edit) => Number(edit.path.split("/")[2])));
    const pinnedIds = new Set([...pinnedIndices].map((index) => effective.questions[index]?.id).filter((value): value is string => Boolean(value)));
    const customIds = new Set(effective.questions.filter(({ id }) => !oldGeneratedIds.has(id)).map(({ id }) => id));
    const replaced = effective.questions.filter((question) => question.category !== body.category || pinnedIds.has(question.id) || customIds.has(question.id));
    const savedRequirementIds = new Set(next.role.requirements.map(({ id }) => id));
    const compatibleQuestions = regenerated.questions.filter((question) => question.requirement_ids.every((requirementId) => savedRequirementIds.has(requirementId)));
    const selected = compatibleQuestions.filter((question) => question.category === body.category);
    if (!selected.length) throw new HttpError(502, "REGENERATION_FAILED", "The generated questions did not match the saved requirement IDs. Your current section was preserved.");
    const effectiveQuestions = [...replaced, ...selected.filter(({ id }) => !replaced.some((question) => question.id === id))];
    // The full pipeline supplies validated alternatives if replacing a category removes must-have coverage.
    const oldBaseOther = base.questions.filter((question) => question.category !== body.category);
    const newBaseSelected = compatibleQuestions.filter((question) => question.category === body.category);
    let baseQuestions = [...oldBaseOther, ...newBaseSelected];
    let coverage = checkCoverage(next.role.requirements, effectiveQuestions);
    if (!coverage.passes) {
      const recoveryQuestions = compatibleQuestions.filter((question) => !effectiveQuestions.some(({ id }) => id === question.id)
        && question.requirement_ids.some((requirementId) => coverage.uncovered_requirement_ids.includes(requirementId)));
      for (const question of recoveryQuestions) effectiveQuestions.push(question);
      baseQuestions = [...baseQuestions, ...recoveryQuestions];
      coverage = checkCoverage(next.role.requirements, effectiveQuestions);
    }
    if (!coverage.passes) {
      const gaps = coverage.uncovered_requirement_ids.filter((requirementId) => next.role.requirements.some(({ id, priority }) => id === requirementId && priority === "must"));
      throw new HttpError(422, "MUST_HAVE_COVERAGE_GAP", `Regeneration left must-have requirements uncovered: ${gaps.join(", ")}. Keep an existing question or try again.`);
    }
    // The canonical generated kit remains internally valid independently of editable overlays.
    let baseCoverage = checkCoverage(next.role.requirements, baseQuestions);
    if (!baseCoverage.passes) {
      const baseRecovery = compatibleQuestions.filter((question) => !baseQuestions.some(({ id }) => id === question.id)
        && question.requirement_ids.some((requirementId) => baseCoverage.uncovered_requirement_ids.includes(requirementId)));
      baseQuestions = [...baseQuestions, ...baseRecovery];
      baseCoverage = checkCoverage(next.role.requirements, baseQuestions);
    }
    if (!baseCoverage.passes) {
      const gaps = baseCoverage.uncovered_requirement_ids.filter((requirementId) => next.role.requirements.some(({ id, priority }) => id === requirementId && priority === "must"));
      throw new HttpError(422, "MUST_HAVE_COVERAGE_GAP", `Regeneration could not retain must-have coverage for: ${gaps.join(", ")}.`);
    }
    next.questions = baseQuestions;
    const days = input.days;
    next.schedule = buildSchedule(next.role.requirements, baseQuestions, days);
    next.coverage = { uncovered_requirement_ids: baseCoverage.uncovered_requirement_ids, passes: regenerated.coverage.passes };
    for (const path of mergedEdits.keys()) if (path === "/questions" || path.startsWith("/questions/") || path === "/schedule" || path === "/coverage") mergedEdits.delete(path);
    mergedEdits.set("/questions", { path: "/questions", value: effectiveQuestions, state: "edited" });
    for (const [index, question] of effectiveQuestions.entries()) {
      if (pinnedIds.has(question.id)) mergedEdits.set(`/questions/${index}`, { path: `/questions/${index}`, value: question, state: "pinned" });
    }
    mergedEdits.set("/schedule", { path: "/schedule", value: next.schedule, state: "edited" });
    mergedEdits.set("/coverage", { path: "/coverage", value: next.coverage, state: "edited" });
  }

  const updatedEffective = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  for (const edit of mergedEdits.values()) setAtPath(updatedEffective, edit.path, edit.value);
  // Schedule and coverage are derived from effective questions, so refresh their overlays after category regeneration.
  if (body.section === "question_category") {
    const completeEffective = CompleteKitSchema.parse(updatedEffective) as unknown as import("../types/kit.js").CompleteKit;
    const coverage = checkCoverage(completeEffective.role.requirements, completeEffective.questions);
    const schedule = buildSchedule(completeEffective.role.requirements, completeEffective.questions, input.days);
    const effectiveCoverage = { uncovered_requirement_ids: coverage.uncovered_requirement_ids, passes: regenerated.coverage.passes };
    mergedEdits.set("/coverage", { path: "/coverage", value: effectiveCoverage, state: "edited" });
    mergedEdits.set("/schedule", { path: "/schedule", value: schedule, state: "edited" });
  }
  CompleteKitSchema.parse(next);
  const update = await KitModel.updateOne(
    { _id: document._id, ownerId: userId, revision: expectedRevision },
    { $set: { kit: next, editorState: { edits: [...mergedEdits.values()] } }, $inc: { revision: 1 } },
  );
  if (update.modifiedCount !== 1) throw new HttpError(409, "KIT_REVISION_CONFLICT", "This kit changed while regeneration was running. Reload it before trying again.");
  const saved = await KitModel.findOne({ _id: document._id, ownerId: userId }) as KitRecord | null;
  if (!saved) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  const serialized = serializeKit(saved);
  response.json({ kit: serialized, generation: { status: result.status, warnings: result.warnings, uncovered_requirement_ids: (serialized.effective_kit as unknown as import("../types/kit.js").CompleteKit).coverage.uncovered_requirement_ids } });
}));

function getAtPath(root: unknown, path: string): unknown {
  return pointerParts(path).reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, root);
}

kitsRouter.delete("/:id", asyncRoute(async (request, response) => {
  const userId = (request as AuthenticatedRequest).userId!;
  const id = safeKitId(request.params.id);
  const document = await KitModel.findOne({ _id: id, ownerId: userId }).select("_id").lean() as { _id: unknown } | null;
  if (!document) throw new HttpError(404, "KIT_NOT_FOUND", "Kit not found.");
  await Promise.all([
    KitModel.deleteOne({ _id: document._id, ownerId: userId }),
    GenerationJobModel.deleteMany({ kitId: document._id, userId }),
    PracticeProgressModel.deleteMany({ kitId: document._id, userId }),
  ]);
  response.status(204).end();
}));
