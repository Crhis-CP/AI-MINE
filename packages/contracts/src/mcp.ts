// Public MCP tool identities are fixed contracts; site presentation does not rename them.
export const MCP_TOOL_NAMES = {
  latest: "aiminingpolicy_get_latest",
  search: "aiminingpolicy_search",
  hot: "aiminingpolicy_get_hot_topics",
  story: "aiminingpolicy_get_story",
  daily: "aiminingpolicy_get_daily",
} as const;

export const MCP_TOOLS = Object.values(MCP_TOOL_NAMES).map((name) => ({ name }));
