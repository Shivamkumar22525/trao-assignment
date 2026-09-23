import { describe, expect, it } from "vitest";
import type { Question, Requirement } from "../../server/types/kit.js";
import { checkCoverage, CoverageValidationError } from "../../server/services/coverage/checkCoverage.js";

const requirement = (id: string, priority: Requirement["priority"] = "must"): Requirement => ({
  id,
  text: `Requirement ${id}`,
  kind: "technical",
  priority,
});

const question = (id: string, requirement_ids: string[]): Question => ({
  id,
  requirement_ids,
  category: "technical",
  prompt: `Question ${id}`,
  answer_outline: "Outline",
  difficulty: 2,
});

describe("checkCoverage", () => {
  it("passes when all must-have requirements are covered", () => {
    expect(checkCoverage([requirement("r1"), requirement("r2")], [question("q1", ["r1"]), question("q2", ["r2"])]))
      .toEqual({ uncovered_requirement_ids: [], passes: true });
  });

  it("fails when a must-have requirement is uncovered", () => {
    expect(checkCoverage([requirement("r1"), requirement("r2")], [question("q1", ["r1"])]))
      .toEqual({ uncovered_requirement_ids: ["r2"], passes: false });
  });

  it("reports an uncovered nice-to-have without failing must-have coverage", () => {
    expect(checkCoverage([requirement("r1"), requirement("r2", "nice")], [question("q1", ["r1"])]))
      .toEqual({ uncovered_requirement_ids: ["r2"], passes: true });
  });

  it("accepts multiple questions covering the same requirement", () => {
    expect(checkCoverage([requirement("r1")], [question("q1", ["r1"]), question("q2", ["r1"])]))
      .toEqual({ uncovered_requirement_ids: [], passes: true });
  });

  it("rejects a question that references an unknown requirement", () => {
    expect(() => checkCoverage([requirement("r1")], [question("q1", ["missing"])]))
      .toThrowError(CoverageValidationError);
    try {
      checkCoverage([requirement("r1")], [question("q1", ["missing"])]);
    } catch (error) {
      expect(error).toMatchObject({ code: "UNKNOWN_REQUIREMENT_REFERENCE", ids: ["q1", "missing"] });
    }
  });

  it("rejects duplicate requirement IDs", () => {
    expect(() => checkCoverage([requirement("r1"), requirement("r1", "nice")], []))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_REQUIREMENT_ID", ids: ["r1"] }));
  });

  it("rejects duplicate question IDs", () => {
    expect(() => checkCoverage([requirement("r1")], [question("q1", ["r1"]), question("q1", ["r1"])]))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_QUESTION_ID", ids: ["q1"] }));
  });

  it("reports every requirement uncovered for an empty question list", () => {
    expect(checkCoverage([requirement("r2", "nice"), requirement("r1")], []))
      .toEqual({ uncovered_requirement_ids: ["r1", "r2"], passes: false });
  });

  it("preserves mixed must/nice priority behavior", () => {
    expect(checkCoverage(
      [requirement("r1"), requirement("r2", "nice"), requirement("r3")],
      [question("q1", ["r1"])],
    )).toEqual({ uncovered_requirement_ids: ["r2", "r3"], passes: false });
  });
});
