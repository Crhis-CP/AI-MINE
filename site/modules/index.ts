import type { ModuleDeclaration } from "@amp/contracts/modules";
import siteAdmin from "@amp/site-admin/module";
import metals from "@amp/metals/module";
/** Declarations are safe for build and routing consumers; no handlers are imported here. */
export const MODULES: readonly ModuleDeclaration[] = [metals, siteAdmin];
