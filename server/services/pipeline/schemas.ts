import { z } from "zod";

export const RequirementDraftSchema = z.object({
  requirements: z.array(z.object({
    text: z.string().trim().min(1).max(600),
    kind: z.enum(["technical", "behavioural", "domain"]),
    priority: z.enum(["must", "nice"]),
  }).strict()).max(50),
  role_profile: z.object({
    title: z.string().trim().max(200),
    seniority: z.string().trim().max(100),
    responsibilities: z.array(z.string().trim().min(1).max(600)).max(30),
  }).strict().optional(),
}).strict();

export const QuestionDraftSchema = z.object({
  questions: z.array(z.object({
    requirement_ids: z.array(z.string().min(1)).min(1).max(20),
    category: z.enum(["technical", "behavioural", "system-design", "company-fit"]),
    prompt: z.string().trim().min(1).max(1200),
    answer_outline: z.string().trim().min(1).max(3000),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict()).max(100),
}).strict();

export const CompanyBriefDraftSchema = z.object({
  summary: z.string().max(2000),
  what_they_do: z.string().max(2000),
  sources: z.array(z.string().url()).max(20),
}).strict();

export type RequirementDraft = z.infer<typeof RequirementDraftSchema>;
export type QuestionDraft = z.infer<typeof QuestionDraftSchema>;
export type CompanyBriefDraft = z.infer<typeof CompanyBriefDraftSchema>;
