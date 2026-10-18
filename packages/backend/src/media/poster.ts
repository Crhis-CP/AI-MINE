import { createHash } from "node:crypto";
import { renderSVG } from "uqr";
import type { ItemShareMetadata } from "@amp/contracts/site";
import { beijingDate } from "@amp/contracts/time";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { config } from "../config.ts";
import { SITE } from "@amp/site";
import { h, nameMark, renderPng, SITE_HOST, type Node } from "./og.ts";

export interface ArticlePoster {
  url: string;
  title: string;
  summary: string | null;
  source: string;
  date: string | null;
  category: string;
  score: number | null;
}
/** Unknown source dates stay absent; discovery time is never used as a publication date. */
export function articlePoster(item: ItemShareMetadata): ArticlePoster {
  const time = item.sourceTime;
  const date = time?.precision === "date" ? time.local_date : time?.utc ? beijingDate(time.utc) : null;
  return {
    url: new URL(`/items/${encodeURIComponent(item.id)}`, config.siteUrl).href,
    title: item.title,
    summary: item.summary,
    source: item.source.name,
    date,
    category: item.category ? CATEGORY_LABELS[item.category] : "矿业动态",
    score: item.selected ? item.score : null,
  };
}
const TEMPLATE = "article-poster-20261017.1";
const INK = "#1f2937",
  ACCENT = "#475569";
const trim = (value: string, limit: number) => {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
};
async function view(poster: ArticlePoster): Promise<Node> {
  const title = trim(poster.title, 72),
    length = [...title].length;
  const summary = poster.summary ? trim(poster.summary, length > 48 ? 120 : length > 30 ? 150 : 180) : null;
  const qr = `data:image/svg+xml;base64,${Buffer.from(renderSVG(poster.url, { border: 0, ecc: "M", blackColor: INK, whiteColor: "#ffffff" })).toString("base64")}`;
  return h(
    "div",
    {
      width: 1080,
      height: 1440,
      display: "flex",
      flexDirection: "column",
      padding: "76px 80px 64px",
      fontFamily: "Noto Sans SC",
      color: INK,
      backgroundColor: "#faf9f6",
    },
    [
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        nameMark(48, INK, ACCENT),
        h("div", { display: "flex", fontSize: 25, color: ACCENT }, poster.date ?? ""),
      ]),
      h(
        "div",
        { display: "flex", alignItems: "center", marginTop: 76, fontSize: 28, color: ACCENT },
        [
          h("div", { display: "flex" }, trim(poster.category, 20)),
          poster.score === null ? null : h("div", { display: "flex", marginLeft: 24, fontSize: 25 }, `精选 · ${Math.round(poster.score)} 分`),
        ].filter(Boolean),
      ),
      h("div", { display: "flex", marginTop: 30, fontSize: length > 48 ? 58 : length > 30 ? 66 : 76, fontWeight: 700, lineHeight: 1.3 }, title),
      summary ? h("div", { display: "flex", marginTop: 34, fontSize: 33, lineHeight: 1.65, color: "#374151" }, summary) : null,
      h("div", { display: "flex", marginTop: 32, fontSize: 26, color: ACCENT }, trim(`来源：${poster.source}`, 40)),
      h("div", { display: "flex", flex: 1 }),
      h("div", { display: "flex", alignItems: "center", padding: "32px 36px", borderRadius: 24, backgroundColor: "#ffffff" }, [
        h("img", { width: 190, height: 190 }, undefined, { src: qr, width: 190, height: 190 }),
        h("div", { display: "flex", flexDirection: "column", marginLeft: 36, flex: 1 }, [
          h("div", { display: "flex", fontSize: 34, fontWeight: 700 }, "扫码查看资讯"),
          h("div", { display: "flex", marginTop: 14, fontSize: 26, lineHeight: 1.5, color: ACCENT }, "阅读导读，核对原文与来源"),
          h("div", { display: "flex", marginTop: 20, fontSize: 24, color: ACCENT }, SITE_HOST),
        ]),
      ]),
      h("div", { display: "flex", justifyContent: "center", marginTop: 32, fontSize: 22, color: "#64748b" }, `${SITE.name} · AI 辅助整理，请核对原文`),
    ].filter(Boolean),
  );
}
export function posterEtag(poster: ArticlePoster): string {
  return createHash("sha256").update(TEMPLATE).update(SITE.name).update(SITE_HOST).update(JSON.stringify(poster)).digest("hex").slice(0, 24);
}
export async function renderPoster(poster: ArticlePoster) {
  const etag = posterEtag(poster);
  return { png: await renderPng(`poster-${etag}`, { width: 1080, height: 1440 }, () => view(poster)), etag };
}
