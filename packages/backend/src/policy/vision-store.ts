import { dbOf } from "../db.ts";
import { withCurrentPolicyOriginal, type OriginalRun } from "./fulltext-store.ts";
import { settlePolicyResponse } from "../providers/receipts.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import type { ExtractionProfile } from "./extraction.ts";
import type { RenderedPdf } from "./vision-render.ts";

const sql = dbOf("policy");
export type VisionRun = OriginalRun & { id: string; recipe: string; profile: ExtractionProfile; pdfs: RenderedPdf[]; renderHash: string };
export type VisionCheckpoint = {
  stage_id: string;
  input_hash: string;
  status: "accepted" | "rejected";
  result: unknown;
  receipt_id: number;
  attempt_id: string;
};
const manifest = (pdfs: RenderedPdf[]) => pdfs.map((pdf) => ({ ...pdf, pages: pdf.pages.map(({ png: _, ...page }) => page) }));
export async function createVisionRun(run: Omit<VisionRun, "renderHash">): Promise<VisionRun> {
  const rendered = manifest(run.pdfs),
    renderHash = sha256(stableJson(rendered));
  await withCurrentPolicyOriginal(run, async (tx) => {
    await tx`INSERT INTO policy.vision_runs(id,expression_id,revision_id,control_version,permission_version,recipe,profile_hash,profile,render_manifest,render_hash)
      VALUES(${run.id},${run.expressionId},${run.snapshot.revisionId},${run.controlVersion},${run.snapshot.permissionVersion},${run.recipe},${sha256(stableJson(run.profile))},${tx.json({ ...run.profile })},${tx.json(rendered)},${renderHash}) ON CONFLICT DO NOTHING`;
    for (const page of run.pdfs.flatMap((pdf) => pdf.pages))
      await tx`INSERT INTO policy.vision_pages(run_id,location_id,image_hash,image_bytes)
      VALUES(${run.id},${page.locationId},${page.imageHash},${Buffer.from(page.png)}) ON CONFLICT DO NOTHING`;
  });
  return { ...run, renderHash };
}
export async function storedVisionRun(ref: OriginalRun, id: string, recipe: string, profile: ExtractionProfile): Promise<VisionRun | null> {
  return withCurrentPolicyOriginal(ref, async (tx) => {
    const [row] = await tx`SELECT * FROM policy.vision_runs WHERE id=${id}`;
    if (!row) return null;
    if (
      row.expression_id !== ref.expressionId ||
      row.revision_id !== ref.snapshot.revisionId ||
      row.control_version !== ref.controlVersion ||
      row.permission_version !== ref.snapshot.permissionVersion ||
      row.recipe !== recipe ||
      row.profile_hash !== sha256(stableJson(profile))
    )
      throw new Error("vision_run_identity_mismatch");
    if (sha256(stableJson(row.render_manifest)) !== row.render_hash) throw new Error("vision_render_manifest_changed");
    const images = await tx<
      { location_id: string; image_hash: string; image_bytes: Buffer }[]
    >`SELECT location_id,image_hash,image_bytes FROM policy.vision_pages WHERE run_id=${id}`;
    const pdfs = row.render_manifest as RenderedPdf[];
    if (images.length !== pdfs.reduce((sum, pdf) => sum + pdf.pages.length, 0)) throw new Error("vision_render_page_missing");
    for (const pdf of pdfs) {
      const original = ref.snapshot.resources.find((r) => r.url === pdf.url);
      if (
        original?.sha256 !== pdf.hash ||
        pdf.pages.length !== pdf.pages[0]?.totalPages ||
        pdf.pages.some((p, i) => p.page !== i + 1 || p.resourceHash !== pdf.hash)
      )
        throw new Error("vision_pdf_manifest_changed");
      for (const page of pdf.pages) {
        const image = images.find((i) => i.location_id === page.locationId);
        if (!image || image.image_hash !== page.imageHash || sha256(image.image_bytes) !== page.imageHash || image.image_bytes.length !== page.byteLength)
          throw new Error("vision_page_bytes_changed");
        page.png = Uint8Array.from(image.image_bytes);
      }
    }
    return { ...ref, id, recipe, profile, pdfs, renderHash: row.render_hash };
  });
}
export async function visionCheckpoints(run: VisionRun) {
  return withCurrentPolicyOriginal(
    run,
    (tx) => tx<VisionCheckpoint[]>`SELECT stage_id,input_hash,status,result,receipt_id,attempt_id FROM policy.vision_stages WHERE run_id=${run.id}`,
  );
}
export async function saveVisionStage(run: VisionRun, point: Omit<VisionCheckpoint, "status">, accepted: boolean) {
  return withCurrentPolicyOriginal(run, async (tx) => {
    const settled = await settlePolicyResponse(tx, { receiptId: point.receipt_id, attemptId: point.attempt_id }, accepted);
    if (!settled?.knownUsage) return false;
    await tx`INSERT INTO policy.vision_stages(run_id,stage_id,input_hash,status,result,receipt_id,attempt_id)
      VALUES(${run.id},${point.stage_id},${point.input_hash},${accepted ? "accepted" : "rejected"},${tx.json(point.result as never)},${point.receipt_id},${point.attempt_id}) ON CONFLICT DO NOTHING`;
    return true;
  });
}
export async function finishVision(run: VisionRun, output: Record<string, unknown>) {
  const contentHash = sha256(stableJson(output));
  await withCurrentPolicyOriginal(run, async (tx) => {
    await tx`UPDATE policy.vision_runs SET status=${String(output.status)},output=${tx.json(output as never)},content_hash=${contentHash},updated_at=now() WHERE id=${run.id}`;
  });
  return contentHash;
}
export async function visionRunReference(id: string) {
  const [row] = await sql<{ expression_id: string; profile: ExtractionProfile }[]>`SELECT expression_id,profile FROM policy.vision_runs WHERE id=${id}`;
  return row ?? null;
}
