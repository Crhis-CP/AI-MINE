import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "@amp/backend/lib/url";
import { crawlFetch } from "../acquisition/crawl.ts";
import type { GuardedFetchOptions } from "../lib/http-fetch.ts";
import { getPath, jsonListDocument, parseSourceJson, rawDateAt } from "./json-list.ts";
import { htmlListDocument } from "./web-list.ts";
import type { SourceRow, Candidate } from "./types.ts";
import type { DirectoryProfile, DirectoryField } from "./directory-profile.ts";
export type DirectoryEntry = {
  recordId: string;
  documentId: string | null;
  language: string | null;
  role: "current" | "history";
  historyUrls: string[];
  marker: string | null;
  candidate: Candidate;
  hash: string;
};
export type DirectoryPage = {
  url: string;
  fetchedAt: string;
  bodyHash: string;
  body: Buffer;
  fingerprint: string;
  page: number;
  totalPages: number;
  totalRecords: number;
  entries: DirectoryEntry[];
};
export type DirectoryFailureEvidence = { url: string; fetchedAt: string; bodyHash: string; httpStatus: number; body: Buffer };
export class DirectoryStructureError extends Error {
  evidence?: DirectoryFailureEvidence;
}
function httpUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new DirectoryStructureError("目录链接不是明确HTTP资源");
  return url.href;
}
type Context = { html: string; data: unknown; headers: Headers };
function value(field: DirectoryField, context: Context): unknown {
  let raw: unknown;
  if (field.kind === "header") raw = context.headers.get(field.name);
  else if (field.kind === "json") raw = getPath(context.data, field.path);
  else {
    const $ = cheerio.load(context.html, null, false),
      nodes = $(field.selector);
    if (nodes.length !== 1) throw new DirectoryStructureError(`字段不唯一或缺失：${field.selector}`);
    raw = field.attribute ? nodes.attr(field.attribute) : nodes.text();
  }
  if (field.pattern) {
    const match = new RegExp(field.pattern, "u").exec(String(raw ?? ""));
    if (!match?.[1]) throw new DirectoryStructureError("结构字段未匹配声明格式");
    return match[1];
  }
  if (typeof raw === "number" && field.kind === "json") return rawDateAt(context.data, field.path);
  return raw;
}
function scalar(field: DirectoryField, context: Context) {
  const raw = value(field, context);
  if (typeof raw !== "string" || !raw.trim()) throw new DirectoryStructureError("来源标识或结构字段缺失");
  return raw.trim();
}
function count(spec: DirectoryProfile["pageNumber"], context: Context) {
  let raw = scalar(spec.field, context);
  if (spec.groupSeparator) {
    const escaped = spec.groupSeparator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`).test(raw)) raw = raw.split(spec.groupSeparator).join("");
  }
  if (!/^\d+$/.test(raw)) throw new DirectoryStructureError("页码或声明总数不是明确整数");
  const n = Number(raw) + spec.adjust;
  if (!Number.isSafeInteger(n) || n < 0) throw new DirectoryStructureError("页码或声明总数超出可验证范围");
  return n;
}
function links(field: DirectoryField | undefined, context: Context, base: string) {
  if (!field) return [];
  let values: unknown[];
  if (field.kind === "html") {
    const $ = cheerio.load(context.html, null, false);
    values = $(field.selector)
      .toArray()
      .map((node) => $(node).attr(field.attribute ?? "href"));
  } else {
    const raw = value(field, context);
    values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  }
  return values.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new DirectoryStructureError("沿革链接缺失");
    return httpUrl(item, base);
  });
}
export function directoryRequest(source: SourceRow, profile: DirectoryProfile, page: number) {
  const url = new URL(String(source.config.url)),
    body = structuredClone(source.config.bodyJson ?? {});
  if (profile.request.location === "query") url.searchParams.set(profile.request.parameter, String(page));
  else {
    const parts = profile.request.parameter.split(".");
    let target = body;
    for (const key of parts.slice(0, -1)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new DirectoryStructureError("分页字段不可用");
      target[key] ??= {};
      target = target[key];
    }
    const key = parts.at(-1)!;
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new DirectoryStructureError("分页字段不可用");
    target[key] = page;
  }
  return { url: url.href, body: profile.request.location === "json_body" || source.config.bodyJson ? body : undefined };
}
export async function readDirectoryPage(source: SourceRow, profile: DirectoryProfile, page: number, probeKey?: string): Promise<DirectoryPage> {
  const request = directoryRequest(source, profile, page);
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(source.config.headers ?? {}).filter(([key]) => !["if-none-match", "if-modified-since"].includes(key.toLowerCase())),
  ) as Record<string, string>;
  const options: GuardedFetchOptions = {
    method: source.config.method ?? (request.body ? "POST" : "GET"),
    headers: request.body ? { ...headers, "content-type": "application/json" } : headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
    timeoutMs: 25_000,
    crawlKey: probeKey,
    crawlResponseHeaders: [profile.pageNumber.field, profile.totalPages.field, profile.totalRecords.field].flatMap((f) =>
      f.kind === "header" ? [f.name.toLowerCase()] : [],
    ),
  };
  const response = await crawlFetch(request.url, options);
  const evidence = {
    url: response.url,
    fetchedAt: response.fetchedAt ?? new Date().toISOString(),
    bodyHash: createHash("sha256").update(response.body).digest("hex"),
    httpStatus: response.status,
    body: response.body,
  };
  try {
    if (response.status !== 200) throw new DirectoryStructureError(`目录HTTP ${response.status}`);
    const fetchedAt = response.fetchedAt ?? new Date().toISOString(),
      text = response.text(),
      base = String(source.config.baseUrl ?? response.url);
    let data: unknown,
      html = text,
      rawRecords: { html: string; data: unknown; candidate: Candidate | null }[];
    const mappingSource = { ...source, config: { ...source.config, requireBoolean: undefined, minNumeric: undefined } };
    if (source.kind === "json_list") {
      const parsed = jsonListDocument(text, mappingSource, fetchedAt);
      data = parsed.data;
      if (parsed.items.length !== parsed.candidates.length) throw new DirectoryStructureError("目录记录缺少可定位的标题或链接");
      rawRecords = parsed.items.map((item, i) => ({ html: "", data: item, candidate: parsed.candidates[i]! }));
    } else {
      if (source.config.htmlJsonPath) {
        data = parseSourceJson(text);
        const fragment = getPath(data, String(source.config.htmlJsonPath));
        if (typeof fragment !== "string") throw new DirectoryStructureError("目录HTML字段缺失");
        html = fragment;
      }
      rawRecords = htmlListDocument(html, base, source, fetchedAt).map((row) => ({ ...row, data: null }));
    }
    const context: Context = { html, data, headers: response.headers },
      actualPage = count(profile.pageNumber, context),
      totalPages = count(profile.totalPages, context),
      totalRecords = count(profile.totalRecords, context);
    if (actualPage !== page || totalPages < 1 || page < profile.request.firstPage || page >= profile.request.firstPage + totalPages)
      throw new DirectoryStructureError("来源页码或总页数不一致");
    if (totalPages > profile.maxPages || totalRecords > profile.maxRecords) throw new DirectoryStructureError("目录超出已配置工程容量；未计完整");
    const entries = rawRecords.map((row) => {
      if (!row.candidate) throw new DirectoryStructureError("目录记录缺少可定位的标题或链接");
      const ctx = { html: row.html, data: row.data, headers: response.headers },
        candidate = row.candidate;
      candidate.url = httpUrl(candidate.url);
      const recordId = profile.recordId.kind === "url" ? identityKeyForUrl(candidate.url) : scalar(profile.recordId, ctx);
      if (!recordId) throw new DirectoryStructureError("来源记录标识不可用");
      let role: "current" | "history" = "current";
      if (profile.role.mode === "field") {
        const raw = scalar(profile.role.field, ctx);
        if (profile.role.currentValues.includes(raw)) role = "current";
        else if (profile.role.historyValues.includes(raw)) role = "history";
        else throw new DirectoryStructureError("目录记录角色未在来源契约中声明");
      }
      const entry = {
        recordId,
        documentId: profile.documentId ? scalar(profile.documentId, ctx) : null,
        language: profile.language ? scalar(profile.language, ctx) : null,
        role,
        historyUrls: links(profile.historyLinks, ctx, base),
        marker: profile.revisionMarker ? scalar(profile.revisionMarker, ctx) : null,
        candidate,
      };
      const hash = sha256(
        stableJson([
          recordId,
          entry.documentId,
          entry.language,
          role,
          entry.historyUrls,
          entry.marker,
          candidate.url,
          candidate.title,
          candidate.sourceDateObservation?.raw ?? null,
        ]),
      );
      return { ...entry, hash };
    });
    if (new Set(entries.map((e) => e.recordId)).size !== entries.length) throw new DirectoryStructureError("同页存在重复来源记录ID");
    if ((entries.length === 0 && totalRecords !== 0) || (totalRecords === 0 && (totalPages !== 1 || entries.length !== 0)))
      throw new DirectoryStructureError("空目录与来源声明不一致");
    return {
      url: response.url,
      fetchedAt,
      bodyHash: createHash("sha256").update(response.body).digest("hex"),
      body: response.body,
      page: actualPage,
      totalPages,
      totalRecords,
      entries,
      fingerprint: sha256(stableJson([actualPage, totalPages, totalRecords, entries.map((e) => [e.recordId, e.hash])])),
    };
  } catch (error) {
    const failure = error instanceof DirectoryStructureError ? error : new DirectoryStructureError(String(error));
    failure.evidence = evidence;
    throw failure;
  }
}
