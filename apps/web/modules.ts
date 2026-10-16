import type { ComponentType, ReactNode } from "react";

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
}
/** Browser-safe additions to the installed site's navigation. */
export interface WebModule {
  name: string;
  navigation?: ModuleNavigation[];
  starred?: () => Promise<{ default: ComponentType }>;
  admin?: {
    content?: AdminModuleNavigation[];
    groups?: Array<{ group: string; items: AdminModuleNavigation[] }>;
    /** Account management remains available during mandatory password rotation. */
    account?: AdminModuleNavigation;
  };
}
export function defineWebModule(module: WebModule): WebModule {
  return module;
}
