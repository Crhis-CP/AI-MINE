import { readdirSync } from "node:fs";
import path from "node:path";

export const ROLE_TEST_FILES = [
  "tests/db-role-plan.test.ts",
  "tests/db-role-grants.test.ts",
  "tests/db-role-matrix.test.ts",
  "tests/public-role-routes.test.ts",
] as const;

/** A complete, non-overlapping partition; omit no backend test and never silently omit a required matrix. */
export function partitionBackendTests(files: readonly string[]) {
  if (new Set(files).size !== files.length || files.some((file) => !/^tests\/[^/]+\.test\.ts$/.test(file)))
    throw new Error("Backend test inventory must contain unique top-level test files");
  for (const file of ROLE_TEST_FILES) if (!files.includes(file)) throw new Error(`Missing required role test: ${file}`);
  const roles = new Set<string>(ROLE_TEST_FILES);
  return { role: [...ROLE_TEST_FILES], backend: files.filter((file) => !roles.has(file)).sort() };
}

export function backendTestGroups(root: string) {
  return partitionBackendTests(
    readdirSync(path.join(root, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `tests/${name}`),
  );
}

/** Quick stays database-free. Full cannot claim a pass without actually running the real role tests. */
export async function runRoleTests(options: { quick: boolean; hasDatabase: boolean; execute: (files: readonly string[]) => Promise<number> }) {
  if (!options.quick && !options.hasDatabase) return { status: "skipped" as const, note: "no database for the real role and public-route matrix" };
  const files = options.quick ? [ROLE_TEST_FILES[0]] : ROLE_TEST_FILES;
  if ((await options.execute(files)) !== 0) return { status: "fail" as const, note: "database role tests failed" };
  return {
    status: "pass" as const,
    note: options.quick
      ? "environment/configuration and pure grant plans; no database matrix in quick mode"
      : "environment/configuration, real role grants and complete public-route/feedback matrix",
  };
}
