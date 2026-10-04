import { z } from "zod";

// Existing Problem JSON, including the optional retry header companion.
export const Problem = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  code: z.string(),
  requestId: z.string(),
  retryAfter: z.number().optional(),
});
export type ProblemBody = z.infer<typeof Problem>;

export const ProblemResponse = {
  description: "Problem response",
  content: { "application/problem+json": { schema: Problem } },
};
