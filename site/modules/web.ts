import type { WebModule } from "@amp/web/modules";
import metals from "@amp/metals/web";
/** Browser-safe installations; server handlers have a separate entry. */
export const WEB_MODULES: readonly WebModule[] = [metals];
