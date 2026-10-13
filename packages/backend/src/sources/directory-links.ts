import type { GuardedResponse } from "../lib/http-fetch.ts";
import { stableJson } from "../lib/ids.ts";
/** WordPress normalizes CSV arrays to bracketed query keys in Link headers. Compare the same requested collection. */
function collection(url: URL, parameter: string) {
  const values = new Map<string, string[]>();
  for (const [raw, value] of url.searchParams) {
    const key = raw.replace(/\[\d*\]$/u, "");
    if (key === parameter) continue;
    values.set(key, [...(values.get(key) ?? []), ...value.split(",")]);
  }
  return stableJson([...values].map(([key, value]) => [key, value.sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}
/** Actual response neighbors prove the returned page; echoing our requested page is insufficient. */
export function linkPageNumber(response: Pick<GuardedResponse, "url" | "headers">, parameter: string, totalPages: number, totalRecords: number) {
  const base = new URL(response.url),
    neighbors = new Map<string, number>();
  for (const entry of (response.headers.get("link") ?? "").split(/,\s*(?=<)/u)) {
    if (!entry.trim()) continue;
    const match = /^\s*<([^<>]+)>\s*(.*)$/u.exec(entry);
    if (!match) throw new Error("目录Link头结构不可验证");
    const rels = [...match[2]!.matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/giu)];
    if (rels.length !== 1) throw new Error("目录Link关系缺失或重复");
    const roles = (rels[0]![1] ?? rels[0]![2]!).split(/\s+/u).filter((r) => r === "prev" || r === "next");
    if (!roles.length) continue;
    const url = new URL(match[1]!, base),
      page = url.searchParams.getAll(parameter);
    if (
      url.origin !== base.origin ||
      url.pathname !== base.pathname ||
      url.username ||
      url.password ||
      url.hash ||
      collection(url, parameter) !== collection(base, parameter)
    )
      throw new Error("目录Link指向不同目录或范围");
    if (page.length !== 1 || !/^[1-9]\d*$/u.test(page[0]!) || !Number.isSafeInteger(Number(page[0]))) throw new Error("目录相邻页码无效");
    for (const role of roles) {
      if (neighbors.has(role)) throw new Error("目录相邻页关系不唯一");
      neighbors.set(role, Number(page[0]));
    }
  }
  const prev = neighbors.get("prev"),
    next = neighbors.get("next");
  if (prev === undefined && next === undefined) {
    if (totalPages === 1 || (totalPages === 0 && totalRecords === 0)) return 1;
    throw new Error("多页目录没有来源分页关系");
  }
  const current = prev !== undefined ? prev + 1 : next! - 1;
  if (
    current < 1 ||
    current > totalPages ||
    (prev !== undefined && next !== undefined && prev + 2 !== next) ||
    current > 1 !== (prev !== undefined) ||
    current < totalPages !== (next !== undefined)
  )
    throw new Error("目录相邻页与声明页数不一致");
  return current;
}
