// The web root deliberately has no platform dependency. role-config verifies this policy against config.
type Environment = Readonly<Record<string, string | undefined>>;

export function webEnvironmentProblems(env: Environment = process.env): string[] {
  return Object.keys(env)
    .filter((name) => {
      if (env[name] === undefined) return false;
      const credential =
        /^(DATABASE_URL|PG|POSTGRES_)/.test(name) || /_(KEY|SECRET|SECRET_ID|TOKEN|PASSWORD|WEBHOOK_URL)$/.test(name) || name === "AMP_CREDENTIALS_DIR";
      const unsafe =
        /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|EGRESS_PROXY_URL)$/i.test(name) ||
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
    "PORT",
    "WEB_HOST",
    "WEB_PORT",
    "SITE_URL",
    "API_BASE_URL",
    "PRIVATE_API_BASE_URL",
    "PRIVATE_HOST",
    "TRUST_PROXY",
  ];
  return Object.fromEntries(allowed.filter((name) => env[name] !== undefined).map((name) => [name, env[name]!]));
}
