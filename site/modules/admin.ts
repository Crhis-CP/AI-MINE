import type { WebModule } from "@amp/web/modules";
import siteAdmin from "@amp/site-admin/web";
/** Private build only; public pages do not import administration entries. */
export const ADMIN_MODULES: readonly WebModule[] = [siteAdmin];
