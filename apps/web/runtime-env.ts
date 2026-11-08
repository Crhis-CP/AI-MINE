// The web root deliberately has no platform dependency. role-config verifies this policy against config.
type Environment = Readonly<Record<string, string | undefined>>;

export function webEnvironmentProblems(env: Environment = process.env): string[] {
  return Object.keys(env)
    .filter((name) => {
      if (env[name] === undefined) return false;
      // ORIGIN_SECRET is the one secret web holds by design (TASK-0586): the value the CDN adds when it fetches from
      // us, which only proves a request came through the CDN. It opens no database, model or account.
      const credential =
        name !== "ORIGIN_SECRET" &&
        (/^(DATABASE_URL|PG|POSTGRES_)/.test(name) || /_(KEY|SECRET|SECRET_ID|TOKEN|PASSWORD|WEBHOOK_URL)$/.test(name) || name === "AMP_CREDENTIALS_DIR");
      // Same boundary as platform/config: a process-wide proxy is refused. EGRESS_PROXY_URL is not
      // used by web; holding it must not take the site down when the shared environment sets it.
      const unsafe =
        /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(name) ||
        name.startsWith("DEV_AUTH_") ||
        (name === "ALLOW_PRIVATE_NETWORK_FETCH" && /^(1|true)$/i.test(env[name]!));
      return credential || (env.NODE_ENV === "production" && unsafe);
    })
    .sort();
}

export function assertWebEnvironment(env?: Environment): void {
  const problems = webEnvironmentProblems(env);
  if (problems.length) throw new Error(`web must not hold ${problems.join(", ")}`);
}

/** Test runners and launchers select only these values; never pass a backend environment to web. */
export function webEnvironment(env: Environment): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TERM",
    "TZ",
    "NO_COLOR",
    "NODE_ENV",
    "AMP_RELEASE",
    "PORT",
    "WEB_HOST",
    "WEB_PORT",
    "SITE_URL",
    "API_BASE_URL",
    "PRIVATE_HOST",
    "WEB_ROUTE_GROUP",
    "TRUST_PROXY",
    // Per-visitor request limits (TASK-0583); defaults apply when unset.
    "RATE_LIMIT",
    "RATE_LIMIT_PAGE",
    "RATE_LIMIT_API",
    "RATE_LIMIT_WRITE",
    "RATE_LIMIT_OBSERVE",
    "CLIENT_IP_HEADER",
    // The secret header the CDN adds when it fetches from us (TASK-0586).
    "ORIGIN_SECRET",
    "ORIGIN_SECRET_HEADER",
    "ORIGIN_ENFORCE",
    // Search-console ownership codes shown on the home page (TASK-0590).
    "GOOGLE_SITE_VERIFICATION",
    "BING_SITE_VERIFICATION",
    "BAIDU_SITE_VERIFICATION",
  ];
  return Object.fromEntries(allowed.filter((name) => env[name] !== undefined).map((name) => [name, env[name]!]));
}
