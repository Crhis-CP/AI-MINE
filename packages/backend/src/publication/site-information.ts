import { ABOUT, SITE } from "@amp/industry/site";
import { SiteInformation, SiteInformationUpdate } from "@amp/contracts/http/private";
import { dbOf, type Db } from "../db.ts";
import { loadMetalPriceRegistry } from "./metal-prices/registry.ts";
import { requireOwner, actorOf, audit, type AdminPrincipal } from "../admin/auth.ts";
import { sha256, stableJson } from "../lib/ids.ts";
const sql = dbOf("publication");
export class SiteInformationConflict extends Error {
  readonly code = "conflict";
  constructor() {
    super("网站资料已被其他操作修改，请刷新后核对；你的输入已保留。");
  }
}
export class SiteInformationInputError extends Error {
  readonly statusCode = 400;
}
export function defaultSiteInformation() {
  return SiteInformation.parse({
    revision: 0,
    updatedAt: null,
    about: ABOUT.lead,
    contactEmail: SITE.contactEmail,
    contactPage: null,
    metalLinks: loadMetalPriceRegistry().officialLinks,
  });
}
/** A reader request only selects the current public fields; missing storage uses the existing published defaults, never a write. */
export async function loadSiteInformation(db: Db = sql) {
  const [row] = await db`SELECT revision,value,updated_at FROM publication.site_information WHERE id=1`;
  return row ? SiteInformation.parse({ ...row.value, revision: row.revision, updatedAt: new Date(row.updated_at).toISOString() }) : defaultSiteInformation();
}
export async function readManagedSiteInformation(principal: AdminPrincipal) {
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    return loadSiteInformation(tx);
  });
}
export async function saveSiteInformation(principal: AdminPrincipal, input: unknown, key: string) {
  const parsed = SiteInformationUpdate.safeParse(input);
  if (!parsed.success) throw new SiteInformationInputError("请检查关于文字、邮箱和HTTPS入口，删除重复地址后重试。");
  if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(key)) throw new SiteInformationInputError("操作编号已失效，请刷新页面后重新提交。");
  const value = parsed.data,
    actor = actorOf(principal),
    hash = sha256(stableJson(value));
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    await tx`SELECT pg_advisory_xact_lock(hashtext('site-information'))`;
    const [prior] = await tx`SELECT input_hash,result FROM publication.site_information_commands WHERE actor=${actor} AND request_key=${key}`;
    if (prior) {
      if (prior.input_hash !== hash) throw new SiteInformationConflict();
      return SiteInformation.parse(prior.result);
    }
    const before = await loadSiteInformation(tx);
    if (before.revision !== value.expected_revision) throw new SiteInformationConflict();
    const { expected_revision: _, ...fields } = value;
    const [row] = await tx`INSERT INTO publication.site_information(id,revision,value) VALUES(1,${before.revision + 1},${tx.json(fields)})
   ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value,updated_at=now() RETURNING updated_at`;
    const result = SiteInformation.parse({ ...fields, revision: before.revision + 1, updatedAt: new Date(row!.updated_at).toISOString() });
    await audit(actor, "site.information.save", "site-information", null, before, result, key, tx);
    await tx`INSERT INTO publication.site_information_commands(actor,request_key,input_hash,result) VALUES(${actor},${key},${hash},${tx.json(result)})`;
    return result;
  });
}
