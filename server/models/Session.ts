import { Schema, model, models } from "mongoose";

const SessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
}, {
  timestamps: true,
  toJSON: { transform: (_document, returned) => {
    const safeReturned = returned as Record<string, unknown>;
    delete safeReturned.tokenHash;
    return safeReturned;
  } },
});
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = models.Session ?? model("Session", SessionSchema);
