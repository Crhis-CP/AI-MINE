import { SITE } from "@amp/industry/site";
import type { Route } from "./+types/reconciliation";
import { loadReconciliation } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { UsageReconciliation, type ReconciliationData } from "../../features/admin/reconciliation";
import { AdminPage } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs): Promise<ReconciliationData> {
  const data = await loadReconciliation(request);
  return {
    receipts: {
      counts: data.receipts.counts,
      issues: data.receipts.issues.map(({ id, status, service, model, purpose, subject, error, attempts, updated_at, version }) => ({
        id,
        status,
        service,
        model,
        purpose,
        subject,
        error,
        attempts,
        updated_at,
        version,
      })),
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
    <AdminPage title="费用与投递核对" subtitle="资讯分析请求结果未知满30分钟可自动重试一次，原未知费用保留；再次未知需核对。人工放行仅限供应商确认未计费。">
      <UsageReconciliation data={loaderData} actions={actions} />
    </AdminPage>
  );
}
