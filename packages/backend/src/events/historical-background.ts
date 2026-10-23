import { HistoricalCandidateRequest, HistoricalBackgroundConfirmation } from "@amp/contracts/site";
import { lockNewsModelMaterials } from "@amp/backend/content/materials";
import { readHistoricalBackgroundCandidates, lockReportPublications } from "@amp/backend/publication/publish";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { assertRuntimeControl, requireRuntimeRunning } from "../operations/lane-controls.ts";
import { lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { sourceParticipants } from "../sources/participants.ts";
import { relationInput } from "./group.ts";
import { PAIR_SYSTEM, PairSchema, RELATE_PROMPT_VERSION, firmlyTied, pairUser, type ReportView } from "./relate.ts";
import { historicalSnapshot, projectHistoricalBackgrounds, HistoricalBackgroundSuperseded } from "./historical-background-store.ts";

/** One bounded query. History is evidence only: this path never creates a fact, signal, pick or notification. */
export async function confirmHistoricalBackground(input: HistoricalCandidateRequest) {
  const request = HistoricalCandidateRequest.parse(input);
  const control = await requireRuntimeRunning("news", ["processing", "publication"]);
  const query = (await historicalSnapshot([request.query.articleId]))[0]!;
  const storyPublicId = query.memberships[0]?.public_id;
  const result = { examined: 0, linked: 0, unrelated: 0, incomplete: 0 };
  if (!storyPublicId) return result;
  for (const candidate of await readHistoricalBackgroundCandidates(request)) {
    const ids = [request.query.articleId, candidate.binding.articleId];
    const before = await historicalSnapshot(ids);
    if (stableJson(before.map((row) => row.binding)) !== stableJson([request.query, candidate.binding]))
      throw new HistoricalBackgroundSuperseded("历史背景候选版本已变化");
    const check = async (db: Db = sql) => {
      if (stableJson(await historicalSnapshot(ids, db)) !== stableJson(before)) throw new HistoricalBackgroundSuperseded("历史背景输入或人工归属已变化");
    };
    const sources = await sourceParticipants(before.map((r) => r.original.source_id));
    const reports: ReportView[] = before.map(({ original }) => ({
      articleId: original.id,
      revision: original.revision,
      title: original.original_text.split("\n")[0]!,
      source: sources.find((s) => s.id === original.source_id)?.name ?? original.source_id,
      firstParty: false,
      at: original.published_at,
      summary: null,
    }));
    // The frozen public bindings above replace selected-only reading context; neither report claims selected coverage.
    const prepared = await relationInput(
      reports,
      PAIR_SYSTEM,
      () => pairUser(reports[0]!, reports[1]!),
      () => check(),
    );
    const model = await modelFor("groupReview");
    const answer = await chatJson({
      model,
      lane: "news",
      purpose: "group_review",
      subject: `article:${ids[0]}@${request.query.materialRevision}`,
      promptVersion: RELATE_PROMPT_VERSION,
      system: PAIR_SYSTEM,
      ...prepared,
      schema: PairSchema,
      temperature: 0,
      maxTokens: 2560,
      maxPhysicalAttempts: 1,
      runtimeControl: control,
    });
    result.examined++;
    const evidence = answer.data.evidence;
    const queryAnchor = evidence && request.anchors.find((a) => evidence.queryQuote.includes(a.text) && before[0]!.original.original_text.includes(a.quote));
    const candidateAnchor =
      evidence &&
      candidate.anchors.find(
        (a) => a.kind === queryAnchor?.kind && evidence.candidateQuote.includes(a.text) && before[1]!.original.original_text.includes(a.quote),
      );
    const anchorKey = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const valid =
      evidence &&
      queryAnchor &&
      candidateAnchor &&
      anchorKey(queryAnchor.text) === anchorKey(candidateAnchor.text) &&
      [queryAnchor.text, candidateAnchor.text].includes(evidence.anchor) &&
      before[0]!.original.original_text.includes(evidence.queryQuote) &&
      before[1]!.original.original_text.includes(evidence.candidateQuote) &&
      evidence.queryQuote.includes(evidence.queryAction) &&
      evidence.candidateQuote.includes(evidence.candidateAction) &&
      (answer.data.relation !== "SAME_STORY" || !!evidence.change.trim()) &&
      (answer.data.relation !== "SAME_OCCURRENCE" ||
        evidence.queryStage === "other" ||
        evidence.candidateStage === "other" ||
        evidence.queryStage === evidence.candidateStage);
    if (!firmlyTied(answer.data.relation, answer.data.confidence) || !valid) {
      if (["UNRELATED", "ROUNDUP"].includes(answer.data.relation)) result.unrelated++;
      else result.incomplete++;
      await sql.begin((tx) => completeReceipt(tx, answer.receiptId));
      continue;
    }
    const proof = HistoricalBackgroundConfirmation.parse({
      lane: "news",
      query: request.query,
      candidate: candidate.binding,
      relation: answer.data.relation,
      queryAnchor: { ...queryAnchor, quote: evidence.queryQuote },
      candidateAnchor: { ...candidateAnchor, quote: evidence.candidateQuote },
      receiptId: answer.receiptId,
      inputHash: sha256(stableJson({ model, system: PAIR_SYSTEM, user: prepared.user, query: request.query, candidate: candidate.binding })),
    });
    const id = sha256(stableJson([storyPublicId, proof.inputHash, proof.receiptId]));
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      await lockNewsProcessingPermissions(ids, tx);
      await lockNewsModelMaterials(ids, tx);
      await lockReportPublications(ids, tx);
      await check(tx);
      await assertRuntimeControl(tx, control);
      await tx`UPDATE events.story_background_proofs SET active=false WHERE active AND story_public_id=${storyPublicId} AND query_id=${ids[0]} AND candidate_id=${ids[1]} AND id<>${id}`;
      await tx`INSERT INTO events.story_background_proofs(id,story_public_id,query_id,candidate_id,proof) VALUES(${id},${storyPublicId},${ids[0]},${ids[1]},${tx.json(proof)})
        ON CONFLICT(id) DO UPDATE SET active=true`;
      await projectHistoricalBackgrounds(storyPublicId, tx);
      await completeReceipt(tx, answer.receiptId);
    });
    result.linked++;
  }
  return result;
}
