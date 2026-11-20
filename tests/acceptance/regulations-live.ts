// The policy line as it runs today, behind the abilities the regulations cases ask for (ruleset `live`). It calls the
// production functions and changes none of them. Two of the live rules sit inside functions that read and write the
// database, with no pure piece to call alone, so this adapter needs the throwaway test database (tests/setup.ts):
// - the attachment list: domain/acquire.ts sets the archived manifest's catalogueClosed only for an HTML or XML page
//   whose source declares an attachment selector; publication/policies-publish.ts turns a false flag into the gap
//   "附件清单尚未完整。". The adapter archives the original with acquirePolicyOriginal and reads that flag; it does not
//   run the publication;
// - the PDF: domain/extraction.ts (parseResource, not exported) marks every PDF resource incomplete, which sends it to
//   the vision stage or to a person (domain/automation.ts). The adapter runs extractPolicyOriginal on the archived
//   original and reads the resource's state and gaps.
// Fetches go to a stub that serves only the fixture's address; there is no network and no model call. The public
// record is pure: the same projection the publication builds for a basic-facts edition (basicPolicy, then
// withInstrumentFacts with the instrument gate and the Argentine procedure read from the text), without the parts that
// need the database (public ids, permissions, the attachment inventory, cited relations, reading streams), none of
// which sets the title, the summary, the applicability line or the dates the case reads.
import { sql } from "@amp/backend/db";
import { normalizeSourceTime, SourceDateEvidence } from "@amp/contracts/time-assertion";
import { classifyInstrument } from "../../modules/policy/backend/core/instrument-gate.ts";
import { readPolicyOriginal } from "../../modules/policy/backend/core/originals.ts";
import type { ExtractionProfile } from "../../modules/policy/backend/core/extraction-parse.ts";
import type { PolicyMetadataObservation } from "../../modules/policy/backend/core/metadata.ts";
import { acquirePolicyOriginal } from "../../modules/policy/backend/domain/acquire.ts";
import { extractPolicyOriginal } from "../../modules/policy/backend/domain/extraction.ts";
import { basicPolicy, type PublicIds, withInstrumentFacts } from "../../modules/policy/backend/publication/policies-project.ts";
import { argentineFacts } from "../../modules/policy/backend/publication/policies-publish.ts";
import { grantDateFixture } from "../source-date-fixture.ts";
import type { InstrumentFixture, OriginalFixture, RegulationsEffects } from "./regulations.ts";

const LIMITS = {
  maxBytes: 100_000,
  maxResources: 10,
  maxPages: 10,
  maxTextBytes: 10_000,
};
const DAY = "2026-11-20";

/** The basic-facts edition the publication projects for an instrument that passed the gate, before any model interpretation. */
export function livePublicRecord(instrument: InstrumentFixture) {
  const gate = classifyInstrument({
    title: instrument.originalTitle,
    number: instrument.documentNumber,
    issuer: instrument.authority,
    excerpt: instrument.text.slice(0, 8000),
    documentType: null,
    language: instrument.language,
    sourceId: instrument.sourceId,
  });
  if (!gate.publishable) return null;
  const at = `${DAY}T03:00:00.000Z`;
  const meta: PolicyMetadataObservation = {
    sourceId: instrument.sourceId,
    expressionId: `${instrument.id}-expression`,
    documentRevisionId: `${instrument.id}-revision`,
    materialId: `${instrument.id}-material`,
    materialRevision: 1,
    originalTitle: instrument.originalTitle,
    documentNumber: instrument.documentNumber,
    authority: instrument.authority,
    jurisdiction: instrument.jurisdiction,
    documentType: null,
    officialUrl: instrument.officialUrl,
    observedAt: at,
    discoveredAt: at,
    // The date the source page gives, as the capture records a parsed source date.
    publicationDate: SourceDateEvidence.parse({
      binding: {
        articleId: `${instrument.id}-material`,
        sourceId: instrument.sourceId,
        revision: 1,
        configHash: "0".repeat(64),
      },
      observationId: `${instrument.id}-date`,
      observedAt: at,
      url: instrument.officialUrl,
      locator: "synthetic",
      excerpt: `Publicada el ${instrument.publishedOn}`,
      origin: "source",
      interpretation: "parsed",
      format: "iso8601",
      formatPattern: null,
      language: null,
      publicationBasis: "source_published",
      instantBasis: null,
      timezoneEvidence: null,
      time: normalizeSourceTime(
        {
          meaning: "published",
          raw: instrument.publishedOn,
          local_date: instrument.publishedOn,
          local_time: null,
          utc: null,
          timezone: null,
          basis: "Synthetic source date",
          condition_text: null,
        },
        { instantBasis: null, timezoneEvidence: null },
      ),
    }),
    // basicPolicy does not read the provenance; the observation's other fields are the ones capture.ts records.
    provenance: {} as PolicyMetadataObservation["provenance"],
  };
  const ids: PublicIds = {
    policy: "pol_acceptance",
    version: "ver_acceptance",
    originalExpression: "exp_original",
    originalRevision: "rev_original",
    translationExpression: "exp_zh",
    translationRevision: "rev_zh",
    authority: "aut_acceptance",
    publisher: "pub_acceptance",
  };
  const basic = basicPolicy(meta, ids, at, 1);
  if (!basic) return null;
  basic.expressions[0]!.language = instrument.language;
  return withInstrumentFacts(basic, {
    gate,
    lifecycle: argentineFacts(meta, instrument.text),
    relationships: [],
    evidence: [],
    today: DAY,
  });
}

/** Archives one original from a stub that serves only its address, then extracts it, as the live write side does. */
async function archive(original: OriginalFixture, serial: number) {
  const sourceId = `acceptance-regulations-${serial}`;
  await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},'Synthetic regulations acceptance','external','policy')`;
  await grantDateFixture(sourceId, [original.url]);
  const profile: ExtractionProfile = {
    bodySelector: original.bodySelector,
    attachmentSelector: original.attachmentSelector,
    ...LIMITS,
  };
  const saved = await acquirePolicyOriginal(
    {
      sourceId,
      permissionVersion: 1,
      identity: {
        jurisdiction: "AR",
        authority: sourceId,
        documentType: "decree",
        documentNumber: null,
        officialUrl: original.url,
      },
      versionKey: null,
      language: "es",
      kind: "original",
      officialTitle: "Synthetic original",
      expectedHead: null,
    },
    profile,
    async (url) => {
      if (url !== original.url) throw new Error(`The stub serves only ${original.url}, not ${url}`);
      const body = Buffer.from(original.body);
      return {
        url,
        status: 200,
        headers: new Headers({ "content-type": original.mediaType }),
        body,
        text: () => body.toString(),
      };
    },
  );
  const snapshot = await readPolicyOriginal(saved.expressionId);
  const extraction = await extractPolicyOriginal(saved.expressionId, profile);
  const resource = extraction.resources.find((r) => r.url === original.url);
  if (!snapshot || !resource) throw new Error(`${original.id} was not archived`);
  return {
    catalogueClosed: snapshot.manifest.catalogueClosed,
    documentGaps: extraction.gaps,
    resource,
  };
}

/** Runs the live write side over the originals once; the effects then answer from those results. Needs the test database. */
export async function liveRegulations(originals: readonly OriginalFixture[]): Promise<RegulationsEffects> {
  const archived = new Map<string, Awaited<ReturnType<typeof archive>>>();
  for (const [i, original] of originals.entries()) archived.set(original.id, await archive(original, i + 1));
  const of = (original: OriginalFixture) => {
    const result = archived.get(original.id);
    if (!result) throw new Error(`the live adapter did not archive ${original.id}`);
    return result;
  };
  return {
    ruleset: "live",
    publicRecord: livePublicRecord,
    attachmentList(original) {
      const { catalogueClosed, documentGaps } = of(original);
      return {
        closed: catalogueClosed,
        why: `archived manifest catalogueClosed=${catalogueClosed}; extraction gaps: ${documentGaps.join("；") || "none"}`,
      };
    },
    pdfText(original) {
      const { resource } = of(original);
      return {
        fromTextLayer: resource.state === "extracted" && resource.nodes.length > 0,
        why: `resource ${resource.state}; gaps: ${resource.gaps.join("；") || "none"}`,
      };
    },
  };
}
