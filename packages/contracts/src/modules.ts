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
