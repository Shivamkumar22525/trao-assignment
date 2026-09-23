import type { Question, Requirement } from "../../types/kit.js";

export type CoverageErrorCode =
  | "DUPLICATE_REQUIREMENT_ID"
  | "DUPLICATE_QUESTION_ID"
  | "UNKNOWN_REQUIREMENT_REFERENCE";

export class CoverageValidationError extends Error {
  constructor(
    public readonly code: CoverageErrorCode,
    message: string,
    public readonly ids: string[] = [],
  ) {
    super(message);
    this.name = "CoverageValidationError";
  }
}

export interface RequirementCoverageResult {
  /** All uncovered requirement IDs, including nice-to-have requirements. */
  uncovered_requirement_ids: string[];
  /** True exactly when every must-have requirement has question coverage. */
  passes: boolean;
}

/**
 * Checks coverage only through question.requirement_ids. IDs are never inferred,
 * generated, repaired, or matched using question text.
 */
export function checkCoverage(
  requirements: readonly Requirement[],
  questions: readonly Question[],
): RequirementCoverageResult {
  const requirementIds = new Set<string>();
  for (const requirement of requirements) {
    if (requirementIds.has(requirement.id)) {
      throw new CoverageValidationError(
        "DUPLICATE_REQUIREMENT_ID",
        `Duplicate requirement ID: ${requirement.id}`,
        [requirement.id],
      );
    }
    requirementIds.add(requirement.id);
  }

  const questionIds = new Set<string>();
  const coveredRequirementIds = new Set<string>();
  for (const question of questions) {
    if (questionIds.has(question.id)) {
      throw new CoverageValidationError(
        "DUPLICATE_QUESTION_ID",
        `Duplicate question ID: ${question.id}`,
        [question.id],
      );
    }
    questionIds.add(question.id);

    for (const requirementId of question.requirement_ids) {
      if (!requirementIds.has(requirementId)) {
        throw new CoverageValidationError(
          "UNKNOWN_REQUIREMENT_REFERENCE",
          `Question ${question.id} references unknown requirement ID: ${requirementId}`,
          [question.id, requirementId],
        );
      }
      coveredRequirementIds.add(requirementId);
    }
  }

  const uncoveredRequirementIds = requirements
    .filter(({ id }) => !coveredRequirementIds.has(id))
    .map(({ id }) => id)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const uncoveredMustHave = requirements.some(
    ({ id, priority }) => priority === "must" && !coveredRequirementIds.has(id),
  );

  return {
    uncovered_requirement_ids: uncoveredRequirementIds,
    passes: !uncoveredMustHave,
  };
}
