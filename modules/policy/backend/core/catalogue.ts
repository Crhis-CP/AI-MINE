// Whether the attachment list ("catalogue") of an archived policy original is closed (DEC-79, plan 2.13). Pure and
// deterministic: it decides from facts read when the original is archived and never fetches. Not wired: the legacy
// acquisition (domain/acquire.ts) closes the list only for an HTML or XML page whose source declares an attachment
// selector; a page from a source without one never closes, a PDF original closes only through the vision stage, and an
// edition whose list stays open carries "附件清单尚未完整。". The new write side (modules/policy/backend/pipeline) will
// keep this state beside the revision. It must not re-archive an original to change its manifest's catalogueClosed flag:
// a changed manifest hash makes a new revision (core/originals.ts), so every document would gain a false revision.
// Using the state in publication is a later, reader-visible step.

export type CatalogueState =
  | { closed: true; basis: "no_attachments_declared" | "all_links_listed" | "pdf_without_embedded_files" }
  | { closed: false; reason: "original_missing" | "pdf_embeds_files" | "body_unreadable" | "list_unreadable" | "body_names_unlisted_annex" };

export interface CatalogueFacts {
  /**
   * The archived main resource: `missing` when it was not acquired; `pdf` when its bytes start with `%PDF-` (as the
   * extractor decides); otherwise `page`, read as HTML or XML.
   */
  original: "missing" | "pdf" | "page";
  /** Files embedded in a PDF original; not used for a page. */
  embeddedFiles: number;
  /** The source profile's attachment selector; null when the source declares no attachment list. */
  attachmentSelector: string | null;
  /** Labels of the links the selector matched; null when the list could not be read. Not used without a selector. */
  linkedLabels: readonly string[] | null;
  /**
   * Labels of the annexes the page's body names (by the source's reference pattern, or the annex headings
   * core/provisions recognises); null when the body could not be read, including a format that is neither HTML nor XML.
   */
  bodyAnnexLabels: readonly string[] | null;
}

/** Labels compare after Unicode compatibility folding (附件１ = 附件1, Ⅰ = I), with white space collapsed and in lower case. */
const label = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * The state of an original's attachment list:
 * - a PDF is closed when it embeds no file, open while it embeds any (they are not processed one by one);
 * - a page whose source declares no list is closed when its body names no annex;
 * - a page whose source declares a list is closed when every annex the body names is among the list's links;
 * - an original that was not acquired, a body or list that could not be read, or an annex the body names without a
 *   listed link leaves it open, with the reason. An annex named without a readable label cannot match any link, so it
 *   keeps the list open too, as the legacy acquisition did.
 * A missing decisive attachment is not decided here: the attachment's own resource state says it.
 */
export function catalogueState(facts: CatalogueFacts): CatalogueState {
  if (!Number.isSafeInteger(facts.embeddedFiles) || facts.embeddedFiles < 0)
    throw new RangeError(`embeddedFiles must be a whole number, got ${facts.embeddedFiles}`);
  if (facts.original === "missing") return { closed: false, reason: "original_missing" };
  if (facts.original === "pdf")
    return facts.embeddedFiles > 0 ? { closed: false, reason: "pdf_embeds_files" } : { closed: true, basis: "pdf_without_embedded_files" };
  if (facts.bodyAnnexLabels === null) return { closed: false, reason: "body_unreadable" };
  // An annex named without a readable label folds to "" and stays in the list: no link can match it.
  const named = facts.bodyAnnexLabels.map(label);
  if (facts.attachmentSelector === null)
    return named.length ? { closed: false, reason: "body_names_unlisted_annex" } : { closed: true, basis: "no_attachments_declared" };
  if (facts.linkedLabels === null) return { closed: false, reason: "list_unreadable" };
  // A link without text names no annex, so it cannot stand in for an annex named without a label.
  const linked = new Set(facts.linkedLabels.map(label).filter(Boolean));
  return named.every((value) => linked.has(value)) ? { closed: true, basis: "all_links_listed" } : { closed: false, reason: "body_names_unlisted_annex" };
}
