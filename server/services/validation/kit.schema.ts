import { z } from "zod";

const RequirementKindSchema = z.enum(["technical", "behavioural", "domain"]);
const RequirementPrioritySchema = z.enum(["must", "nice"]);
const QuestionCategorySchema = z.enum(["technical", "behavioural", "system-design", "company-fit"]);
const IdSchema = z.string().min(1);
const StringListSchema = z.array(z.string());

export const CompleteKitSchema = z.object({
  source: z.object({
    company: z.string(),
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: z.number().int().nonnegative(),
    researched_at: z.string(),
    pages_used: StringListSchema,
  }),
  company_brief: z.object({
    summary: z.string(),
    what_they_do: z.string(),
    sources: StringListSchema,
  }),
  role: z.object({
    title: z.string(),
    seniority: z.string(),
    responsibilities: StringListSchema,
    requirements: z.array(z.object({
      id: IdSchema,
      text: z.string(),
      kind: RequirementKindSchema,
      priority: RequirementPrioritySchema,
    })),
  }),
  questions: z.array(z.object({
    id: IdSchema,
    requirement_ids: z.array(IdSchema),
    category: QuestionCategorySchema,
    prompt: z.string(),
    answer_outline: z.string(),
    difficulty: z.number().int().min(1).max(3),
  })),
  flashcards: z.array(z.object({
    id: IdSchema,
    front: z.string(),
    back: z.string(),
    requirement_ids: z.array(IdSchema),
  })),
  schedule: z.object({
    days_available: z.number().int().positive(),
    days: z.array(z.object({
      day: z.number().int().positive(),
      focus: z.string(),
      question_ids: z.array(IdSchema),
      minutes: z.number().int().nonnegative(),
    })),
  }),
  coverage: z.object({
    uncovered_requirement_ids: z.array(IdSchema),
    passes: z.number().int().nonnegative(),
  }),
}).superRefine((kit, context) => {
  const requirementIds = kit.role.requirements.map((requirement) => requirement.id);
  const requirementIdSet = new Set(requirementIds);
  const questionIds = kit.questions.map((question) => question.id);
  const questionIdSet = new Set(questionIds);
  const unique = (ids: string[]) => new Set(ids).size === ids.length;

  if (!unique(requirementIds)) context.addIssue({ code: "custom", path: ["role", "requirements"], message: "Requirement IDs must be unique within a kit." });
  if (!unique(questionIds)) context.addIssue({ code: "custom", path: ["questions"], message: "Question IDs must be unique within a kit." });
  if (!unique(kit.flashcards.map((card) => card.id))) context.addIssue({ code: "custom", path: ["flashcards"], message: "Flashcard IDs must be unique within a kit." });

  kit.questions.forEach((question, index) => {
    question.requirement_ids.forEach((id) => {
      if (!requirementIdSet.has(id)) context.addIssue({ code: "custom", path: ["questions", index, "requirement_ids"], message: `Unknown requirement ID: ${id}` });
    });
  });
  kit.flashcards.forEach((card, index) => {
    card.requirement_ids.forEach((id) => {
      if (!requirementIdSet.has(id)) context.addIssue({ code: "custom", path: ["flashcards", index, "requirement_ids"], message: `Unknown requirement ID: ${id}` });
    });
  });

  if (kit.schedule.days_available !== kit.schedule.days.length) {
    context.addIssue({ code: "custom", path: ["schedule", "days"], message: "Schedule day count must equal days_available." });
  }
  kit.schedule.days.forEach((day, index) => {
    day.question_ids.forEach((id) => {
      if (!questionIdSet.has(id)) context.addIssue({ code: "custom", path: ["schedule", "days", index, "question_ids"], message: `Unknown question ID: ${id}` });
    });
  });

  const coveredIds = new Set(kit.questions.flatMap((question) => question.requirement_ids));
  const actualUncovered = requirementIds.filter((id) => !coveredIds.has(id)).sort();
  const reportedUncovered = [...kit.coverage.uncovered_requirement_ids].sort();
  if (!unique(kit.coverage.uncovered_requirement_ids) || actualUncovered.join("\0") !== reportedUncovered.join("\0")) {
    context.addIssue({ code: "custom", path: ["coverage", "uncovered_requirement_ids"], message: "Coverage must list exactly the requirements without a question." });
  }

  const scheduledRequirementIds = new Set(kit.schedule.days.flatMap((day) =>
    day.question_ids.flatMap((questionId) => kit.questions.find((question) => question.id === questionId)?.requirement_ids ?? []),
  ));
  kit.role.requirements.forEach((requirement, index) => {
    if (requirement.priority === "must" && !coveredIds.has(requirement.id)) {
      context.addIssue({ code: "custom", path: ["role", "requirements", index], message: "Must-have requirements must have question coverage." });
    }
    if (requirement.priority === "must" && !scheduledRequirementIds.has(requirement.id)) {
      context.addIssue({ code: "custom", path: ["schedule"], message: `Must-have requirement ${requirement.id} must appear in the schedule.` });
    }
  });
});

export type CompleteKitInput = z.input<typeof CompleteKitSchema>;
export type ValidatedCompleteKit = z.output<typeof CompleteKitSchema>;
