import metals from "@amp/metals/server";
/** Only API and worker entry points install server handlers. */
export const SERVER_MODULES = [metals] as const;
