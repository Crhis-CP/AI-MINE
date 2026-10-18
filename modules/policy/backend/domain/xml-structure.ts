import type * as cheerio from "cheerio";
import { isTag, type Element } from "domhandler";

/** Convert the Justice Canada CALS table vocabulary without discarding cell positions or spans. */
function calsTables($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>) {
  root.find("tgroup").each((_, group) => {
    const columns = $(group)
      .children("colspec")
      .toArray()
      .map((column) => $(column).attr("colname"));
    const count = Number($(group).attr("cols"));
    if (!Number.isSafeInteger(count) || count < 1 || count > 100 || columns.length !== count || new Set(columns).size !== count || columns.some((c) => !c))
      throw new Error("XML CALS column definitions incomplete");
    const occupied = Array<number>(count).fill(-1);
    const rows = $(group).find("row").toArray();
    rows.forEach((row, rowIndex) => {
      const header = $(row).parents("thead").length > 0;
      let cursor = 0;
      const entries = $(row).children("entry").toArray();
      for (const entry of entries) {
        while (occupied[cursor]! >= rowIndex && cursor < count) cursor++;
        const startName = $(entry).attr("namest") ?? $(entry).attr("colname");
        const endName = $(entry).attr("nameend");
        const from = startName ? columns.indexOf(startName) : cursor;
        const to = endName ? columns.indexOf(endName) : from;
        const more = Number($(entry).attr("morerows") ?? 0);
        if (from < cursor || to < from || to >= count || !Number.isSafeInteger(more) || more < 0 || rowIndex + more >= rows.length)
          throw new Error("XML CALS cell span invalid");
        for (let col = cursor; col < from; col++) if (occupied[col]! < rowIndex) $(entry).before(header ? "<th/>" : "<td/>");
        for (let col = from; col <= to; col++) {
          if (occupied[col]! >= rowIndex) throw new Error("XML CALS overlapping cells");
          occupied[col] = rowIndex + more;
        }
        entry.name = header ? "th" : "td";
        if (to > from) $(entry).attr("colspan", String(to - from + 1));
        if (more) $(entry).attr("rowspan", String(more + 1));
        cursor = to + 1;
      }
      for (let col = cursor; col < count; col++) if (occupied[col]! < rowIndex) $(row).append(header ? "<th/>" : "<td/>");
      row.name = "tr";
    });
    $(group).children("colspec").remove();
    $(group).replaceWith($(group).contents());
  });
}
import type { AnyNode } from "domhandler";
/** Source XML names map to equivalent reading structure; metadata remains in the separate annotation channel. */
export function xmlReadingHtml($: cheerio.CheerioAPI, element: Element) {
  const node = $(element).clone();
  calsTables($, node);
  const names: Record<string, string> = {
    regulation: "section",
    statute: "section",
    body: "section",
    schedule: "section",
    regulationpiece: "section",
    section: "section",
    subsection: "div",
    paragraph: "div",
    subparagraph: "div",
    clause: "div",
    provision: "div",
    definition: "div",
    tablegroup: "div",
    identification: "div",
    regulationmakerorder: "div",
    recentamendments: "div",
    amendment: "p",
    relatedornotinforce: "div",
    heading: "h3",
    titletext: "span",
    text: "p",
    para: "p",
    p: "p",
    label: "span",
    marginalnote: "p",
    historicalnote: "p",
    orderedlist: "ol",
    unorderedlist: "ul",
    listitem: "li",
    table: "table",
    tbody: "tbody",
    thead: "thead",
    tfoot: "tfoot",
    tr: "tr",
    td: "td",
    th: "th",
    caption: "caption",
    emphasis: "em",
    strong: "strong",
    definedtermen: "dfn",
    definedtermfr: "dfn",
    superior: "sup",
    inferior: "sub",
    sup: "sup",
    sub: "sub",
    repeal: "del",
    repealed: "del",
    deleted: "del",
    added: "ins",
    footnote: "p",
    footnoteref: "sup",
  };
  node
    .find("*")
    .addBack()
    .each((_, child) => {
      if (!isTag(child)) return;
      const name = child.name.toLowerCase();
      if (/^(?:script|style|svg|math|image|img|formula)$/.test(name)) return;
      child.name =
        name === "title" ? (child.parent && isTag(child.parent) && child.parent.name.toLowerCase() === "table" ? "caption" : "h3") : (names[name] ?? "span");
    });
  return $.html(node);
}
