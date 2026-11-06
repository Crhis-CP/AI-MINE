// The site's icons as the pages declare them: files in industry/brand/, made by scripts/brand-icons.ts from the
// galaxy masters (DEC-78) and served by the api at the site root. tests/site-icons.test.ts checks every one against
// its file; the web manifest (apps/api/src/routes/static.ts) adds the 512 px and maskable icons.

/**
 * In every page's head: the small mark in favicon.ico for tabs, the app icon at multiples of 48 px for search
 * results and larger surfaces, and the opaque square that Apple rounds itself.
 */
export const ICON_LINKS = [
  { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
  { rel: "icon", type: "image/png", sizes: "96x96", href: "/icon-96.png" },
  { rel: "icon", type: "image/png", sizes: "192x192", href: "/icon-192.png" },
  { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-icon.png" },
] as const;

/** The Organization logo in structured data: the 512 px app icon (Google wants at least 112 px). */
export const LOGO_PATH = "/icon.png";
