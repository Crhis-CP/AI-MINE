import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import type { PageImage } from "./vision-render.ts";
import type { OriginalNode } from "./extraction.ts";

const text = z
    .string()
    .max(200_000)
    .refine((s) => s.isWellFormed() && !/[\0\uFFFD]/.test(s)),
  id = text.refine((s) => s.trim().length > 0),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  box = z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
    .refine(([x1, y1, x2, y2]) => x1 < x2 && y1 < y2);
const cell = z.strictObject({
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  rowspan: z.number().int().positive(),
  colspan: z.number().int().positive(),
  header: z.boolean(),
  text,
  bbox: box,
});
const block = z.strictObject({
  id,
  kind: z.enum(["paragraph", "table", "figure", "header", "footer"]),
  bbox: box,
  text,
  text_item_ids: z.array(id),
  rows: z.number().int().min(0).max(1000),
  cols: z.number().int().min(0).max(64),
  cells: z.array(cell).max(10000),
  continues_from_previous: z.boolean(),
  continues_on_next: z.boolean(),
});
const attachment = z.strictObject({
  label: id,
  kind: z.enum(["internal", "external", "unresolved"]),
  url: z.url().nullable(),
  pages: z.array(z.number().int().positive()),
});
export const VisionPageReply = z.strictObject({
  location_id: id,
  image_hash: hash,
  confidence: z.number().min(0).max(1),
  blank: z.boolean(),
  blocks: z.array(block).max(2000),
  images: z.array(z.strictObject({ location_id: id, block_ids: z.array(id), decorative: z.boolean(), reason: id })),
  links: z.array(z.strictObject({ link_id: id, role: z.enum(["citation", "attachment"]) })),
  attachments: z.array(attachment),
  unreadable_flags: z.array(id),
});
export type VisionPageCandidate = z.infer<typeof VisionPageReply>;
export const VisionPageVerification = z.strictObject({
  location_id: id,
  image_hash: hash,
  candidate_hash: hash,
  page_ids: z.array(id),
  complete: z.boolean(),
  blank_confirmed: z.boolean(),
  reading_order_exact: z.boolean(),
  catalogue_complete: z.boolean(),
  image_ids: z.array(id),
  text_item_ids: z.array(id),
  link_ids: z.array(id),
  checks: z.array(
    z.strictObject({
      block_id: id,
      text_exact: z.boolean(),
      numbers_exact: z.boolean(),
      layout_exact: z.boolean(),
      table_grid_exact: z.boolean(),
      figure_exact: z.boolean(),
    }),
  ),
  previous_join: z.enum(["none", "verified", "unresolved"]),
  next_join: z.enum(["none", "verified", "unresolved"]),
  unreadable_flags: z.array(id),
});
export type VisionVerification = z.infer<typeof VisionPageVerification>;
export const exactSet = (actual: string[], expected: string[]) =>
  actual.length === expected.length && new Set(actual).size === actual.length && actual.every((id) => expected.includes(id));
const compact = (s: string) => s.replace(/\s/gu, "");
const numeric = (s: string) => s.match(/[+−-]?\p{N}+(?:[.,:/-]\p{N}+)*(?:[eE][+-]?\p{N}+)?/gu) ?? [];
const blockText = (b: VisionPageCandidate["blocks"][number]) => (b.kind === "table" ? b.cells.map((c) => c.text).join(" ") : b.text);
function assert(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

export function checkVisionPage(page: PageImage, value: unknown) {
  const result = VisionPageReply.parse(value);
  assert(result.location_id === page.locationId && result.image_hash === page.imageHash, "page_identity_mismatch");
  assert(new Set(result.blocks.map((b) => b.id)).size === result.blocks.length, "duplicate_block_id");
  assert(result.blank === (result.blocks.length === 0), "blank_block_mismatch");
  assert(
    exactSet(
      result.blocks.flatMap((b) => b.text_item_ids),
      page.textItems.map((i) => i.id),
    ),
    "text_item_coverage",
  );
  assert(
    exactSet(
      result.images.map((i) => i.location_id),
      page.imageLocations.map((i) => i.id),
    ),
    "image_location_coverage",
  );
  assert(
    exactSet(
      result.links.map((i) => i.link_id),
      page.links.map((i) => i.id),
    ),
    "link_coverage",
  );
  for (const image of result.images) {
    assert(image.decorative ? image.block_ids.length === 0 : image.block_ids.length > 0, "image_content_unaccounted");
    assert(
      new Set(image.block_ids).size === image.block_ids.length && image.block_ids.every((id) => result.blocks.some((b) => b.id === id)),
      "image_block_mismatch",
    );
  }
  for (const b of result.blocks) {
    const [x1, y1, x2, y2] = b.bbox,
      grid = new Set<string>();
    if (b.kind === "table") {
      assert(b.text === "" && b.rows > 0 && b.cols > 0, "invalid_table_dimensions");
      for (const c of b.cells) {
        assert(
          c.row + c.rowspan <= b.rows && c.col + c.colspan <= b.cols && c.bbox[0] >= x1 && c.bbox[1] >= y1 && c.bbox[2] <= x2 && c.bbox[3] <= y2,
          "cell_outside_table",
        );
        for (let r = c.row; r < c.row + c.rowspan; r++)
          for (let col = c.col; col < c.col + c.colspan; col++) {
            const key = `${r}:${col}`;
            assert(!grid.has(key), "overlapping_table_cells");
            grid.add(key);
          }
      }
      assert(grid.size === b.rows * b.cols, "missing_table_cells");
      assert(
        b.cells.every((c, i, a) => i === 0 || a[i - 1]!.row < c.row || (a[i - 1]!.row === c.row && a[i - 1]!.col < c.col)),
        "table_cell_order",
      );
    } else assert(b.rows === 0 && b.cols === 0 && b.cells.length === 0 && b.text.trim(), "non_table_structure");
    const actual = compact(blockText(b));
    for (const itemId of b.text_item_ids) assert(actual.includes(compact(page.textItems.find((i) => i.id === itemId)!.text)), "text_layer_changed");
  }
  if (page.textItems.length && !page.imageLocations.length) {
    const source = page.textItems.map((i) => i.text).join(" "),
      target = result.blocks.map(blockText).join(" ");
    assert(stableJson(numeric(source).sort()) === stableJson(numeric(target).sort()), "numeric_layer_changed");
    assert([...compact(source)].sort().join("") === [...compact(target)].sort().join(""), "text_layer_content_changed");
  }
  for (const a of result.attachments) {
    assert(a.kind !== "internal" || (a.url === null && a.pages.length > 0 && a.pages.every((p) => p <= page.totalPages)), "internal_attachment_location");
    if (a.kind === "external")
      assert(
        a.url && a.pages.length === 0 && (page.links.some((l) => l.url === a.url) || result.blocks.some((b) => blockText(b).includes(a.url!))),
        "attachment_url_not_in_input",
      );
  }
  for (const link of result.links.filter((l) => l.role === "attachment"))
    assert(
      result.attachments.some((a) => a.url === page.links.find((l) => l.id === link.link_id)!.url),
      "attachment_link_unaccounted",
    );
  return result;
}

export function checkVisionVerification(page: PageImage, candidate: VisionPageCandidate, neighbors: PageImage[], value: unknown) {
  const result = VisionPageVerification.parse(value);
  assert(
    result.location_id === page.locationId && result.image_hash === page.imageHash && result.candidate_hash === sha256(stableJson(candidate)),
    "verification_identity_mismatch",
  );
  assert(
    exactSet(
      result.page_ids,
      neighbors.map((p) => p.locationId),
    ) &&
      exactSet(
        result.image_ids,
        page.imageLocations.map((i) => i.id),
      ) &&
      exactSet(
        result.text_item_ids,
        page.textItems.map((i) => i.id),
      ) &&
      exactSet(
        result.link_ids,
        page.links.map((i) => i.id),
      ),
    "verification_input_coverage",
  );
  assert(
    exactSet(
      result.checks.map((c) => c.block_id),
      candidate.blocks.map((b) => b.id),
    ),
    "verification_block_coverage",
  );
  return result;
}
export function visionPageGaps(page: PageImage, candidate: VisionPageCandidate, verification: VisionVerification) {
  const gaps = [...page.gaps, ...candidate.unreadable_flags, ...verification.unreadable_flags];
  if (!verification.complete || !verification.reading_order_exact || !verification.catalogue_complete || verification.blank_confirmed !== candidate.blank)
    gaps.push("page_not_fully_verified");
  for (const check of verification.checks)
    if (!check.text_exact || !check.numbers_exact || !check.layout_exact || !check.table_grid_exact || !check.figure_exact)
      gaps.push(`block_unverified:${check.block_id}`);
  const first = candidate.blocks[0],
    last = candidate.blocks.at(-1);
  if (
    verification.previous_join !== (first?.continues_from_previous ? "verified" : "none") ||
    verification.next_join !== (last?.continues_on_next ? "verified" : "none")
  )
    gaps.push("cross_page_relation_unverified");
  if (candidate.blocks.slice(1).some((b) => b.continues_from_previous) || candidate.blocks.slice(0, -1).some((b) => b.continues_on_next))
    gaps.push("non_boundary_continuation");
  return gaps;
}
const escaped = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function tableHtml(b: VisionPageCandidate["blocks"][number]) {
  const rows = Array.from(
    { length: b.rows },
    (_, row) =>
      `<tr>${b.cells
        .filter((c) => c.row === row)
        .map((c) => `<${c.header ? "th" : "td"} rowspan="${c.rowspan}" colspan="${c.colspan}">${escaped(c.text)}</${c.header ? "th" : "td"}>`)
        .join("")}</tr>`,
  );
  // Only a complete leading header band is repeated by the fulltext table planner.
  let headerRows = 0;
  while (
    headerRows < b.rows &&
    b.cells.some((c) => c.row === headerRows) &&
    b.cells.filter((c) => c.row <= headerRows && c.row + c.rowspan > headerRows).every((c) => c.header)
  )
    headerRows++;
  if (b.cells.some((c) => c.row < headerRows && c.row + c.rowspan > headerRows)) headerRows = 0;
  return `<table>${headerRows ? `<thead>${rows.slice(0, headerRows).join("")}</thead>` : ""}<tbody>${rows.slice(headerRows).join("")}</tbody></table>`;
}
/** Cross-page joins are explicit, verified on both sides, and never inferred from adjacent strings. */
export function assembleVisionNodes(pages: { image: PageImage; candidate: VisionPageCandidate; verification: VisionVerification }[]) {
  const nodes: OriginalNode[] = [],
    gaps: string[] = [];
  let pending: { block: VisionPageCandidate["blocks"][number]; page: number; pages: number[]; locations: NonNullable<OriginalNode["visualLocations"]> } | null =
    null;
  const emit = () => {
    if (!pending) return;
    const b = pending.block,
      html = b.kind === "table" ? tableHtml(b) : `<p>${escaped(b.text)}</p>`;
    const ordinal = nodes.length;
    nodes.push({
      id: sha256(stableJson([pages[0]!.image.resourceHash, pending.pages, b])),
      ordinal,
      text: blockText(b),
      html,
      page: pending.page,
      visualLocations: pending.locations,
      selector: `pdf:pages:${pending.pages.join(",")}`,
    });
    pending = null;
  };
  for (const { image, candidate, verification } of pages) {
    gaps.push(...visionPageGaps(image, candidate, verification).map((g) => `${image.page}:${g}`));
    for (const b0 of candidate.blocks) {
      const b = structuredClone(b0);
      if (b.continues_from_previous) {
        if (!pending?.block.continues_on_next || pending.pages.at(-1)! + 1 !== image.page || pending.block.kind !== b.kind) {
          gaps.push("cross_page_join_missing");
          emit();
        } else if (b.kind === "table") {
          const old = pending.block,
            oldHeaders = old.cells.filter((c) => c.header),
            newHeaders = b.cells.filter((c) => c.header),
            signature = (cells: typeof oldHeaders) => stableJson(cells.map(({ row, col, rowspan, colspan, text }) => ({ row, col, rowspan, colspan, text })));
          if (old.cols !== b.cols || signature(oldHeaders) !== signature(newHeaders)) {
            gaps.push("cross_page_table_header_changed");
            emit();
          } else {
            const headerRows = newHeaders.length ? Math.max(...newHeaders.map((c) => c.row + c.rowspan)) : 0;
            if (b.cells.some((c) => !c.header && c.row < headerRows)) {
              gaps.push("cross_page_table_header_ambiguous");
              emit();
            } else {
              old.cells.push(...b.cells.filter((c) => !c.header).map((c) => ({ ...c, row: c.row - headerRows + old.rows })));
              old.rows += b.rows - headerRows;
              old.continues_on_next = b.continues_on_next;
              pending.pages.push(image.page);
              pending.locations.push({ page: image.page, bbox: [...b.bbox], imageHash: image.imageHash });
            }
          }
        } else {
          pending.block.text += `\n${b.text}`;
          pending.block.continues_on_next = b.continues_on_next;
          pending.pages.push(image.page);
          pending.locations.push({ page: image.page, bbox: [...b.bbox], imageHash: image.imageHash });
        }
      } else {
        if (pending?.block.continues_on_next) gaps.push("cross_page_join_missing");
        emit();
      }
      if (!pending)
        pending = { block: b, page: image.page, pages: [image.page], locations: [{ page: image.page, bbox: [...b.bbox], imageHash: image.imageHash }] };
      if (!b.continues_on_next) emit();
    }
    if (candidate.blank && pending) gaps.push("continuation_across_blank_page");
  }
  if (pending?.block.continues_on_next) gaps.push("document_tail_continuation_missing");
  emit();
  return { nodes, gaps };
}
