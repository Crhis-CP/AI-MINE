/** Match the deployed site composition after each test has prepared its own environment. */
export async function buildApp() {
  const [{ buildApp: create }, { installModules }, { SERVER_MODULES }] = await Promise.all([
    import("../apps/api/src/app.ts"),
    import("@amp/backend/modules"),
    import("../site/modules/server.ts"),
  ]);
  installModules(SERVER_MODULES);
  return create();
}
