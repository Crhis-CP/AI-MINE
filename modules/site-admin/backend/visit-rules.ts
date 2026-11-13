// Pure rules for first-party visit statistics (TASK-0571): which beacons count as a reader page view, the page's
// route, the referring host and the device class. No database, no clock, no I/O, so each rule is unit-tested alone.
import { createHmac } from "node:crypto";

export type VisitDevice = "phone" | "tablet" | "desktop";

/**
 * Automated clients by browser string. Deliberately short: the beacon is sent by the page's script, which most
 * crawlers never run, so this only has to catch the scripted and headless clients that do.
 */
const BOTS =
  /bot\b|bot[/;_-]|spider|crawl|slurp|preview|monitor|uptime|pingdom|lighthouse|pagespeed|headless|phantomjs|selenium|puppeteer|playwright|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|undici|scrapy|httpclient|facebookexternalhit|bytespider/i;

export function isBot(userAgent: string): boolean {
  return !userAgent.trim() || BOTS.test(userAgent);
}

/** A browser fetching ahead of a click (prefetch or prerender) is not a page someone looked at. */
export function isPrefetch(headers: Record<string, string | string[] | undefined>): boolean {
  return [headers["sec-purpose"], headers.purpose, headers["x-moz"]].some((value) => /\b(?:prefetch|prerender)\b/i.test(String(value ?? "")));
}

const SEGMENT = /^[\p{L}\p{N}_~-]{1,120}$/u;
const STATIC = new Set([
  "/",
  "/all",
  "/hot",
  "/daily",
  "/daily/archive",
  "/weekly",
  "/monthly",
  "/topics",
  "/about",
  "/terms",
  "/privacy",
  "/changelog",
  "/feedback",
  "/more",
  "/starred",
  "/agent",
  "/metals",
  "/policies",
  "/policies/reports",
]);
/**
 * Reader routes with an address part (apps/web/app/routes.ts and the modules' pages). keep: the page's own address is
 * kept as its "path" (a content page, so the admin can list the most read ones); otherwise path is the route itself.
 * Order matters: the first match wins.
 */
/**
 * The countries with a page (TASK-0634), the same list as apps/web/app/features/region/home-country.ts HOME_COUNTRIES
 * (a test keeps the two equal). Any other code is the not-found page and is not counted.
 */
export const COUNTRY_PAGES: readonly string[] = ["CN", "AR"];

const DYNAMIC: ReadonlyArray<{ route: string; pattern: RegExp; keep: boolean; valid?: (segment: string) => boolean }> = [
  { route: "/country/:code", pattern: /^\/country\/([^/]+)$/, keep: true, valid: (code) => COUNTRY_PAGES.includes(code) },
  { route: "/items/:id/original", pattern: /^\/items\/([^/]+)\/original$/, keep: false },
  { route: "/items/:id", pattern: /^\/items\/([^/]+)$/, keep: true },
  { route: "/story/:id", pattern: /^\/story\/([^/]+)$/, keep: true },
  { route: "/daily/:key", pattern: /^\/daily\/([^/]+)$/, keep: true },
  { route: "/weekly/:key", pattern: /^\/weekly\/([^/]+)$/, keep: true },
  { route: "/monthly/:key", pattern: /^\/monthly\/([^/]+)$/, keep: true },
  { route: "/topics/:slug/page/:page", pattern: /^\/topics\/([^/]+)\/page\/(\d{1,4})$/, keep: false },
  { route: "/topics/:slug", pattern: /^\/topics\/([^/]+)$/, keep: true },
  { route: "/policies/reports/:id", pattern: /^\/policies\/reports\/([^/]+)$/, keep: true },
  { route: "/policies/:id/history", pattern: /^\/policies\/([^/]+)\/history$/, keep: false },
  { route: "/policies/:id", pattern: /^\/policies\/([^/]+)$/, keep: true },
  { route: "/policy-threads/:id", pattern: /^\/policy-threads\/([^/]+)$/, keep: true },
];

export interface VisitPage {
  route: string;
  path: string;
  english: boolean;
}

/**
 * The reader page a beacon names, or null when it is not one: the admin, the API, a file (anything with a dot in
 * its last part), an unknown address (the not-found page) or a malformed one. /en pages count as their Chinese
 * route with english set. A query or fragment never reaches the result.
 */
export function readerPage(raw: string): VisitPage | null {
  if (typeof raw !== "string" || raw.length > 512 || !raw.startsWith("/") || raw.startsWith("//")) return null;
  let pathname = raw.split(/[?#]/, 1)[0]!;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  let english = false;
  if (pathname === "/en" || pathname.startsWith("/en/")) {
    english = true;
    pathname = pathname.slice(3) || "/";
  }
  if (/^\/(?:admin|api)(?:\/|$)/i.test(pathname) || /\.[^/]*$/.test(pathname)) return null;
  if (STATIC.has(pathname)) return { route: pathname, path: pathname, english };
  for (const { route, pattern, keep, valid } of DYNAMIC) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    if (!SEGMENT.test(match[1]!) || (valid && !valid(match[1]!))) return null;
    return { route, path: keep ? pathname : route, english };
  }
  return null;
}

/**
 * The host of the page a visitor came from: http(s) only, lower case, without "www.". Null for no referrer, an
 * unreadable one, or one of this site's own hosts (moving between our pages is not a source).
 */
export function referrerHost(referrer: string | null | undefined, ownHosts: readonly string[]): string | null {
  if (!referrer) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  const own = ownHosts.map((h) =>
    h
      .toLowerCase()
      .replace(/:\d+$/, "")
      .replace(/^www\./, ""),
  );
  return own.includes(host) ? null : host;
}

/** Phone, tablet or desktop from the browser string. iPads that report a desktop Safari count as desktop. */
export function deviceClass(userAgent: string): VisitDevice {
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*\bMobile\b)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|HarmonyOS|OpenHarmony/i.test(userAgent)) return "phone";
  return "desktop";
}

/**
 * The network a visitor is on, for counting people rather than connections (TASK-0622). An IPv4 address is kept
 * whole. An IPv6 address is cut to its first 64 bits: phones and laptops change the rest every few hours or on every
 * reconnection (privacy addresses), which made one reader look like a new visitor each time. An IPv4 address written
 * the IPv6 way (::ffff:203.0.113.7) is the IPv4 address.
 */
export function visitorNetwork(address: string): string {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (!value.includes(":")) return value;
  const [head = "", tail] = value.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // A dotted quad at the end stands for two groups.
  const width = left.length + right.length + ((right.at(-1) ?? left.at(-1) ?? "").includes(".") ? 1 : 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - width)).fill("0"), ...right];
  if (groups.length < 4 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group) && !group.includes("."))) return value;
  // An IPv4 address carried in IPv6 (::ffff:a.b.c.d, also written ::ffff:hhhh:hhhh) is that IPv4 address, however
  // it is spelled: the same reader must not be one visitor by one spelling and another by the other (TASK-0629).
  const dotted = groups.at(-1)!.includes(".") ? groups.at(-1)! : null;
  const full = dotted ? groups.length === 7 : groups.length === 8;
  if (full && groups.slice(0, 5).every((group) => /^0{1,4}$/.test(group)) && groups[5] === "ffff") {
    if (dotted) return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(dotted) ? dotted : value;
    const high = Number.parseInt(groups[6]!, 16),
      low = Number.parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * The device behind a browser string, as coarsely as the operating system and the device class (TASK-0622). The full
 * string differs between the browsers of one phone, and inside one app from one opening to the next (WeChat writes
 * the network type and its own build into it), so hashing it counted one reader several times. The version is left
 * out on purpose: browsers freeze or reduce it differently (Chrome reports “Android 10; K” on every Android phone,
 * WeChat the real version and model), so it would split the same phone again.
 */
export function visitorDevice(userAgent: string): string {
  const system = /iPhone|iPad|iPod/i.test(userAgent)
    ? "ios"
    : /HarmonyOS|OpenHarmony/i.test(userAgent)
      ? "harmony"
      : /Android/i.test(userAgent)
        ? "android"
        : /Windows/i.test(userAgent)
          ? "windows"
          : /Macintosh|Mac OS X/i.test(userAgent)
            ? "mac"
            : /CrOS/i.test(userAgent)
              ? "chromeos"
              : /Linux|X11/i.test(userAgent)
                ? "linux"
                : "other";
  return `${system}:${deviceClass(userAgent)}`;
}

/**
 * The anonymous key of one visitor in one salt's period: 22 base64url characters (132 bits) of an HMAC over the
 * visitor's network and device. One person on one device and one network is one visitor whichever browser or app
 * opens the page. Two people with the same kind of device on the same network (a household, an office) count as
 * one, and one person who moves between Wi-Fi and mobile data counts as two: without a cookie or another stored
 * identifier, which this site does not use, neither can be told apart.
 */
export function visitorKey(salt: Uint8Array, address: string, userAgent: string): string {
  return createHmac("sha256", salt)
    .update(`${visitorNetwork(address)}\n${visitorDevice(userAgent)}`)
    .digest("base64url")
    .slice(0, 22);
}

/** First day of the Beijing month a Beijing date is in. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}
