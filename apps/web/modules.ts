import type { ComponentType, ReactNode } from "react";
import type { ModuleTopicSummary } from "@amp/contracts/modules";

export type Part<T> = () => Promise<{ default: T }>;
export interface AgentPanelProps {
  base: string;
  tag: string | null;
  now: number;
}
export interface AgentTrack {
  key: string;
  name: string;
  short: string;
  badge?: string;
  pitch: string;
  fit: string;
  icon: ComponentType<{ size?: number }>;
  Panel: ComponentType<AgentPanelProps>;
  anchors?: string[];
}
export interface CopyTag {
  useValue: () => string;
  query: string;
  userAgent: (value: string) => string;
  Note: ComponentType;
  mcp: string;
  rss: string;
}
export interface AgentLinks {
  href: (anchor: string) => string;
  open: (anchor: string) => void;
}
export interface AgentPart {
  tracks?: AgentTrack[];
  tag?: CopyTag;
  Banner?: ComponentType<AgentPanelProps & AgentLinks>;
  blocks?: Array<{ track: string; anchor: string; Block: ComponentType<AgentPanelProps> }>;
  guideClients?: string[];
  resources?: Array<[label: string, href: string, note: string]>;
  tools?: Array<{ name: string; does: string; ask: string }>;
  mcpTroubles?: ReactNode[];
  rssLead?: string[];
  api?: { group: string; rows: Array<[path: string, does: string, often: string]> };
  recipes?: Array<{ key: string; label: string; Body: ComponentType<{ base: string; curl: string }> }>;
  apiErrors?: Array<[status: string, what: ReactNode]>;
}
export interface TopicPagePart {
  name: string;
  shows: (data: unknown, topic: ModuleTopicSummary) => boolean;
  Block: ComponentType<{ data: unknown; topic: ModuleTopicSummary }>;
  entries: (data: unknown) => Array<{ title: string; href: string | null }>;
  news: (data: unknown) => string[];
}

export interface ModuleNavigation {
  to: string;
  label: string;
  icon: (props: { size?: number }) => ReactNode;
  end?: boolean;
  sidebarAfter?: string;
  moreSection?: "内容" | "偏好";
  activePaths?: string[];
}
export interface AdminModuleNavigation {
  to: string;
  label: string;
  end?: boolean;
  owner?: boolean;
  count?: string;
  tone?: "bad" | "accent";
}
/** Browser-safe additions to the installed site's navigation. */
export interface WebModule {
  name: string;
  navigation?: ModuleNavigation[];
  /** Optional phone tabs appear after the core reading tabs and before the personal page. */
  tabs?: ModuleNavigation[];
  starred?: () => Promise<{ default: ComponentType }>;
  sidebar?: { section: string; items: ModuleNavigation[] };
  tools?: Array<{ to: string; label: string; icon: ReactNode }>;
  root?: {
    bootScript?: string;
    Top?: ComponentType;
    Bottom?: ComponentType;
    documentHeaders?: (request: Request) => Record<string, string>;
  };
  agent?: Part<AgentPart>;
  topicPage?: Part<TopicPagePart>;
  darkMarks?: string[];
  starredImports?: Array<{ label: string; run: () => Promise<{ ok: boolean; text: string }> }>;
  feedbackDraft?: { read: () => unknown; clear: () => void };
  termsLinks?: Array<{ to: string; label: string }>;
  agentWays?: string[];
  admin?: {
    content?: AdminModuleNavigation[];
    groups?: Array<{ group: string; items: AdminModuleNavigation[] }>;
    /** Account management remains available during mandatory password rotation. */
    account?: AdminModuleNavigation;
    runs?: Part<ComponentType<{ data: unknown }>>;
    landing?: string;
    prices?: string;
  };
}
export function defineWebModule(module: WebModule): WebModule {
  return module;
}
