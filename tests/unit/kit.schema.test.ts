import { describe, expect, it } from "vitest";
import { CompleteKitSchema } from "../../server/services/validation/kit.schema.js";
import { validKit } from "../fixtures/valid-kit.js";

describe("CompleteKitSchema", () => {
  it("accepts a valid Appendix A kit", () => {
    expect(CompleteKitSchema.safeParse(validKit).success).toBe(true);
  });

  it("rejects an invalid requirement kind", () => {
    const kit = structuredClone(validKit);
    (kit.role.requirements[0] as { kind: string }).kind = "culture";
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects an invalid requirement priority", () => {
    const kit = structuredClone(validKit);
    (kit.role.requirements[0] as { priority: string }).priority = "optional";
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects an invalid question category", () => {
    const kit = structuredClone(validKit);
    (kit.questions[0] as { category: string }).category = "culture";
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects difficulty outside 1 to 3", () => {
    const kit = structuredClone(validKit);
    (kit.questions[0] as { difficulty: number }).difficulty = 4;
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects non-integer schedule minutes", () => {
    const kit = structuredClone(validKit);
    (kit.schedule.days[0] as { minutes: number }).minutes = 30.5;
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects a schedule reference to a nonexistent question", () => {
    const kit = structuredClone(validKit);
    kit.schedule.days[0].question_ids = ["missing"];
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });

  it("rejects a question reference to a nonexistent requirement", () => {
    const kit = structuredClone(validKit);
    kit.questions[0].requirement_ids = ["missing"];
    expect(CompleteKitSchema.safeParse(kit).success).toBe(false);
  });
});
