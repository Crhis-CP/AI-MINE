import type { JobLane } from "./jobs.ts";
import type { RedirectRule } from "./http-policy.ts";

/** A route within an installed extension; files are relative to its own folder. */
export interface ModulePage {
  path: string;
  file: string;
  id?: string;
}
export interface ModuleLayout {
  layout: string;
  id?: string;
  pages: ModulePage[];
}
/** Plain address declarations consumed by builds and servers, without loading extension handlers. */
export interface ModuleDeclaration {
  name: string;
  pages?: Array<ModulePage | ModuleLayout>;
  adminPages?: ModulePage[];
  redirects?: RedirectRule[];
  apiPaths?: RegExp[];
}
export function defineModule(module: ModuleDeclaration): ModuleDeclaration {
  return module;
}

/** A verified directory committed a changed material; an installed module owns its next processing step. */
export interface MaterialDiscovered {
  lane: JobLane;
  sourceId: string;
  materialId: string;
  directoryHash: string;
}

/** Optional marks supplied by an installed module, using local assets or a text fallback. */
export interface ModuleBrand {
  src: string | null;
  monogram: string;
  raster: boolean;
}
export interface ModuleTopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre" | "project";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
  basis: "selected" | "all";
}
export type ModuleTopicMember = import("./site.ts").FeedItemSummary;

export type ModuleNavigationCounts = Partial<Record<string, number>>;
