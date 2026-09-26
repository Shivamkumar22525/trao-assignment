import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ readyState: 0, connect: vi.fn() }));
vi.mock("mongoose", () => ({ default: {
  connection: { get readyState() { return state.readyState; }, set readyState(value: number) { state.readyState = value; } },
  connect: (...args: unknown[]) => state.connect(...args),
} }));

const { connectDatabase } = await import("../../server/db/connect.js");

describe("reusable MongoDB connection", () => {
  it("shares concurrent connection work and reconnects after a disconnection", async () => {
    const mongoose = (await import("mongoose")).default;
    state.readyState = 0;
    state.connect.mockImplementation(async () => { state.readyState = 1; return mongoose; });
    await Promise.all([connectDatabase("mongodb://test/db"), connectDatabase("mongodb://test/db")]);
    expect(state.connect).toHaveBeenCalledTimes(1);
    (mongoose.connection as unknown as { readyState: number }).readyState = 0;
    await connectDatabase("mongodb://test/db");
    expect(state.connect).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when the database URI is absent", async () => {
    await expect(connectDatabase(undefined)).rejects.toThrow("MONGODB_URI is not configured.");
  });
});
