import { apiRoleFromEnv, assertProcessEnvironment, assertPublicApiCredentials, assertProcessEnvironmentSource } from "@amp/config";

/** Explicit composition root; importing this module creates no application or database resources. */
export async function startApi(env: Readonly<Record<string, string | undefined>>): Promise<void> {
  assertProcessEnvironmentSource(env);
  const role = apiRoleFromEnv(env);
  assertProcessEnvironment(role, env);
  if (role === "public-api") assertPublicApiCredentials(env);
  // Reject an invalid role or forbidden environment before loading backend configuration or credentials.
  const { assertProductionSecrets, config, isProduction } = await import("@amp/backend/config");
  const { feishuLoginConfigured } = await import("@amp/backend/admin/auth");
  if (role === "public-api") {
    assertProductionSecrets([["auth", "PUBLIC_RATE_LIMIT_SECRET"]]);
  } else {
    assertProductionSecrets([["auth", "SESSION_SECRET"]]);
    if (isProduction && !(config.adminPassword && config.adminPassword.length >= 12) && !feishuLoginConfigured())
      throw new Error("Refusing to start in production: set ADMIN_PASSWORD (at least 12 characters) or configure Feishu sign-in");
  }
  const { closeDb, initializeDb } = await import("@amp/backend/db");
  const { stopBoss } = await import("@amp/backend/jobs/queue");
  const { startHeartbeat } = await import("@amp/backend/operations/heartbeat");
  const { startWorkerWatchdog } = await import("@amp/backend/operations/watch");
  const { buildApp } = await import("./app.ts");
  await initializeDb(role, env);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp(role);
    await app.listen({ port: config.apiPort, host: env.API_HOST || "127.0.0.1" });
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await closeDb();
    }
    throw error;
  }
  const timers = role === "private-api" ? [startHeartbeat(`private-api:${config.apiPort}`), startWorkerWatchdog()] : [];
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    try {
      await app?.close();
    } finally {
      try {
        if (role === "private-api") await stopBoss();
      } finally {
        await closeDb();
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
