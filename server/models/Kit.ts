import { Schema, model, models } from "mongoose";

const KitSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  originalInput: {
    jd: { type: String, required: true },
    company_url: { type: String, required: true },
    days: { type: Number, required: true, min: 1 },
    company_name: { type: String },
    role: { type: String },
    location: { type: String },
  },
  kit: { type: Schema.Types.Mixed, required: true },
  editorState: { type: Schema.Types.Mixed, default: () => ({}) },
  revision: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true, minimize: false });

export const KitModel = models.Kit ?? model("Kit", KitSchema);
