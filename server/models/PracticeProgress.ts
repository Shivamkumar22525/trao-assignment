import { Schema, model, models } from "mongoose";

const PracticeProgressSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  kitId: { type: Schema.Types.ObjectId, ref: "Kit", required: true, index: true },
  flashcardId: { type: String, required: true },
  confidence: { type: Number, min: 1, max: 5 },
  covered: { type: Boolean, default: false },
  attempts: { type: Number, min: 0, default: 0 },
  lastPracticedAt: { type: Date },
}, { timestamps: true });
PracticeProgressSchema.index({ userId: 1, kitId: 1, flashcardId: 1 }, { unique: true });

export const PracticeProgressModel = models.PracticeProgress ?? model("PracticeProgress", PracticeProgressSchema);
