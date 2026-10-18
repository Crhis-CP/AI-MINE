import type { parseHTML } from "linkedom";
type Doc = ReturnType<typeof parseHTML>["document"];
type El = NonNullable<ReturnType<Doc["querySelector"]>>;

/** Restore only completed React streaming boundaries, without evaluating any page script. */
function settleStreamedContent(document: ReturnType<typeof parseHTML>["document"]) {
  for (const script of document.querySelectorAll("script:not([src])")) {
    const type = script.getAttribute("type")?.toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    const text = script.textContent ?? "";
    // React emits a standalone completion call, or appends it to its runtime definition. Do not
    // interpret occurrences inside data, comments, documentation strings or arbitrary programs.
    const call = /\$RC\("(B:[\w:.-]+)","(S:[\w:.-]+)"\)\s*;?\s*$/.exec(text);
    if (!call) continue;
    const before = text.slice(0, call.index).trim();
    if (before && !(/^\$R[BCV]=/.test(before) && before.includes("$RC=function(") && before.endsWith("};"))) continue;
    const boundary = document.getElementById(call[1]!);
    const segment = document.getElementById(call[2]!);
    const start = boundary?.previousSibling;
    const parent = boundary?.parentNode;
    if (
      boundary?.localName !== "template" ||
      !segment?.hasAttribute("hidden") ||
      !parent ||
      !start ||
      start.nodeType !== 8 ||
      !["$?", "$~"].includes(start.textContent ?? "") ||
      segment.contains(boundary)
    )
      continue;
    let end = boundary.nextSibling;
    let depth = 0;
    while (end) {
      if (end.nodeType === 8) {
        const marker = end.textContent;
        if (marker === "/$") {
          if (depth === 0) break;
          depth -= 1;
        } else if (["$", "$?", "$!", "$~"].includes(marker ?? "")) depth += 1;
      }
      end = end.nextSibling;
    }
    if (!end) continue;
    let fallback = boundary.nextSibling;
    parent.removeChild(boundary);
    while (fallback && fallback !== end) {
      const next = fallback.nextSibling;
      parent.removeChild(fallback);
      fallback = next;
    }
    while (segment.firstChild) parent.insertBefore(segment.firstChild, end);
    segment.remove();
    start.textContent = "$";
  }
}

/**
 * Readability leaves out what an inline style hides, but compares style.display and style.visibility
 * literally, and linkedom keeps the author's case and "!important" in them. A style that sets either is
 * reduced to what a browser applies: names and keywords in any case, an important declaration over a
 * later plain one, else the last. The nodes stay in place: Readability restores noscript images beside
 * their hidden placeholders, and drops every style from the body afterwards.
 */
function settleInlineVisibility(document: ReturnType<typeof parseHTML>["document"]) {
  for (const el of document.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") ?? "";
    if (!/display|visibility/i.test(style)) continue;
    const applied = new Map<string, { value: string; important: boolean }>();
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim().toLowerCase();
      if (colon < 0 || (name !== "display" && name !== "visibility")) continue;
      const raw = declaration
        .slice(colon + 1)
        .trim()
        .toLowerCase();
      const important = /!\s*important$/.test(raw);
      const value = raw.replace(/!\s*important$/, "").trim();
      if (value && (important || !applied.get(name)?.important)) applied.set(name, { value, important });
    }
    el.setAttribute("style", [...applied].map(([name, { value }]) => `${name}:${value}`).join(";"));
  }
}

const collapsed = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Only letters and digits: "Value: what is it?" and "Value What is it" are the same words. */
const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/** Hidden by an attribute or an inline style (settleInlineVisibility), itself or inside its figure. */
function hiddenIn(el: El, figure: El): boolean {
  for (let node: El | null = el; node && node !== figure; node = node.parentElement) {
    if (node.hasAttribute("hidden") || /(?:^|;)(?:display:none|visibility:hidden)(?:;|$)/.test(node.getAttribute("style") ?? "")) return true;
  }
  return false;
}

/** A [role="img"] holder that has nothing besides its svgs: no text, image or video of its own. */
function onlyDrawings(holder: El): boolean {
  const copy = holder.cloneNode(true) as El;
  for (const svg of copy.querySelectorAll("svg")) svg.remove();
  return !collapsed(copy.textContent) && !copy.querySelector("img, picture, video");
}

/** The text alternative of a drawing, a line each: what aria-labelledby points to, aria-label, or an svg's title and desc. */
function drawingText(document: Doc, el: El): string[] {
  const ids: string[] = el.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const labelledBy = ids.map((id) => collapsed(document.getElementById(id)?.textContent)).filter(Boolean);
  if (labelledBy.length) return labelledBy;
  const label = collapsed(el.getAttribute("aria-label"));
  if (label) return [label];
  if (el.localName !== "svg") return [];
  return ["title", "desc"].map((name) => collapsed([...el.children].find((child) => child.localName === name)?.textContent)).filter(Boolean);
}

/**
 * An inline SVG drawing in a figure is not kept: its colours come from the page's stylesheet and its
 * labels are not prose. The drawing is the figure's [role="img"] element holding the svg, else the svg;
 * a holder with text or images of its own keeps them, and only its svgs are replaced by its text. The
 * drawing's own text alternative stands in for it as a paragraph, written as text, never as markup. The page
 * hides the drawing from screen readers (aria-hidden) because that text is read instead, so only hidden
 * and style carry over. Wide and narrow versions of one figure give the same text once, from a version
 * that is shown. Words the figure shows (its caption, a heading, not hidden text) are not repeated; a
 * drawing without any text is left to be dropped.
 */
function describeFigureDrawings(document: Doc) {
  const figures = new Map<El, { shown: string; texts: Map<string, El> }>();
  for (const svg of document.querySelectorAll("figure svg")) {
    const figure = svg.closest("figure");
    if (!figure) continue; // inside a drawing already replaced
    const holder = svg.closest('[role="img"]');
    const held = holder && holder !== figure && figure.contains(holder) ? holder : null;
    // The holder describes the drawing; it is replaced whole only when it holds nothing else.
    const drawing = held && onlyDrawings(held) ? held : svg;
    const lines = held ? drawingText(document, held) : [];
    if (!lines.length) lines.push(...drawingText(document, svg));
    const text = lines.join(" ");
    if (!text) continue;
    let seen = figures.get(figure);
    if (!seen) {
      const copy = figure.cloneNode(true) as El;
      // Readability drops aria-hidden elements, so their words are not shown either.
      for (const el of copy.querySelectorAll('svg, [role="img"], [hidden], [style], [aria-hidden="true"]')) {
        if (
          el.localName === "svg" ||
          (el.getAttribute("role") === "img" && onlyDrawings(el)) ||
          el.getAttribute("aria-hidden") === "true" ||
          hiddenIn(el, copy)
        )
          el.remove();
      }
      seen = { shown: words(copy.textContent ?? ""), texts: new Map() };
      figures.set(figure, seen);
    }
    if (seen.shown.includes(words(text))) continue;
    const earlier = seen.texts.get(text);
    if (earlier && (!hiddenIn(earlier, figure) || hiddenIn(drawing, figure))) {
      drawing.remove();
      continue;
    }
    const p = document.createElement("p");
    lines.forEach((line, i) => {
      p.append(...(i ? [document.createElement("br"), line] : [line]));
    });
    for (const name of ["hidden", "style"]) {
      const value = drawing.getAttribute(name);
      if (value !== null) p.setAttribute(name, value);
    }
    drawing.replaceWith(p);
    earlier?.remove();
    seen.texts.set(text, p);
  }
}

export function prepareReadableDocument(document: Doc): void {
  settleStreamedContent(document);
  settleInlineVisibility(document);
  describeFigureDrawings(document);
}
