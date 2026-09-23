import type { Question, Requirement, Schedule } from "../../types/kit.js";

export type ScheduleBuildErrorCode =
  | "INVALID_DAYS_AVAILABLE"
  | "DUPLICATE_REQUIREMENT_ID"
  | "DUPLICATE_QUESTION_ID"
  | "UNKNOWN_REQUIREMENT_REFERENCE"
  | "MISSING_MUST_HAVE_QUESTION";

export class ScheduleBuildError extends Error {
  constructor(
    public readonly code: ScheduleBuildErrorCode,
    message: string,
    public readonly ids: string[] = [],
  ) {
    super(message);
    this.name = "ScheduleBuildError";
  }
}

const CATEGORY_ORDER = ["technical", "system-design", "behavioural", "company-fit"] as const;
const CATEGORY_LABEL: Record<(typeof CATEGORY_ORDER)[number], string> = {
  technical: "Technical",
  "system-design": "System design",
  behavioural: "Behavioural",
  "company-fit": "Company fit",
};

/**
 * Gives must-have contribution precedence, then nice-to-have contribution,
 * then harder difficulty. Question ID is the stable lexical tie-breaker.
 */
function compareQuestions(
  left: Question,
  right: Question,
  requirementById: ReadonlyMap<string, Requirement>,
): number {
  const priorityCounts = (question: Question) => {
    let must = 0;
    let nice = 0;
    for (const id of question.requirement_ids) {
      if (requirementById.get(id)?.priority === "must") must += 1;
      else nice += 1;
    }
    return { must, nice };
  };

  const leftCounts = priorityCounts(left);
  const rightCounts = priorityCounts(right);
  return rightCounts.must - leftCounts.must
    || rightCounts.nice - leftCounts.nice
    || right.difficulty - left.difficulty
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function getFocus(dayQuestions: readonly Question[]): string {
  if (dayQuestions.length === 0) return "Review and preparation";

  const categories = new Set(dayQuestions.map(({ category }) => category));
  const labels = CATEGORY_ORDER
    .filter((category) => categories.has(category))
    .map((category) => CATEGORY_LABEL[category]);

  if (labels.length === 1) {
    const singleFocus: Record<(typeof CATEGORY_ORDER)[number], string> = {
      technical: "Technical fundamentals",
      "system-design": "System design and architecture",
      behavioural: "Behavioural preparation",
      "company-fit": "Company fit",
    };
    const category = CATEGORY_ORDER.find((candidate) => categories.has(candidate));
    return category ? singleFocus[category] : "Review and preparation";
  }

  return `${labels.join(" + ")} review`;
}

function getMinutes(dayQuestions: readonly Question[]): number {
  // Reserve 15 minutes for an empty review day. Otherwise use 25 minutes per
  // question plus 5 minutes per difficulty level (difficulty 1-3).
  if (dayQuestions.length === 0) return 15;
  return dayQuestions.reduce((total, question) => total + 25 + question.difficulty * 5, 0);
}

/** Creates a deterministic Appendix A schedule without inventing questions. */
export function buildSchedule(
  requirements: readonly Requirement[],
  questions: readonly Question[],
  daysAvailable: number,
): Schedule {
  if (!Number.isInteger(daysAvailable) || daysAvailable < 1) {
    throw new ScheduleBuildError("INVALID_DAYS_AVAILABLE", "daysAvailable must be a positive integer.");
  }

  const requirementById = new Map<string, Requirement>();
  for (const requirement of requirements) {
    if (requirementById.has(requirement.id)) {
      throw new ScheduleBuildError("DUPLICATE_REQUIREMENT_ID", `Duplicate requirement ID: ${requirement.id}`, [requirement.id]);
    }
    requirementById.set(requirement.id, requirement);
  }

  const questionById = new Map<string, Question>();
  for (const question of questions) {
    if (questionById.has(question.id)) {
      throw new ScheduleBuildError("DUPLICATE_QUESTION_ID", `Duplicate question ID: ${question.id}`, [question.id]);
    }
    questionById.set(question.id, question);
    for (const requirementId of question.requirement_ids) {
      if (!requirementById.has(requirementId)) {
        throw new ScheduleBuildError(
          "UNKNOWN_REQUIREMENT_REFERENCE",
          `Question ${question.id} references unknown requirement ID: ${requirementId}`,
          [question.id, requirementId],
        );
      }
    }
  }

  const orderedQuestions = [...questions].sort((left, right) => compareQuestions(left, right, requirementById));
  const missingMustHaveIds = requirements
    .filter(({ id, priority }) => priority === "must" && !questions.some(({ requirement_ids }) => requirement_ids.includes(id)))
    .map(({ id }) => id)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (missingMustHaveIds.length > 0) {
    throw new ScheduleBuildError(
      "MISSING_MUST_HAVE_QUESTION",
      `No question covers must-have requirement(s): ${missingMustHaveIds.join(", ")}`,
      missingMustHaveIds,
    );
  }

  // Select one best-ranked question for each must-have before ordinary questions.
  // A question may satisfy several requirements and is scheduled only once.
  const selectedForMust = new Set<string>();
  const mustRequirements = requirements
    .filter(({ priority }) => priority === "must")
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (const requirement of mustRequirements) {
    const coveringQuestion = orderedQuestions.find(({ requirement_ids }) => requirement_ids.includes(requirement.id));
    if (coveringQuestion) selectedForMust.add(coveringQuestion.id);
  }

  const mustQuestions = orderedQuestions.filter(({ id }) => selectedForMust.has(id));
  const remainingQuestions = orderedQuestions.filter(({ id }) => !selectedForMust.has(id));
  const questionsToDistribute = [...mustQuestions, ...remainingQuestions];
  const dayQuestions: Question[][] = Array.from({ length: daysAvailable }, () => []);

  // Round-robin keeps load spread across days while preserving the priority order.
  questionsToDistribute.forEach((question, index) => {
    dayQuestions[index % daysAvailable].push(question);
  });

  return {
    days_available: daysAvailable,
    days: dayQuestions.map((assignedQuestions, index) => ({
      day: index + 1,
      focus: getFocus(assignedQuestions),
      question_ids: assignedQuestions.map(({ id }) => id),
      minutes: getMinutes(assignedQuestions),
    })),
  };
}
