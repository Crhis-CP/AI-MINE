import * as cheerio from "cheerio";
import { isTag, isText, type AnyNode } from "domhandler";
export type PolicyFragment = { source: string; suffix: string; sourceStart?: number; sourceEnd?: number };
/** Cuts only at explicit sentence/clause/word boundaries. HTML ancestors are copied, text is never discarded. */
export function proseFragments(source: string, html: boolean, limit: number): PolicyFragment[] {
  if (Buffer.byteLength(source) <= limit) return [{ source, suffix: "" }];
  const $ = html ? cheerio.load(source, null, false) : null;
  if ($?.root().find("table,img,svg,math").length) return [{ source, suffix: "" }];
  if ($)
    $.root()
      .find("ol")
      .each((_, list) => {
        let number = Number($(list).attr("start") ?? 1);
        $(list)
          .children("li")
          .each((_, item) => {
            if ($(item).attr("value")) number = Number($(item).attr("value"));
            if (Number.isSafeInteger(number)) $(item).attr("data-policy-item-number", String(number));
            number++;
          });
      });
  const text = $ ? $.root().text() : source;
  const boundaries = [...text.matchAll(/[.!?。！？;；\n]\s*|\s+/gu)].map((m) => m.index + m[0].length);
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
  const render = (from: number, to: number) => {
    if (!$) return text.slice(from, to);
    const root = $.root().clone();
    let offset = 0;
    const visit = (node: AnyNode) => {
      if (isText(node)) {
        const end = offset + node.data.length;
        node.data = node.data.slice(Math.max(0, from - offset), Math.max(0, Math.min(end, to) - offset));
        offset = end;
        if (!node.data) $(node).remove();
      } else if (isTag(node)) {
        const start = offset;
        [...node.children].forEach(visit);
        if (offset <= from || start >= to) $(node).remove();
      }
    };
    [...root.contents()].forEach(visit);
    // Numbers follow original sibling positions, including repeated text and explicit value resets.
    root.find("ol").each((_, list) => {
      const number = $(list).children("li").first().attr("data-policy-item-number");
      if (number) $(list).attr("start", number);
    });
    root.find("[data-policy-item-number]").removeAttr("data-policy-item-number");
    return root.html() ?? "";
  };
  const output: PolicyFragment[] = [];
  let from = 0;
  while (from < text.length) {
    let to = from,
      content = "";
    for (const boundary of boundaries) {
      if (boundary <= from) continue;
      const next = render(from, boundary);
      if (Buffer.byteLength(next) > limit) break;
      to = boundary;
      content = next;
    }
    if (to === from) return [{ source, suffix: "" }];
    output.push({ source: content, suffix: `/text:${from}-${to}`, sourceStart: from, sourceEnd: to });
    from = to;
  }
  return output;
}
