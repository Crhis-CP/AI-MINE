// Historical names and SQL order stay unchanged; every file and its hash record commit together.
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { loadMigrationInventory, validateAppliedMigrations } from "./migrations/inventory.ts";

export async function migrate(root = REPO_ROOT): Promise<void> {
  const inventory = loadMigrationInventory(root);
  // Enable only alongside schema-qualified C and the role catalogue, with the first module migration.
  if (inventory.some((entry) => entry.module !== null)) throw new Error("Module migrations await schema-aware ownership and role support");
  try {
    await initializeDb("migrate");
    const reserved = await dbOf("config").reserve();
    const transaction = async <T>(run: (tx: typeof reserved) => Promise<T>): Promise<T> => {
      await reserved`BEGIN`;
      try {
        const result = await run(reserved);
        await reserved`COMMIT`;
        return result;
      } catch (error) {
        await reserved`ROLLBACK`;
        throw error;
      }
    };
    try {
      await reserved`SELECT pg_advisory_lock(4279632, 1)`;
      const applied = await transaction(async (tx) => {
        await tx`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
        await tx`ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS sha256 text`;
        const rows = await tx<{ name: string; sha256: string | null }[]>`SELECT name, sha256 FROM public.schema_migrations`;
        validateAppliedMigrations(inventory, rows);
        for (const row of rows.filter((row) => row.sha256 === null)) {
          const hash = inventory.find((entry) => entry.name === row.name)!.sha256;
          await tx`UPDATE public.schema_migrations SET sha256=${hash} WHERE name=${row.name}`;
        }
        return rows.map((row) => row.name);
      });
      let count = 0;
      for (const entry of inventory) {
        if (applied.includes(entry.name)) continue;
        await transaction(async (tx) => {
          await tx.unsafe(entry.text);
          await tx`INSERT INTO public.schema_migrations (name,sha256) VALUES (${entry.name},${entry.sha256})`;
        });
        console.log(`applied ${entry.name}`);
        count++;
      }
      console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
    } finally {
      try {
        await reserved`SELECT pg_advisory_unlock(4279632, 1)`;
      } finally {
        reserved.release();
      }
    }
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await migrate();
