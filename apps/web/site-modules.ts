import { WEB_MODULES } from "@amp/site/modules/web";
import type { WebModule } from "./modules";

/** Resolve page parts in installation order; private pages pass their admin manifest. */
export async function loadParts<T>(pick: (module: WebModule) => (() => Promise<{ default: T }>) | undefined, modules: readonly WebModule[] = WEB_MODULES) {
  return Promise.all(
    modules.flatMap((module) => {
      const load = pick(module);
      return load ? [load().then(({ default: part }) => ({ name: module.name, part }))] : [];
    }),
  );
}
