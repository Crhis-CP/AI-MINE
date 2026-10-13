import sanitizeHtml from "sanitize-html";
/** Static legal reading markup. No executable attributes, styling, embedded content or remote media survive. */
export function policySemanticHtml(html: string, baseUrl: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "div",
      "section",
      "dfn",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "caption",
      "a",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "del",
      "ins",
      "sup",
      "sub",
      "dl",
      "dt",
      "dd",
      "span",
    ],
    allowedAttributes: { a: ["href", "title", "rel"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"], ol: ["start", "type"], li: ["value"] },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "textarea", "noscript", "template", "iframe", "svg", "math"],
    transformTags: {
      a: (_, attrs) => {
        let href = "";
        try {
          const url = new URL(attrs.href ?? "", baseUrl);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) href = url.toString();
        } catch {
          /* Invalid links remain plain text. */
        }
        return { tagName: "a", attribs: { ...(href ? { href } : {}), ...(attrs.title ? { title: attrs.title } : {}), rel: "noopener noreferrer" } };
      },
    },
  });
}
