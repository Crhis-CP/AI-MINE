// Filing and licence numbers are deployment settings (DEC-78): read from the API environment at run time, shown
// only when configured and well formed, never echoed in start-up errors. Synthetic numbers only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SiteMeta } from "@amp/contracts/http/public";
import { assertSiteFilings, readSiteFilings, siteFilings, siteMeta } from "@amp/backend/site/meta";

const env = (values: Record<string, string>) => (name: string) => values[name];

test("nothing configured shows nothing and is not a problem unless the deployer requires it", () => {
  assert.deepEqual(readSiteFilings(env({})), { filings: { icp: null, publicSecurity: null, newsLicense: null }, problems: [] });
  assert.deepEqual(readSiteFilings(env({ SITE_ICP_FILING: "  ", SITE_REQUIRE_FILINGS: "false" })).problems, []);
  assert.deepEqual(
    readSiteFilings(env({ SITE_REQUIRE_FILINGS: "true" })).problems.map((p) => [p.variable, p.reason]),
    [
      ["SITE_ICP_FILING", "missing"],
      ["SITE_PUBLIC_SECURITY_FILING", "missing"],
    ],
  );
});

test("well-formed numbers are shown as written; the public-security query code comes from the number itself", () => {
  const { filings, problems } = readSiteFilings(
    env({
      SITE_ICP_FILING: " 京ICP备00000000号-1 ",
      SITE_PUBLIC_SECURITY_FILING: "京公网安备00000000000000号",
      SITE_NEWS_LICENSE: "00000000000",
      SITE_REQUIRE_FILINGS: "1",
    }),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(filings, {
    icp: "京ICP备00000000号-1",
    publicSecurity: { text: "京公网安备00000000000000号", code: "00000000000000" },
    newsLicense: "00000000000",
  });
  assert.equal(readSiteFilings(env({ SITE_ICP_FILING: "京ICP证000000号" })).filings.icp, "京ICP证000000号");
});

test("malformed numbers are not shown, are reported by variable name only, and stop start-up", () => {
  const bad = { SITE_ICP_FILING: "ICP-0000", SITE_PUBLIC_SECURITY_FILING: "公安备案 0000", SITE_NEWS_LICENSE: "<b>x</b>" };
  const { filings, problems } = readSiteFilings(env(bad));
  assert.deepEqual(filings, { icp: null, publicSecurity: null, newsLicense: null });
  assert.deepEqual(
    problems.map((p) => p.variable),
    ["SITE_ICP_FILING", "SITE_PUBLIC_SECURITY_FILING", "SITE_NEWS_LICENSE"],
  );
  assert.throws(
    () => assertSiteFilings(bad),
    (error: Error) =>
      /^Refusing to start: SITE_ICP_FILING is not a valid number/.test(error.message) && !Object.values(bad).some((v) => error.message.includes(v)),
  );
  assert.doesNotThrow(() => assertSiteFilings({}));
});

test("site metadata carries the configured numbers in the public contract's shape", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SITE_ICP_FILING;
    delete process.env.SITE_PUBLIC_SECURITY_FILING;
    delete process.env.SITE_NEWS_LICENSE;
    assert.deepEqual(SiteMeta.parse(siteMeta()).filings, { icp: null, publicSecurity: null, newsLicense: null });
    process.env.SITE_PUBLIC_SECURITY_FILING = "京公网安备00000000000000号";
    assert.deepEqual(siteFilings().publicSecurity, { text: "京公网安备00000000000000号", code: "00000000000000" });
    assert.equal(SiteMeta.parse(siteMeta()).filings.publicSecurity?.code, "00000000000000");
  } finally {
    for (const key of ["SITE_ICP_FILING", "SITE_PUBLIC_SECURITY_FILING", "SITE_NEWS_LICENSE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
