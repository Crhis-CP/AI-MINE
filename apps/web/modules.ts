import type { ReactNode } from "react";

export interface ModuleNavigation {
  to: string;
  label: string;
  icon: (props: { size?: number }) => ReactNode;
  end?: boolean;
}
/** Browser-safe additions to the installed site's navigation. */
export interface WebModule {
  name: string;
  navigation?: ModuleNavigation[];
}
export function defineWebModule(module: WebModule): WebModule {
  return module;
}
