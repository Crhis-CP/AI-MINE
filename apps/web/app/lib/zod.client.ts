import { config } from "zod/v4";

// Strict CSP must not even attempt Zod's Function capability probe in the browser.
config({ jitless: true });

export * from "zod/v4";
export { default } from "zod/v4";
