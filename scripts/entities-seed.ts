// Loads the entity library's first rows (schema `entities`) from the companies the code already lists
// (packages/backend/src/pipeline/entities/seed.ts): the tag vocabulary, the name glossary and seed-data.ts. Rows that
// are there are never changed, so after the first load the database is the truth and a re-run only adds what a later
// release added to the code seed. No model call; nothing readers see changes.
//   node scripts/entities-seed.ts            dry run (default): counts what is there and what would be added
//   node scripts/entities-seed.ts --apply    adds the absent rows, then prints the same counts
// Runs with the back office's login (private_ops may insert into the library; the worker only reads it), e.g.
// `docker compose exec -T api node scripts/entities-seed.ts --apply`. Until it has run, the worker links articles with
// the same seed held in memory and stores no links (docs/runbooks/article-observe.md).
import { closeDb, initializeDb } from "@amp/backend/db";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { seedEntityLibrary } from "../packages/backend/src/pipeline/entities/store.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
if (args.some((arg) => arg !== "--apply")) {
  console.error("usage: entities-seed.ts [--apply]; nothing written");
  process.exit(2);
}

await initializeDb("api");
try {
  const outcome = await seedEntityLibrary(seedRows(), "entities-seed", { apply });
  const shown = (counts: { seed: number; present: number; added: number }) =>
    apply ? counts : { seed: counts.seed, present: counts.present, wouldAdd: counts.added };
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", entities: shown(outcome.entities), statements: shown(outcome.statements) }, null, 2));
} finally {
  await closeDb();
}
