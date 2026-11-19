// The event engine as the rest of the system calls it: grouping a report into a fact and an event, the sweeps
// that repair and re-merge, and the manual operations of the admin (detach, regroup, merge) and of withdrawal.
// Every production caller comes through this file, so the rewrite of the engine (DEC-79) switches here and
// nowhere else. Today each operation is the implementation in group.ts and merge.ts.
export {
  captureEventWithdrawal,
  type Consolidation,
  consolidate,
  deferHistoricalSelection,
  detachArticleFromFactTx,
  factArticleIds,
  type GroupOptions,
  type GroupResult,
  GroupingSupersededError,
  groupArticle,
  invalidateWithdrawalStories,
  linkRelatedStories,
  recoverPendingGroupings,
  type RemergeResult,
  remergeSingleReportFacts,
  removeAutomaticDateMembership,
  requestArticleRegroup,
  resumeSignalRematch,
  withdrawalEventMembers,
} from "./group.ts";
export { mergeStoryInto } from "./merge.ts";
