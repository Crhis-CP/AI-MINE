/** RFC 9309 path/group rules; Crawl-delay is the site's additional pacing constraint. */
export type RobotsRules = { rules: { path: string; allow: boolean }[]; delayMs: number; invalidDelay: boolean };
export function parseRobots(body: string, token: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules["rules"]; delays: string[]; started: boolean }[] = [];
  let group: (typeof groups)[number] | undefined;
  for (const line of body.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const pair = /^\s*([^:#]+):\s*([^#]*)/.exec(line);
    if (!pair) continue;
    const name = pair[1]!.trim().toLowerCase(),
      value = pair[2]!.trim();
    if (name === "user-agent") {
      if (!group || group.started) {
        group = { agents: [], rules: [], delays: [], started: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow", "crawl-delay"].includes(name)) {
      group.started = true;
      if (name === "crawl-delay") group.delays.push(value);
      else if (value.startsWith("/") || value.startsWith("*")) group.rules.push({ path: value, allow: name === "allow" });
    }
  }
  const own = groups.filter((g) => g.agents.some((a) => a === token.toLowerCase()));
  const selected = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  const delays = selected.flatMap((g) => g.delays),
    invalidDelay = delays.some((v) => !/^\d+(?:\.\d+)?$/.test(v) || !Number.isSafeInteger(Math.ceil(Number(v) * 1000)) || Number(v) * 1000 > 2147483647);
  return { rules: selected.flatMap((g) => g.rules), delayMs: invalidDelay ? 0 : Math.max(0, ...delays.map((v) => Math.ceil(Number(v) * 1000))), invalidDelay };
}
function canonical(value: string, pattern = false) {
  return [...value]
    .map((c) => (c === "$" ? "%24" : c === "*" && !pattern ? "%2A" : c.codePointAt(0)! > 127 ? encodeURIComponent(c) : c))
    .join("")
    .replace(/%([0-9a-f]{2})/gi, (all, hex: string) => {
      const char = String.fromCharCode(Number.parseInt(hex, 16));
      return /^[a-z0-9._~-]$/i.test(char) ? char : all.toUpperCase();
    });
}
function matches(pattern: string, path: string, anchored: boolean) {
  const parts = pattern.split("*");
  if (!path.startsWith(parts[0]!)) return false;
  if (parts.length === 1) return !anchored || path.length === pattern.length;
  let cursor = parts[0]!.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === parts.length - 1 && anchored) return path.endsWith(part) && path.length - part.length >= cursor;
    const found = path.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }
  return true;
}
export function robotsAllows(rules: RobotsRules, url: string) {
  const u = new URL(url),
    path = canonical(u.pathname + u.search);
  if (u.pathname === "/robots.txt") return true;
  if (rules.invalidDelay) return false;
  let best = -1,
    allowed = true;
  for (const rule of rules.rules) {
    const anchored = rule.path.endsWith("$"),
      pattern = canonical(anchored ? rule.path.slice(0, -1) : rule.path, true);
    if (!matches(pattern, path, anchored)) continue;
    const length = pattern.replaceAll("*", "").replace(/%[A-F0-9]{2}/g, "x").length;
    if (length > best || (length === best && rule.allow)) {
      best = length;
      allowed = rule.allow;
    }
  }
  return allowed;
}
