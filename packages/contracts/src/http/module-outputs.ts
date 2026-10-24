import { z } from "zod";

/** Each installed module validates its own safe projection before returning public parts. */
export const ModuleParts = z.record(z.string().min(1), z.unknown());
export const AdminNavigationCounts = z.record(z.string().min(1), z.number().int().nonnegative());
export const AdminModuleRuns = z.record(
  z.string().min(1),
  z.discriminatedUnion("status", [z.strictObject({ status: z.literal("ready"), data: z.unknown() }), z.strictObject({ status: z.literal("unavailable") })]),
);
