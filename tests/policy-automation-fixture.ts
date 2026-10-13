import { dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import type { PolicyAutomationProfile } from "../packages/backend/src/policy/automation-profile.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("policy"),
  discovered = new Date("2026-01-02T03:04:05Z");
let serial = 0;
export async function fixture() {
  const sourceId = `automation-${++serial}`,
    url = `https://source.invalid/laws/${sourceId}`;
  const fact = (value: string) => ({ value, evidenceUrl: "https://source.invalid/official-catalogue", basis: "Synthetic official register fixture" });
  const profile: PolicyAutomationProfile = {
    version: 1,
    officialRole: {
      kind: "official_original",
      evidenceUrl: "https://source.invalid/official-catalogue",
      basis: "Synthetic formal publication responsibility",
      singleObjectPattern: "^https://source\\.invalid/laws/[^/]+$",
    },
    identityMarker: { selector: ".formal", pattern: "^Official decree$" },
    titleSelector: "h1",
    numberSelector: ".number",
    originalLinkSelector: null,
    versionSelector: null,
    identity: { authority: fact(sourceId), jurisdiction: fact("AR"), documentType: fact("decree") },
    language: "en",
    kind: "original",
    recheckMinutes: 60,
    extraction: { bodySelector: "article", attachmentSelector: "a.attachment", maxBytes: 100000, maxResources: 10, maxPages: 10, maxTextBytes: 100000 },
  };
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${sourceId},'Synthetic only','web_list','policy',true,${sql.json({ policyProfile: profile })})`;
  await grantDateFixture(sourceId, [url]);
  const material = await upsertMaterial({ sourceId, url, title: "Untrusted listing title", via: "fetch", discoveredAt: discovered });
  const materialId = material.articleId;
  let text = "Permit applies at 10 kg.",
    hits = 0;
  const get = async (address: string) => {
    hits++;
    const body = Buffer.from(
      `<html><span class="formal">Official decree</span><span class="number">1/2026</span><h1>Official mining decree</h1><article><p>${text}</p></article></html>`,
    );
    return { status: 200, url: address, headers: new Headers({ "content-type": "text/html;charset=utf-8" }), body, text: () => body.toString() };
  };
  return {
    sourceId,
    url,
    materialId,
    profile,
    get,
    hits: () => hits,
    setText: (value: string) => {
      text = value;
    },
  };
}
