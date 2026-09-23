import { describe, expect, it } from "vitest";
import type { Question, Requirement } from "../../server/types/kit.js";
import { buildSchedule, ScheduleBuildError } from "../../server/services/scheduler/buildSchedule.js";

const requirement = (id: string, priority: Requirement["priority"] = "must"): Requirement => ({
  id,
  text: `Requirement ${id}`,
  kind: "technical",
  priority,
});

const question = (
  id: string,
  requirement_ids: string[],
  difficulty: Question["difficulty"] = 2,
  category: Question["category"] = "technical",
): Question => ({ id, requirement_ids, difficulty, category, prompt: `Question ${id}`, answer_outline: "Outline" });

const requirements: Requirement[] = [requirement("r1"), requirement("r2"), requirement("r3", "nice")];
const questions: Question[] = [
  question("q1", ["r1"], 1),
  question("q2", ["r2"], 3, "system-design"),
  question("q3", ["r3"], 2, "behavioural"),
];

describe("buildSchedule", () => {
  it("builds a one-day schedule", () => {
    const schedule = buildSchedule(requirements, questions, 1);
    expect(schedule).toEqual({
      days_available: 1,
      days: [{ day: 1, focus: "Technical + System design + Behavioural review", question_ids: ["q2", "q1", "q3"], minutes: 105 }],
    });
  });

  it("distributes questions across three days in priority order", () => {
    const schedule = buildSchedule(requirements, questions, 3);
    expect(schedule.days.map(({ question_ids }) => question_ids)).toEqual([["q2"], ["q1"], ["q3"]]);
  });

  it("returns all seven days when there are fewer questions than days", () => {
    const schedule = buildSchedule([requirement("r1")], [question("q1", ["r1"])], 7);
    expect(schedule.days).toHaveLength(7);
    expect(schedule.days.map(({ day }) => day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(schedule.days.slice(1).every(({ question_ids, minutes, focus }) =>
      question_ids.length === 0 && minutes === 15 && focus === "Review and preparation",
    )).toBe(true);
  });

  it("distributes more questions than days across the available days", () => {
    const manyQuestions = [
      question("q1", ["r1"], 3), question("q2", ["r2"], 2), question("q3", ["r3"], 1), question("q4", [], 1),
    ];
    const schedule = buildSchedule(requirements, manyQuestions, 2);
    expect(schedule.days.map(({ question_ids }) => question_ids)).toEqual([["q1", "q3"], ["q2", "q4"]]);
    expect(schedule.days.every(({ question_ids }) => question_ids.length > 0)).toBe(true);
  });

  it("returns exactly days_available days", () => {
    const schedule = buildSchedule(requirements, questions, 3);
    expect(schedule.days.length).toBe(schedule.days_available);
  });

  it("only schedules question IDs supplied in the input", () => {
    const suppliedIds = new Set(questions.map(({ id }) => id));
    const schedule = buildSchedule(requirements, questions, 3);
    expect(schedule.days.flatMap(({ question_ids }) => question_ids).every((id) => suppliedIds.has(id))).toBe(true);
  });

  it("places at least one question for each must-have requirement in the schedule", () => {
    const schedule = buildSchedule(requirements, questions, 3);
    const scheduledIds = new Set(schedule.days.flatMap(({ question_ids }) => question_ids));
    const scheduledQuestions = questions.filter(({ id }) => scheduledIds.has(id));
    expect(requirements.filter(({ priority }) => priority === "must").every(({ id }) =>
      scheduledQuestions.some(({ requirement_ids }) => requirement_ids.includes(id)),
    )).toBe(true);
  });

  it("surfaces must-have requirements with no question", () => {
    expect(() => buildSchedule([requirement("r1"), requirement("r2")], [question("q1", ["r1"])], 2))
      .toThrowError(expect.objectContaining({ code: "MISSING_MUST_HAVE_QUESTION", ids: ["r2"] }));
  });

  it("handles higher-priority requirements earlier than nice-to-haves", () => {
    const schedule = buildSchedule(requirements, questions, 3);
    expect(schedule.days[0].question_ids).toContain("q2");
    expect(schedule.days[1].question_ids).toContain("q1");
    expect(schedule.days[2].question_ids).toContain("q3");
  });

  it("prioritizes harder questions within the same requirement priority", () => {
    const schedule = buildSchedule(
      [requirement("r1"), requirement("r2")],
      [question("q-easy", ["r1"], 1), question("q-hard", ["r2"], 3)],
      2,
    );
    expect(schedule.days[0].question_ids).toEqual(["q-hard"]);
    expect(schedule.days[1].question_ids).toEqual(["q-easy"]);
  });

  it("returns empty days when the question list is empty and there are no requirements", () => {
    expect(buildSchedule([], [], 3)).toEqual({
      days_available: 3,
      days: [1, 2, 3].map((day) => ({ day, focus: "Review and preparation", question_ids: [], minutes: 15 })),
    });
  });

  it("is deterministic for identical inputs", () => {
    expect(buildSchedule(requirements, questions, 3)).toEqual(buildSchedule(requirements, questions, 3));
  });

  it("rejects duplicate IDs and unknown references", () => {
    expect(() => buildSchedule([requirement("r1"), requirement("r1")], [], 1))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_REQUIREMENT_ID" }));
    expect(() => buildSchedule([requirement("r1")], [question("q1", ["r1"]), question("q1", ["r1"])], 1))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_QUESTION_ID" }));
    expect(() => buildSchedule([requirement("r1")], [question("q1", ["unknown"])], 1))
      .toThrowError(expect.objectContaining({ code: "UNKNOWN_REQUIREMENT_REFERENCE" }));
  });

  it("rejects invalid day counts", () => {
    expect(() => buildSchedule([], [], 0)).toThrowError(ScheduleBuildError);
    expect(() => buildSchedule([], [], 1.5)).toThrowError(ScheduleBuildError);
  });
});
