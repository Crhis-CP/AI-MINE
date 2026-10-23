import { sql } from "../db.ts";
import { serverModules } from "../modules.ts";

/** Read worker-owned timer definitions without starting queue producers or handlers. */
export async function currentScheduledJobs() {
  const rows = await sql<{ name: string }[]>`SELECT name FROM pgboss.queue WHERE name LIKE 'cron.%' ORDER BY name`;
  const names = new Set(rows.map((row) => row.name.slice(5)));
  for (const module of serverModules())
    if (module.admin?.currentJobs) {
      try {
        for (const name of await module.admin.currentJobs()) names.add(name);
      } catch {
        console.warn("外部任务列表暂时无法读取", { module: module.name });
      }
    }
  return [...names];
}
