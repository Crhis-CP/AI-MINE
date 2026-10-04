import { SITE } from "@amp/industry/site";
import type { Route } from "./+types/reconciliation";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { UsageReconciliation, type ReconciliationData } from "../../features/admin/reconciliation";
import { AdminPage } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs): Promise<ReconciliationData> {
  const data = await adminGet<ReconciliationData>(request, "/api/admin/runs");
  return {
    receipts: {
      counts: data.receipts.counts,
      issues: data.receipts.issues.map(({ id, status, service, model, purpose, subject, error }) => ({ id, status, service, model, purpose, subject, error })),
    },
    deliveries: data.deliveries.map(({ id, target_key, status, subject_kind, subject_id, updated_at }) => ({
      id,
      target_key,
      status,
      subject_kind,
      subject_id,
      updated_at,
    })),
  };
}

export const meta: Route.MetaFunction = () => [{ title: `费用与投递核对 · ${SITE.name} 后台` }];

export default function Reconciliation({ loaderData }: Route.ComponentProps) {
  const actions = useAdminAction();
  return (
    <AdminPage title="费用与投递核对" subtitle="记录供应商明确确认未计费的请求，核实未确认的投递；结果未知不会自动重发。">
      <UsageReconciliation data={loaderData} actions={actions} />
    </AdminPage>
  );
}
