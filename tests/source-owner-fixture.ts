import { randomUUID } from "node:crypto";
import { identitySql as sql } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";

/** Real isolated Owner identity; development impersonation deliberately has no Owner privileges. */
export async function sourceOwnerHeaders() {
  const [user] = await sql`INSERT INTO admin_users(email,display_name) VALUES('source-owner@synthetic.invalid','Synthetic source Owner')
    ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id,role) VALUES(${user.id},'owner') ON CONFLICT(user_id) DO NOTHING`;
  const token = `synthetic-source-owner-${randomUUID()}`,
    csrf = `synthetic-source-csrf-${randomUUID()}`;
  await sql`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${user.id},${csrf},now()+interval '1 hour')`;
  return { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf };
}
