import { z } from "zod";
import { ProblemResponse } from "./common.ts";
export const ControlLane = z.enum(["news", "policy", "all"]);
export const ControlSwitch = z.enum(["collection", "processing", "publication"]);
export const ControlHolder = z.enum(["owner", "deploy", "system"]);
export const LaneControl = z.strictObject({
  lane: ControlLane,
  switch: ControlSwitch,
  holder: ControlHolder,
  revision: z.int().nonnegative(),
  reason: z.string(),
  actor: z.string(),
  expires_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  overdue: z.boolean(),
});
export const LaneControlsResponse = z.strictObject({
  controls: z.array(LaneControl),
  owner_revisions: z.array(z.strictObject({ lane: ControlLane, switch: z.enum(["collection", "processing"]), revision: z.int().nonnegative() })),
});
export const LaneControlActionRequest = z
  .strictObject({
    lane: ControlLane,
    mode: z.enum(["processing", "automatic"]),
    action: z.enum(["pause", "resume"]),
    reason: z.string().trim().min(1).max(1000),
    expires_at: z.iso.datetime({ offset: true }).optional(),
    expected_revisions: z.strictObject({ processing: z.int().nonnegative(), collection: z.int().nonnegative().optional() }),
    confirm_all: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.action === "pause" && !value.expires_at) issue("Pause requires expiry");
    if (value.action === "resume" && value.expires_at) issue("Resume cannot set expiry");
    if ((value.mode === "automatic") !== (value.expected_revisions.collection !== undefined)) issue("Expected revisions must match both requested switches");
    if (value.lane === "all" && !value.confirm_all) issue("All-lane action requires explicit confirmation");
  });
export const runtimeControlSchemas = { LaneControl, LaneControlsResponse, LaneControlActionRequest };
export const runtimeControlRoutes = {
  laneControls: {
    method: "GET" as const,
    url: "/api/admin/lane-controls",
    schema: { operationId: "laneControls", response: { 200: LaneControlsResponse, 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse } },
  },
  laneControlAction: {
    method: "POST" as const,
    url: "/api/admin/lane-controls/actions",
    schema: {
      operationId: "laneControlAction",
      body: LaneControlActionRequest,
      response: { 200: LaneControlsResponse, 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse },
    },
  },
};
