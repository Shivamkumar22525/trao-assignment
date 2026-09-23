import { Schema, model, models } from "mongoose";

const GenerationJobSchema = new Schema({
  kitId: { type: Schema.Types.ObjectId, ref: "Kit", index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  status: { type: String, enum: ["queued", "running", "succeeded", "failed"], required: true, default: "queued" },
  currentStage: { type: String, default: "queued" },
  progress: { type: Number, min: 0, max: 100, default: 0 },
  errors: { type: [Schema.Types.Mixed], default: [] },
  retryCount: { type: Number, min: 0, default: 0 },
}, { timestamps: true });

export const GenerationJobModel = models.GenerationJob ?? model("GenerationJob", GenerationJobSchema);
