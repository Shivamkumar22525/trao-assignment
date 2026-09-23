import { Schema, model, models } from "mongoose";

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
}, {
  timestamps: true,
  toJSON: { transform: (_document, returned) => {
    const safeReturned = returned as Record<string, unknown>;
    delete safeReturned.passwordHash;
    return safeReturned;
  } },
});

export const UserModel = models.User ?? model("User", UserSchema);
