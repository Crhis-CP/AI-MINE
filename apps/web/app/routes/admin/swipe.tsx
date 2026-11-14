// 刷卡校准台 (TASK-0621, Owner 2026-11-09): one question per card, three answers, saved as they are given.
import { SITE } from "@amp/industry/site";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Button, Card, Empty } from "../../features/admin/ui";
import { SwipeDesk, SwipeWeek } from "../../features/admin/SwipeDesk";

export async function loader({ request }: LoaderFunctionArgs) {
  return privateSchemas.SwipeDeck.parse(await adminGet(request, "/api/admin/selectbench/swipe"));
}
export const meta: MetaFunction<typeof loader> = () => [{ title: `刷卡校准台 · ${SITE.name} 后台` }];

export default function Swipe({ loaderData: deck }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { run, pending } = useAdminAction();
  return (
    <AdminPage
      title="刷卡校准台"
      subtitle="每天一副牌，每张只问一个问题。您的回答只是记下来，每周汇总成“建议怎么改”，您确认之后规则才会变；不会立刻把哪条新闻公开、撤下或改分。"
    >
      {!deck.dealt ? (
        <Card>
          <Empty title="今天的牌还没发">
            从最近两天的新闻里挑出最值得您看一眼的：差一点进精选的、刚过线的、两次打分意见不一的、被预筛拦下的，再加几张以前答过的复查。
          </Empty>
          <div className="flex justify-center pb-5">
            <Button
              tone="primary"
              busy={!!pending}
              onClick={() =>
                run(
                  "POST",
                  "/api/admin/selectbench/swipe",
                  { requestId: crypto.randomUUID() },
                  { label: `swipe-deal:${deck.day}`, parse: (value) => privateSchemas.SwipeDeck.parse(value) },
                )
              }
            >
              发今天的牌
            </Button>
          </div>
        </Card>
      ) : deck.cards.length === 0 ? (
        <Card>
          <Empty title="今天没有需要您看的">最近两天没有新分析的新闻，明天再来。</Empty>
        </Card>
      ) : (
        <SwipeDesk key={deck.day} deck={deck} />
      )}
      <SwipeWeek summary={deck.summary} />
    </AdminPage>
  );
}
