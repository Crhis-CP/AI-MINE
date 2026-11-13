import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabaseAccess } from "@amp/backend/db";
import { v3Item, v3Snapshot } from "../packages/backend/src/publication/v3.ts";
import { v3Events } from "../packages/backend/src/publication/v3-collections.ts";
import { selectedSnapshot } from "../packages/backend/src/publication/v1.ts";
import { installTestConnections } from "./direct-db-fixture.ts";

const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "4" }, () => {});
const db = access.dbFor("worker");
let measuring = false,
  active = 0,
  peak = 0,
  coverageReads = 0;
const counted = new Proxy(db, {
  apply(target, self, args) {
    const text = Array.isArray(args[0]) && Object.hasOwn(args[0], "raw") ? args[0].join("?") : "";
    if (measuring && text.includes("AS manual_revision_label")) peak = Math.max(peak, ++active);
    if (measuring && text.includes("WHERE p.story_id=") && text.includes("p.summary AS machine_summary")) coverageReads++;
    const result = Reflect.apply(target, self, args);
    if (measuring && text.includes("g.jurisdictions FROM publications")) return Promise.resolve(result).finally(() => active--);
    return result;
  },
});
const dispose = installTestConnections(counted);
after(async () => {
  dispose();
  await access.close();
});
const ids = Array.from({ length: 30 }, (_, i) => `v3-bound-${String(i).padStart(2, "0")}`);
before(async () => {
  await db`INSERT INTO sources(id,name,kind,config) VALUES('v3-bound-source','合成来源','rss','{}')`;
  for (let group = 0; group < 2; group++) {
    const [story] = await db`INSERT INTO stories(public_id,title,summary) VALUES(${crypto.randomUUID()},'合成事件','事件摘要') RETURNING id`;
    const [fact] = await db`INSERT INTO facts(public_id,story_id,title) VALUES(${`v3-bound-fact-${group}`},${story!.id},'事件进展') RETURNING id`;
    for (const [index, id] of ids.slice(group * 15, group * 15 + 15).entries()) {
      const at = new Date(Date.now() - (index + 1) * 60000);
      await db`INSERT INTO articles(id,source_id,identity_key,url,title,language,published_at,discovered_at,timeline_at,raw)
        VALUES(${id},'v3-bound-source',${id},${`https://example.invalid/${id}`},'铜矿合成报道','zh',${at},${at},${at},'{}')`;
      await db`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,
          visibility,eligible,selected,selection_candidate,seat,visible_after,story_id,fact_id,tags)
        VALUES(${id},'铜矿合成报道','合成导读','v3-bound-source','news',${`https://example.invalid/${id}`},${at},${at},${at},${at},
          'public',true,true,true,true,${at},${story!.id},${fact!.id},ARRAY['铜'])`;
      await db`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact!.id},${id})`;
      const [seq] = await db`SELECT coalesce(max(seq),0)+1 AS next FROM selected_ledger`;
      await db`INSERT INTO selected_ledger(seq,article_id,op,visible_at) VALUES(${seq!.next},${id},'upsert',${at})`;
      await db`INSERT INTO selected_state(article_id,in_set,last_seq) VALUES(${id},true,${seq!.next})`;
    }
  }
});
async function measure<T>(read: () => Promise<T>) {
  active = peak = coverageReads = 0;
  measuring = true;
  try {
    const value = await read();
    assert.equal(active, 0);
    assert.equal(peak, 4);
    assert.equal(coverageReads, 2, "one coverage read for each event within this request");
    return value;
  } finally {
    measuring = false;
  }
}

test("thirty selected cards keep every field, limit reads to four, and share event coverage only within the request", async () => {
  const before = await selectedSnapshot({ limit: 30, page: null, fields: "default" });
  assert.equal(before.items.length, 30);
  const expected = await Promise.all(before.items.map((item) => v3Item(item.id)));
  const first = await measure(() => v3Snapshot({ limit: 30 }));
  assert.deepEqual(first.items, expected);
  assert.equal(first.count, 30);
  await measure(() => v3Snapshot({ limit: 30 }));
  const events = await measure(() => v3Events({ limit: 30, view: "all" }));
  assert.equal(events.items.length, 2, "nested event lists share the four-detail ceiling");
  await db`UPDATE publications SET visibility='withdrawn' WHERE article_id=${ids[0]!}`;
  const next = await v3Snapshot({ limit: 30 });
  assert.equal(next.count, 29);
  assert.ok(!next.items.some((item) => item?.id === ids[0]));
});
