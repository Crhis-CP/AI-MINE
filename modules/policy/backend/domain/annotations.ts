import type * as cheerio from "cheerio";
import { isTag, type Element } from "domhandler";
import { sha256, stableJson } from "@amp/backend/lib/ids";
export type SourceAnnotation = { annotation_id: string; name: string; value: string; scope: "self" | "ancestor" | "descendant"; locator: string };
const limsAttributes = /^(?:pit-date|current-date|lastAmendedDate|inforce-start-date|inforce-end-date|enacted-date)$/i;
const permitted =
  /^(?:data-(?:in-force|status|effective|commencement|repeal|extent|start-date|end-date)|(?:restrict)?(?:startdate|enddate|extent|status)|inforce(?:startdate|enddate)?|in-force|hasPreviousVersion|status|validfrom|validto)$/i;
function locator(element: Element) {
  const path: string[] = [];
  let node: Element | null = element;
  while (node) {
    const siblings = node.parent?.children.filter(isTag) ?? [node];
    path.unshift(`${node.name}[${siblings.filter((s) => s.name === node!.name).indexOf(node) + 1}]`);
    node = node.parent && isTag(node.parent) ? node.parent : null;
  }
  return `/${path.join("/")}`;
}
/** Preserve source assertions independently of body text; scope is relative to this extracted node. */
export function sourceAnnotations($: cheerio.CheerioAPI, element: Element, resourceHash: string) {
  const result: SourceAnnotation[] = [];
  const collect = (node: Element, scope: SourceAnnotation["scope"]) => {
    for (const [name, value] of Object.entries(node.attribs)) {
      const [prefix, local] = name.split(":");
      let namespace: string | undefined;
      if (local) {
        let scope: Element | null = node;
        while (scope && !namespace) {
          namespace = scope.attribs[`xmlns:${prefix}`];
          scope = scope.parent && isTag(scope.parent) ? scope.parent : null;
        }
      }
      const legalAttribute = permitted.test(name) || (namespace === "http://justice.gc.ca/lims" && limsAttributes.test(local ?? ""));
      if (!legalAttribute || !value.trim()) continue;
      const at = `${locator(node)}/@${name}`;
      result.push({ annotation_id: sha256(stableJson([resourceHash, at, value])), name, value, scope, locator: at });
    }
  };
  collect(element, "self");
  $(element)
    .parents()
    .each((_, ancestor) => {
      collect(ancestor, "ancestor");
    });
  $(element)
    .find("*")
    .each((_, descendant) => {
      collect(descendant, "descendant");
    });
  return result;
}
export { xmlReadingHtml } from "./xml-structure.ts";
