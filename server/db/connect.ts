import mongoose from "mongoose";

let connection: Promise<typeof mongoose> | undefined;

/** Reuse one in-flight Mongoose connection across requests and hot reloads. */
export async function connectDatabase(uri = process.env.MONGODB_URI): Promise<typeof mongoose> {
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  if (mongoose.connection.readyState === 1) return mongoose;
  if (mongoose.connection.readyState === 2 && connection) return connection;
  // A resolved promise does not reconnect after a later socket disconnect.
  connection = undefined;
  connection = mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    return await connection;
  } catch (error) {
    connection = undefined;
    throw error;
  }
}
