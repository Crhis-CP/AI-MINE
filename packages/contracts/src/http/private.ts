import { z } from "zod";
import { Problem, ProblemResponse } from "./common.ts";

export const LoginOptions = z.strictObject({ password: z.boolean(), feishu: z.boolean() });
export const schemas = { LoginOptions, Problem };
export const routes = {
  loginOptions: {
    method: "GET" as const,
    url: "/api/auth/options",
    schema: { operationId: "loginOptions", response: { 200: LoginOptions, 404: ProblemResponse, 503: ProblemResponse } },
  },
};
