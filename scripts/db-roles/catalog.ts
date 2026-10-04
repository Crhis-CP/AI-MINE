import type { Db } from "@amp/backend/db";
import { roleNames, type Catalog } from "./grants.ts";

/** Read catalog metadata only; never password hashes, row contents or connection configuration. */
export async function readRoleCatalog(sql: Db, prefix = "amp"): Promise<Catalog> {
  const names = Object.values(roleNames(prefix));
  const [database] = await sql<{ database: string; actor: string; superuser: boolean; databaseOwner: string }[]>`
    SELECT current_database() AS database, current_user AS actor, r.rolsuper AS superuser, pg_get_userbyid(d.datdba) AS "databaseOwner"
    FROM pg_database d JOIN pg_roles r ON r.rolname = current_user WHERE d.datname = current_database()`;
  const schemas = Object.fromEntries(
    (await sql`SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('public','pgboss')`).map((r) => [r.nspname, r.owner]),
  );
  const tables = await sql<Catalog["tables"]>`SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls,
    ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`;
  const sequences = await sql<Catalog["sequences"]>`SELECT s.relname AS name, pg_get_userbyid(s.relowner) AS owner,
    CASE WHEN tn.nspname='public' THEN t.relname END AS table
    FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
    WHERE n.nspname='public' AND s.relkind='S' ORDER BY s.relname`;
  const policies = await sql<Catalog["policies"]>`SELECT tablename AS table, policyname AS name FROM pg_policies WHERE schemaname='public'`;
  const roles = await sql<Catalog["roles"]>`SELECT rolname AS name, rolcanlogin AS login, rolsuper AS superuser, rolcreatedb AS createdb,
    rolcreaterole AS createrole, rolreplication AS replication, rolbypassrls AS bypassrls, rolinherit AS inherit, rolconnlimit AS "connectionLimit"
    FROM pg_roles WHERE rolname=ANY(${names}::text[])`;
  const memberships = (
    await sql`SELECT pg_get_userbyid(member)||' -> '||pg_get_userbyid(roleid) AS membership FROM pg_auth_members
    WHERE pg_get_userbyid(member)=ANY(${names}::text[]) OR pg_get_userbyid(roleid)=ANY(${names}::text[])`
  ).map((r) => r.membership);
  const queueOwners = await sql<Catalog["queueOwners"]>`SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pgboss' AND c.relkind IN ('r','p','S','v','m','f')
    UNION ALL SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pgboss'
    UNION ALL SELECT t.typname, pg_get_userbyid(t.typowner) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='pgboss' AND t.typtype='e'`;
  const grants = await sql<Catalog["grants"]>`WITH objects AS (
    SELECT 'database '||datname AS object, datacl AS acl FROM pg_database WHERE datname=current_database()
    UNION ALL SELECT 'schema '||nspname, nspacl FROM pg_namespace WHERE nspname IN ('public','pgboss')
    UNION ALL SELECT n.nspname||'.'||c.relname, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','pgboss')
    UNION ALL SELECT n.nspname||'.'||c.relname||'.'||a.attname, a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','pgboss') AND a.attnum>0)
    SELECT object, CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee FROM objects CROSS JOIN LATERAL aclexplode(objects.acl) acl`;
  const defaults = await sql<Catalog["defaults"]>`SELECT pg_get_userbyid(d.defaclrole) AS owner, coalesce(n.nspname,'') AS schema,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype IN ('r','S') AND pg_get_userbyid(d.defaclrole)=ANY(${names}::text[])`;
  return { ...database, schemas, tables, sequences, policies, roles, memberships, queueOwners, grants, defaults };
}
