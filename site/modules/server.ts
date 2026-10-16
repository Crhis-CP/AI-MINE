import siteAdmin from "@amp/site-admin/server";
import metals from "@amp/metals/server";
/** Only API and worker entry points install server handlers. */
export const SERVER_MODULES = [metals, siteAdmin] as const;
