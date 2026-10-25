import { z } from "zod";
import type { Capability } from "./editorial/models.ts";
import type { ServerModule } from "./modules.ts";

const Step = z.object({
  label: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
  env: z
    .string()
    .min(1)
    .refine((value) => value === value.trim()),
  purposes: z
    .array(
      z
        .string()
        .min(1)
        .refine((value) => value === value.trim()),
    )
    .min(1),
  lane: z.enum(["news", "policy"]).optional(),
  vision: z.boolean().optional(),
});

/** Pure shared lookup: a malformed extension cannot disable core or independent model steps. */
export function buildModelCatalog(core: Record<string, Capability>, modules: readonly ServerModule[], defaults: Record<string, string>) {
  const steps: Record<string, Capability> = Object.create(null);
  const purposes = new Set<string>(),
    checked: string[] = [];
  const issues: Array<{ module: string }> = [];
  for (const [key, step] of Object.entries(core)) {
    steps[key] = { ...step, purposes: [...step.purposes], lane: step.lane ?? (key.startsWith("policy_") ? "policy" : "news") };
    for (const purpose of step.purposes) purposes.add(purpose);
  }
  for (const module of modules) {
    try {
      const declared = module.models;
      if (declared === undefined) continue;
      if (!declared || typeof declared !== "object" || Array.isArray(declared)) throw new Error("invalid model declaration");
      const entries = Object.entries(declared);
      if (!entries.length) continue;
      checked.push(module.name);
      const pending: Record<string, Capability> = Object.create(null),
        nextPurposes = new Set(purposes);
      for (const [key, value] of entries) {
        const step = Step.parse(value);
        if (
          !key.trim() ||
          key !== key.trim() ||
          Object.hasOwn(Object.prototype, key) ||
          Object.hasOwn(steps, key) ||
          step.purposes.some((purpose) => nextPurposes.has(purpose)) ||
          new Set(step.purposes).size !== step.purposes.length
        )
          throw new Error("conflicting model declaration");
        pending[key] = { ...step, default: defaults[key] ?? "default" };
        for (const purpose of step.purposes) nextPurposes.add(purpose);
      }
      Object.assign(steps, pending);
      for (const purpose of nextPurposes) purposes.add(purpose);
    } catch {
      issues.push({ module: module.name });
    }
  }
  return { steps, issues, checked };
}
