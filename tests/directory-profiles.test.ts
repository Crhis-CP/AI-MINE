import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { directoryContract } from "../packages/backend/src/sources/directory-profile.ts";
import { decodeDirectoryPage } from "../packages/backend/src/sources/directory-page.ts";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";
import type { GuardedResponse } from "../packages/backend/src/lib/http-fetch.ts";
const registered = POLICY_SOURCES.find((s) => s.id === "AR-008")!;
const source = { id: "policy-ar-008", lane: "policy", ...registered.collect! } as SourceRow;
const profile = directoryContract(source)!.profile;
function item(id: number) {
  return {
    id,
    link: `https://boletinoficial.jujuy.gob.ar/?p=${id}`,
    date_gmt: "2026-01-01T00:00:00",
    modified_gmt: "2026-01-02T00:00:00",
    title: { rendered: `Synthetic law ${id}` },
    excerpt: { rendered: `Synthetic official record ${id}` },
    categories: [13],
    type: "post",
  };
}
function url(page: number) {
  const u = new URL(String(source.config.url));
  u.searchParams.set("page", String(page));
  return u.href;
}
function link(page: number, relation: string) {
  const u = new URL(url(page));
  u.searchParams.delete("categories");
  [13, 11, 21].forEach((n, i) => {
    u.searchParams.set(`categories[${i}]`, String(n));
  });
  return `<${u.href}>; rel="${relation}"`;
}
function response(page: number, items: unknown[], links: string | null, total = 3, pages = 2): GuardedResponse {
  const body = Buffer.from(JSON.stringify(items));
  return {
    url: url(page),
    status: 200,
    fetchedAt: "2026-10-09T00:00:00Z",
    body,
    text: () => body.toString(),
    headers: new Headers({
      "content-type": "application/json",
      "x-wp-total": String(total),
      "x-wp-totalpages": String(pages),
      ...(links ? { link: links } : {}),
    }),
  };
}
test("registered family names the real official categories and preserves original profile/enabling boundaries", () => {
  assert.equal(new URL(String(source.config.url)).searchParams.get("categories"), "13,11,21");
  assert.equal(new URL(String(source.config.url)).searchParams.get("orderby"), "id");
  assert.equal(new URL(String(source.config.url)).searchParams.get("order"), "desc");
  assert.match(profile.scope.basis, /13=Leyes, 11=Decretos and 21=Resoluciones/);
  assert.equal(profile.documentId, undefined);
  assert.equal(registered.hold, null);
  const blm = POLICY_SOURCES.find((s) => s.id === "US-009")!;
  assert.equal(blm.collect!.config.directoryProfile, undefined);
  assert.ok((blm.collect!.config.policyProfile as { extraction: { attachmentReferencePattern: string } }).extraction.attachmentReferencePattern);
  assert.equal(POLICY_SOURCES.find((s) => s.id === "CN-003")!.collect!.config.directoryProfile, undefined);
});
test("actual response next/prev links prove one-based pages, normalized arrays keep the same collection", () => {
  const a = decodeDirectoryPage(source, profile, 1, response(1, [item(101), item(102)], link(2, "next")));
  const b = decodeDirectoryPage(source, profile, 2, response(2, [item(103)], link(1, "prev")));
  const probe = decodeDirectoryPage(source, profile, 1, response(1, [item(101), item(102)], link(2, "next")));
  assert.deepEqual([a.page, b.page, a.totalPages, a.totalRecords], [1, 2, 2, 3]);
  assert.equal(a.fingerprint, probe.fingerprint);
  assert.equal(a.entries[0]!.recordId, "101");
  assert.equal(a.entries[0]!.marker, "2026-01-02T00:00:00");
  assert.equal(a.entries[0]!.documentId, null);
});
test("ignored page request, contradictory/missing/duplicate neighbors and widened category scope fail closed", () => {
  for (const [page, links, pages] of [
    [2, link(2, "next"), 2],
    [2, `${link(1, "prev")}, ${link(4, "next")}`, 4],
    [1, null, 2],
    [1, `${link(2, "next")}, ${link(2, "next")}`, 2],
    [1, link(2, "next").replace("categories%5B0%5D=13", "categories%5B0%5D=99"), 2],
    [1, link(2, "next").replace("boletinoficial.jujuy.gob.ar", "other.invalid"), 2],
  ] as const)
    assert.throws(() => decodeDirectoryPage(source, profile, page, response(page, [item(101)], links, 4, pages)));
});
test("source-declared empty zero-page collection retains zero declaration with one physical empty page and no invented rows", () => {
  const result = decodeDirectoryPage(source, profile, 1, response(1, [], null, 0, 0));
  assert.equal(result.declaredTotalPages, 0);
  assert.equal(result.totalPages, 1);
  assert.equal(result.totalRecords, 0);
  assert.equal(result.entries.length, 0);
  assert.throws(() => decodeDirectoryPage(source, profile, 1, response(1, [item(101)], null, 0, 0)));
  assert.throws(() => decodeDirectoryPage(source, profile, 1, response(1, [], null, 1, 0)));
});

test("official category scope is checked on every row, not just trusted from the request filter", () => {
  for (const categories of [[99], [], undefined])
    assert.throws(() => decodeDirectoryPage(source, profile, 1, response(1, [{ ...item(101), categories }], null, 1, 1)), /分类范围/);
  const first = decodeDirectoryPage(source, profile, 1, response(1, [item(101)], null, 1, 1));
  const moved = decodeDirectoryPage(source, profile, 1, response(1, [{ ...item(101), categories: [11] }], null, 1, 1));
  assert.notEqual(first.fingerprint, moved.fingerprint);
});
