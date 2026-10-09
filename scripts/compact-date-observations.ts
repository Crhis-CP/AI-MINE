// Production cleanup requires separate Owner approval; the default only reports duplicate evidence.
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { compactDateObservations } from "@amp/backend/content/materials";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.length > 1) throw new Error("Usage: compact-date-observations.ts [--apply]");
  await initializeDb("migrate");
  const { materials, ...summary } = await compactDateObservations(dbOf("content"), { apply: args.includes("--apply") });
  console.log(JSON.stringify(summary));
  if (summary.apply) for (const row of materials) console.log(JSON.stringify({ articleId: row.articleId, before: row.before, after: row.after }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeDb();
}
