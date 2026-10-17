import { useRouteLoaderData } from "react-router";
import { useChangelogUnread } from "../../lib/local-state";

/** Only a successfully loaded release version can show an unread marker. */
export function UnreadMark() {
  const meta = useRouteLoaderData<{ changelogVersion: string | null }>("public-layout");
  const unread = useChangelogUnread(meta?.changelogVersion);
  return unread ? <span role="img" aria-label="有未读更新" className="inline-block size-1.5 shrink-0 rounded-full bg-hot" /> : null;
}
