import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { acquirePolicyOriginal } from "../modules/policy/backend/domain/acquire.ts";
import { extractPolicyOriginal } from "../modules/policy/backend/domain/extraction.ts";
import { buildPolicyFulltextPlan } from "../modules/policy/backend/domain/processing-plan.ts";
import { readingBlock } from "../modules/policy/backend/publication/policies-project.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
const manifest = JSON.parse(readFileSync("tests/fixtures/policy/official-xml/manifest.json", "utf8"));
const profile = { bodySelector: "Regulation", attachmentSelector: "Attachment", maxBytes: 100000, maxResources: 2, maxPages: 1, maxTextBytes: 100000 };
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
for (const name of ["provisions", "table"])
  test(`recorded official Justice Canada ${name} XML preserves dates, structure and exact text`, async () => {
    const file = `ca-sor-2002-222-${name}.xml`,
      bytes = readFileSync(`tests/fixtures/policy/official-xml/${file}`),
      xml = bytes.toString();
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.fragments.find((f: { file: string }) => f.file === file).sha256);
    const sourceId = `recorded-ca-${name}`;
    await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Recorded official XML excerpt; not a live source','external','policy')`;
    await grantDateFixture(sourceId, [manifest.source_url]);
    const acquired = await acquirePolicyOriginal(
      {
        sourceId,
        permissionVersion: 1,
        identity: {
          jurisdiction: "CA",
          authority: "Department of Justice Canada",
          documentType: "regulation",
          documentNumber: `SOR/2002-222 recorded excerpt ${name}`,
          officialUrl: manifest.source_url,
        },
        language: "en",
        kind: "original",
        officialTitle: "Recorded excerpt of Metal and Diamond Mining Effluent Regulations — not complete or official",
        versionKey: "recorded-XML-pit-2026-06-04",
        expectedHead: null,
      },
      profile,
      async (url) => ({ url, status: 200, headers: new Headers({ "content-type": "text/xml" }), body: bytes, text: () => xml }),
    );
    const extracted = await extractPolicyOriginal(acquired.expressionId, profile);
    assert.equal(extracted.state, "extracted", JSON.stringify(extracted.gaps));
    const nodes = extracted.resources[0]!.nodes;
    assert.equal(
      normalized(nodes.map((n) => n.text).join("")),
      normalized(xml.replace(/<[^>]*>/g, "")),
      "The recorded excerpt's original text is conserved exactly; no whole-law completeness claim",
    );
    const annotations = nodes.flatMap((n) => n.annotations ?? []);
    for (const [attribute, value] of [
      ["lims:pit-date", "2026-06-04"],
      ["lims:current-date", "2026-06-14"],
      ["lims:lastAmendedDate", "2026-06-04"],
    ])
      assert.ok(
        annotations.some((a) => a.name === attribute && a.value === value && a.scope === "ancestor" && a.locator.includes("/Regulation[1]/@")),
        attribute,
      );
    const html = nodes.map((n) => n.html).join("");
    assert.equal((html.match(/<sup>/g) ?? []).length, (xml.match(/<Sup>/g) ?? []).length);
    assert.equal((html.match(/<del>/g) ?? []).length, (xml.match(/<Repealed>/g) ?? []).length);
    if (name === "provisions") {
      assert.match(html, /<span>2<\/span>/);
      assert.match(html, /<span>29<\/span>/);
      assert.ok(annotations.some((a) => a.name === "lims:inforce-start-date" && a.scope === "self"));
    } else {
      assert.equal((html.match(/<tr>/g) ?? []).length, 14);
      assert.match(xml, /cols="13"/);
      assert.match(xml, /colname="COLSPEC0"/);
      assert.match(html, /colspan="13"/);
    }
    const plan = buildPolicyFulltextPlan(extracted, {
      sourceId,
      expressionId: acquired.expressionId,
      language: "en",
      identityHash: "1".repeat(64),
      recipeVersion: "recorded-official-XML-test",
    });
    assert.equal(plan.status, "planned", plan.status === "planned" ? undefined : plan.gaps.join(";"));
    if (plan.status !== "planned") return;
    assert.ok(plan.parts.every((p) => p.annotations?.some((a) => a.name === "lims:pit-date")));
    const blocks = plan.parts.map((p, i) => readingBlock(`recorded-${i}`, p.source, p.format, manifest.source_url, []));
    assert.equal(
      blocks
        .map((b) => b.semantic_html ?? "")
        .join("")
        .includes("<sup>"),
      true,
    );
    if (name === "table") assert.ok(blocks.some((b) => b.semantic_html?.includes('colspan="13"')));
  });

test("an unresolved CALS column in a deliberately corrupted recording cannot become a complete legal table", async () => {
  const sourceId = "recorded-ca-corrupted-table";
  const xml = readFileSync("tests/fixtures/policy/official-xml/ca-sor-2002-222-table.xml", "utf8").replace('nameend="col12"', 'nameend="missing-column"');
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Deliberately corrupted recorded fixture','external','policy')`;
  await grantDateFixture(sourceId, [manifest.source_url]);
  const acquired = await acquirePolicyOriginal(
    {
      sourceId,
      permissionVersion: 1,
      identity: {
        jurisdiction: "CA",
        authority: sourceId,
        documentType: "regulation",
        documentNumber: "corrupted-recording",
        officialUrl: manifest.source_url,
      },
      language: "en",
      kind: "original",
      officialTitle: "Deliberately corrupted recording; not official",
      versionKey: null,
      expectedHead: null,
    },
    profile,
    async (url) => ({ url, status: 200, headers: new Headers({ "content-type": "text/xml" }), body: Buffer.from(xml), text: () => xml }),
  );
  const extracted = await extractPolicyOriginal(acquired.expressionId, profile);
  assert.equal(extracted.state, "incomplete");
  assert.deepEqual(extracted.resources[0]!.nodes, []);
  assert.ok(extracted.resources[0]!.gaps.some((gap) => gap.includes("结构解析失败")));
});
