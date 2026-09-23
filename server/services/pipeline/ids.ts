import { createHash } from "node:crypto";

export function normalizeForId(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function digest(prefix: string, material: string): string {
  return `${prefix}_${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 20)}`;
}

export function requirementId(text: string, kind: string, _priority?: string): string {
  return digest("req", `${kind}\0${normalizeForId(text)}`);
}

export function questionId(prompt: string, requirementIds: readonly string[], category: string): string {
  return digest("q", `${category}\0${[...requirementIds].sort().join("\0")}\0${normalizeForId(prompt)}`);
}
