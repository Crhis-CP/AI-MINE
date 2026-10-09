import { dbOf, type Db } from "../db.ts";
import { newShortId } from "../lib/ids.ts";
const sql = dbOf("publication");
export async function recordPolicyQualityWindow(id: string, validUntil: string, revoked: boolean, db: Db = sql) {
  await db`INSERT INTO publication.policy_quality_windows(id,valid_until,revoked) VALUES(${id},${validUntil},${revoked})
 ON CONFLICT(id) DO UPDATE SET valid_until=EXCLUDED.valid_until,revoked=EXCLUDED.revoked`;
}
export async function policyPublicId(kind: string, internalId: string, db: Db = sql) {
  const [r] = await db<
    { public_id: string }[]
  >`INSERT INTO publication.policy_ids(kind,internal_id,public_id) VALUES(${kind},${internalId},${`pol_${newShortId(12)}`})
  ON CONFLICT(kind,internal_id) DO UPDATE SET internal_id=EXCLUDED.internal_id RETURNING public_id`;
  return r!.public_id;
}
