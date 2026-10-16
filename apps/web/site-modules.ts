import { WEB_MODULES } from "@amp/site/modules/web";
import type { WebModule } from "./modules";

/** Resolve only the parts used by this page, preserving installation order. */
export async function loadParts<T>(pick: (module: WebModule) => (() => Promise<{ default: T }>) | undefined) {
  return Promise.all(
    WEB_MODULES.flatMap((module) => {
      const load = pick(module);
      return load ? [load().then(({ default: part }) => ({ name: module.name, part }))] : [];
    }),
  );
}
