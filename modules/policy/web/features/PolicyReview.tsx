/**
 * The side-by-side review of one document (TASK-0657, Owner 2026-11-13): the interpretation on the left, the text on
 * the right, linked. This file holds what the two sides share: the reading streams (pages of blocks per language),
 * which clause reference points at which loaded block, the highlight, the revision marks and the phone's two tabs.
 * Both columns are rendered on the server; everything here that moves is an enhancement on top of plain anchors.
 */
import { apiFetch } from "@amp/web/extension";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { Policy } from "@amp/contracts/http/public";
import { blockDomId, evidenceBlocks, redlineOf, sourceState, type Comparison, type ReadingBlock, type Redline } from "./review";
import "./policy-review.css";

type Page = ReturnType<typeof publicSchemas.PolicyReadingPage.parse>;
type Expression = Policy["expressions"][number];
export type Stream = { rows: ReadingBlock[]; total: number; next: string | null; loaded: boolean; busy: boolean; error: boolean; complete: boolean };
export const blankStream = (): Stream => ({ rows: [], total: 0, next: null, loaded: false, busy: false, error: false, complete: false });
/** What a reader set on this document and keeps while switching its language: the phone tab and the revision marks. */
export type ReviewView = { pane: "read" | "src"; redline: boolean };

const NO_ROWS: ReadingBlock[] = [];
const sameLanguage = (a: string, b: string) => a.split("-")[0]!.toLowerCase() === b.split("-")[0]!.toLowerCase();

/** The reading streams of one document: the selected language from the server's first page, the others on demand. */
function usePolicyStreams({
  policy,
  history,
  onInvalid,
  initialPage,
  initialFailed,
}: {
  policy: Policy;
  history: boolean;
  onInvalid: () => void;
  initialPage: Page | null;
  initialFailed: boolean;
}) {
  const selected = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  const original =
    selected && selected.kind !== "original"
      ? policy.expressions.find((e) => e.policy_version_id === selected.policy_version_id && e.kind === "original" && e.reading_state === "complete")
      : undefined;
  const [streams, setStreams] = useState<Record<string, Stream>>(() => {
    if (!selected) return {};
    if (
      initialPage &&
      initialPage.subject_id === policy.id &&
      initialPage.expression_id === selected.id &&
      initialPage.document_revision_id === selected.document_revision_id
    )
      return {
        [selected.id]: {
          rows: initialPage.blocks,
          total: initialPage.total_blocks,
          next: initialPage.next_cursor,
          loaded: true,
          busy: false,
          error: false,
          complete: initialPage.resource_completeness === "complete",
        },
      };
    return initialFailed ? { [selected.id]: { ...blankStream(), error: true } } : {};
  });
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const requests = useRef(new Map<string, AbortController>()),
    mounted = useRef(true);
  const update = (id: string, value: Stream) => {
    streamsRef.current = { ...streamsRef.current, [id]: value };
    setStreams(streamsRef.current);
  };
  const load = async (expression: Expression) => {
    const old = streamsRef.current[expression.id] ?? blankStream();
    if (old.busy || (old.loaded && !old.next)) return;
    const controller = new AbortController();
    requests.current.set(expression.id, controller);
    update(expression.id, { ...old, busy: true, error: false });
    try {
      const apiBase = window.location.origin;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      let cursor = old.next ?? (expression.id === selected?.id ? policy.reading?.next_cursor : null);
      if (!old.loaded && expression.id !== selected?.id) {
        const context = await apiFetch("/api/site/policies/{id}", {
          params: {
            path: { id: policy.id },
            query: {
              expression_id: expression.id,
              ...(history ? { policy_version_id: expression.policy_version_id, document_revision_id: expression.document_revision_id } : {}),
            },
          },
          cache: "no-cache",
          signal,
          baseUrl: apiBase,
        });
        if ([404, 409, 410].includes(context.status)) {
          onInvalid();
          return;
        }
        if (!context.ok) throw new Error("unavailable");
        const chosen = publicSchemas.Policy.parse(await context.json());
        if (
          chosen.selected_policy_version_id !== expression.policy_version_id ||
          chosen.reading?.expression_id !== expression.id ||
          chosen.reading.document_revision_id !== expression.document_revision_id
        ) {
          onInvalid();
          return;
        }
        cursor = chosen.reading.next_cursor;
      }
      const result = await apiFetch("/api/site/policies/{id}/reading", {
        params: {
          path: { id: policy.id },
          query: { expression_id: expression.id, document_revision_id: expression.document_revision_id, limit: 20, ...(cursor ? { cursor } : {}) },
        },
        cache: "no-cache",
        signal,
        baseUrl: apiBase,
      });
      if ([404, 409, 410].includes(result.status)) {
        onInvalid();
        return;
      }
      if (!result.ok) throw new Error("unavailable");
      const next = publicSchemas.PolicyReadingPage.parse(await result.json());
      if (next.expression_id !== expression.id || next.document_revision_id !== expression.document_revision_id || next.subject_id !== policy.id) {
        onInvalid();
        return;
      }
      if (!controller.signal.aborted && mounted.current)
        update(expression.id, {
          rows: [...old.rows, ...next.blocks],
          total: next.total_blocks,
          next: next.next_cursor,
          loaded: true,
          busy: false,
          error: false,
          complete: next.resource_completeness === "complete" && (!old.loaded || old.complete),
        });
    } catch {
      if (!controller.signal.aborted && mounted.current) update(expression.id, { ...old, busy: false, error: true });
    } finally {
      if (requests.current.get(expression.id) === controller) requests.current.delete(expression.id);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: The parent keys each reader by immutable expression and revision.
  useEffect(() => {
    mounted.current = true;
    if (selected && !initialFailed && !streamsRef.current[selected.id]?.loaded && ["complete", "partial"].includes(selected.reading_state)) void load(selected);
    return () => {
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
    };
  }, []);
  return { selected, original, streams, load };
}

type Review = ReturnType<typeof usePolicyStreams> & {
  policy: Policy;
  history: boolean;
  comparison: Comparison | null;
  source: ReturnType<typeof sourceState>;
  /** Whether the original is shown under each block of the translation. */
  compare: boolean;
  setCompare: (on: boolean) => void;
  /** The loaded blocks of the selected language that carry any of these evidence ids, as element ids. */
  targets: (evidenceIds: readonly string[]) => string[];
  /** Shows these blocks in the text: scrolls there, highlights them, and on a phone opens the text tab first. */
  go: (elementIds: string[], options?: { redline?: boolean }) => void;
  hover: string | null;
  setHover: (elementId: string | null) => void;
  hit: { ids: string[]; settled: boolean } | null;
  /** The language whose loaded text the comparison can be marked in; undefined when there is none. */
  marked: Expression | undefined;
  redline: Redline | null;
  redlineOn: boolean;
  setRedline: (on: boolean) => void;
  pane: ReviewView["pane"];
  setPane: (pane: ReviewView["pane"]) => void;
};
const ReviewContext = createContext<Review | null>(null);
export function useReview(): Review {
  const review = useContext(ReviewContext);
  if (!review) throw new Error("The review parts render inside PolicyReviewProvider");
  return review;
}

export function PolicyReviewProvider({
  policy,
  history,
  comparison,
  initialPage,
  initialFailed,
  onInvalid,
  view,
  onView,
  children,
}: {
  policy: Policy;
  history: boolean;
  comparison: Comparison | null;
  initialPage: Page | null;
  initialFailed: boolean;
  onInvalid: () => void;
  view: ReviewView;
  onView: (next: Partial<ReviewView>) => void;
  children: ReactNode;
}) {
  const reading = usePolicyStreams({ policy, history, onInvalid, initialPage, initialFailed });
  const { selected, original, streams, load } = reading;
  const source = sourceState(policy);
  const [compare, setCompare] = useState(false),
    [hover, setHover] = useState<string | null>(null),
    [hit, setHit] = useState<Review["hit"]>(null),
    [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    positions = useRef<Partial<Record<ReviewView["pane"], number>>>({}),
    pending = useRef<{ ids?: string[]; top?: number; tries: number } | null>(null),
    settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  const rows = (source.kind === "text" && selected ? streams[selected.id]?.rows : undefined) ?? NO_ROWS;
  const byEvidence = useMemo(() => evidenceBlocks(rows), [rows]);
  // The comparison is made in the original's language and against one revision: marks go in that text only.
  const marked =
    !history && comparison && source.kind === "text"
      ? [selected, original].find((e) => !!e && sameLanguage(e.language, comparison.language) && e.document_revision_id === comparison.to.document_revision_id)
      : undefined;
  const markedRows = marked ? streams[marked.id]?.rows : undefined;
  const redline = useMemo(() => (comparison && markedRows?.length ? redlineOf(comparison, markedRows) : null), [comparison, markedRows]);
  const redlineOn = !!marked && view.redline;

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mounted reader; the parent keys it by expression and revision.
  useEffect(() => {
    setReady(true);
    // The changes are listed beside a translation too; their clause numbers need the original to point at.
    if (marked && marked.id !== selected?.id) {
      void load(marked);
      // Marks left on while the language changed: they sit in the original, so the original is shown under the translation again.
      if (view.redline) setCompare(true);
    }
    return () => clearTimeout(settle.current);
  }, []);

  /** Whether the two sides are tabs (narrow space) or columns: the stylesheet decides, by the space the page has. */
  const tabbed = () => {
    const bar = root.current?.querySelector(".pr-ptab");
    return !!bar && getComputedStyle(bar).display !== "none";
  };
  const show = (element: HTMLElement) => {
    const page = root.current;
    if (!page) return;
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    if (tabbed()) {
      const bar = page.querySelector(".pr-ptab")?.getBoundingClientRect().height ?? 0;
      window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - bar - 12, behavior });
      return;
    }
    const doc = page.querySelector<HTMLElement>(".pr-doc"),
      pane = page.querySelector<HTMLElement>(".pr-src");
    if (!doc || !pane) return;
    const top = Math.max(0, element.offsetTop - 24);
    doc.scrollTo({ top, behavior });
    // The pane is as tall as the window but may still start below the fold: bring it up when the block would land out of view.
    const landing = doc.getBoundingClientRect().top + element.offsetTop - Math.min(top, doc.scrollHeight - doc.clientHeight);
    const offset = pane.getBoundingClientRect().top;
    if (offset > 0 && landing + Math.min(element.offsetHeight, 96) > window.innerHeight) window.scrollBy({ top: offset, behavior });
  };
  // After the render that opened a tab or drew the marks: move to where the reader asked to be.
  useLayoutEffect(() => {
    const job = pending.current;
    if (!job) return;
    if (job.top !== undefined) {
      pending.current = null;
      window.scrollTo({ top: job.top, behavior: "instant" });
      return;
    }
    for (const id of job.ids ?? []) {
      const element = document.getElementById(id);
      const visible = element?.getClientRects().length ? element : element?.dataset.prHead ? document.getElementById(element.dataset.prHead) : null;
      if (visible?.getClientRects().length) {
        pending.current = null;
        show(visible);
        return;
      }
    }
    // Not drawn yet (the original is still on its way): try again on the next renders, then give up.
    if (++job.tries > 30) pending.current = null;
  });

  const setRedline = (on: boolean) => {
    onView({ redline: on });
    if (on && marked && marked.id !== selected?.id) {
      setCompare(true);
      void load(marked);
    }
  };
  const review: Review = {
    ...reading,
    policy,
    history,
    comparison,
    source,
    compare,
    setCompare: (on) => {
      setCompare(on);
      if (on && original) void load(original);
    },
    targets: (ids) => [...new Set(ids.flatMap((id) => byEvidence.get(id) ?? []))].map(blockDomId),
    go: (ids, options) => {
      if (!ids.length) return;
      if (options?.redline) setRedline(true);
      if (tabbed() && view.pane !== "src") {
        positions.current.read = window.scrollY;
        onView({ pane: "src" });
      }
      clearTimeout(settle.current);
      setHit({ ids, settled: false });
      settle.current = setTimeout(() => setHit((now) => (now ? { ...now, settled: true } : now)), 2200);
      pending.current = { ids, tries: 0 };
    },
    hover,
    setHover,
    hit,
    marked,
    redline,
    redlineOn,
    setRedline,
    pane: view.pane,
    setPane: (pane) => {
      if (pane === view.pane) return;
      positions.current[view.pane] = window.scrollY;
      const panes = root.current?.querySelector(".pr-panes");
      const start = (panes?.getBoundingClientRect().top ?? 0) + window.scrollY;
      // Back where this side was left; a first visit starts at the top of the side, not in the middle of it.
      pending.current = { top: positions.current[pane] ?? Math.min(window.scrollY, start), tries: 0 };
      onView({ pane });
    },
  };
  return (
    <ReviewContext value={review}>
      <div
        ref={root}
        className="pr-page"
        data-policy=""
        data-pr-pane={source.kind === "none" ? "read" : view.pane}
        data-pr-source={source.kind}
        data-pr-ready={ready ? "" : undefined}
      >
        {children}
      </div>
    </ReviewContext>
  );
}

/**
 * A clause number after a statement. When a loaded block of the text carries one of its evidence ids it is a link
 * to that block (a plain anchor without scripts); otherwise it is plain text, never a link that leads nowhere.
 */
export function ClauseRef({ ids, label }: { ids: readonly string[]; label: string }) {
  const review = useReview();
  const targets = review.targets(ids);
  if (!targets.length) return <span className="pr-ref-plain">{label}</span>;
  return (
    <a
      href={`#${targets[0]}`}
      className={`pr-ref${review.hover && targets.includes(review.hover) ? " on" : ""}`}
      data-pr-ref={targets.join(" ")}
      onClick={(event) => {
        event.preventDefault();
        review.go(targets);
      }}
    >
      {label}
    </a>
  );
}

/** The clause numbers a statement rests on, named by where each piece of evidence sits in the original. */
export function EvidenceRefs({ ids }: { ids: readonly string[] }) {
  const { policy } = useReview();
  const byLocator = new Map<string, string[]>();
  for (const id of ids) {
    const locator = policy.evidence.find((e) => e.evidence_id === id)?.locator;
    if (locator) byLocator.set(locator, [...(byLocator.get(locator) ?? []), id]);
  }
  return [...byLocator].map(([locator, group]) => <ClauseRef key={locator} ids={group} label={locator} />);
}
