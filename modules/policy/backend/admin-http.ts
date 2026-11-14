import type { FastifyInstance } from "fastify";
import { routes } from "@amp/contracts/http/private";
import { adminHandler } from "@amp/backend/admin/http";
import { actorOf, requireOwner } from "@amp/backend/admin/auth";
import { sendProblem } from "@amp/backend/http";
import { changeAdminPolicyPublication, listAdminPolicies } from "./admin.ts";

/** 法规文书 in the admin console: any signed-in operator reads the list; only the Owner changes a document's state. */
export function registerPolicyAdmin(app: FastifyInstance) {
  app.get(
    routes.adminPolicies.url,
    routes.adminPolicies,
    adminHandler(async (req) => listAdminPolicies(routes.adminPolicies.schema.querystring.parse(req.query))),
  );
  app.post(
    routes.adminPolicyPublication.url,
    routes.adminPolicyPublication,
    adminHandler(async (req, reply, admin) => {
      await requireOwner(admin);
      const { id } = routes.adminPolicyPublication.schema.params.parse(req.params);
      const result = await changeAdminPolicyPublication(id, req.body, actorOf(admin));
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这份法规文书。" });
    }),
  );
}
