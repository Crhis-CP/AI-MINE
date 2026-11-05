import { useRouteLoaderData } from "react-router";
import { useTr } from "../../i18n";
import { useChangelogUnread } from "../../lib/local-state";

/** Only a successfully loaded release version can show an unread marker. */
export function UnreadMark() {
  const tr = useTr();
  const meta = useRouteLoaderData<{ changelogVersion: string | null }>("public-layout");
  const unread = useChangelogUnread(meta?.changelogVersion);
  return unread ? <span role="img" aria-label={tr("有未读更新")} className="inline-block size-1.5 shrink-0 rounded-full bg-hot" /> : null;
}
