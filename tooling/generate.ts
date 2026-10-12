import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { createJsonSchemaTransform, createJsonSchemaTransformObject, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import openapiTS, { astToString } from "openapi-typescript";
import { z } from "zod";
import * as publicContracts from "@amp/contracts/http/public";
import * as privateContracts from "@amp/contracts/http/private";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputs = new Map<string, string>();
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, ordered(item)]),
  );
}
const format = (file: string, content: string) =>
  execFileSync(path.join(root, "node_modules/.bin/biome"), ["format", `--stdin-file-path=${file}`], {
    cwd: root,
    input: content,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });

for (const [audience, contracts] of [
  ["public", publicContracts],
  ["private", privateContracts],
] as const) {
  const registry = z.registry<{ id?: string; [key: string]: unknown }>();
  for (const [id, schema] of Object.entries(contracts.schemas)) registry.add(schema, { id });
  const app = Fastify({ logger: false });
  app.setSerializerCompiler(serializerCompiler);
  app.setValidatorCompiler(validatorCompiler);
  try {
    await app.register(swagger, {
      openapi: { openapi: "3.1.0", info: { title: `AI矿策 ${audience}`, version: audience === "private" ? "0.3.0" : "0.2.0" } },
      transform: createJsonSchemaTransform({ schemaRegistry: registry }),
      transformObject: createJsonSchemaTransformObject({ schemaRegistry: registry }),
    });
    // Declaration-only server: it never listens or imports backend handlers.
    for (const route of Object.values(contracts.routes)) app.route({ ...route, handler: () => undefined });
    await app.ready();
    const document = app.swagger();
    if (audience === "public") {
      for (const [routePath, pathItem] of Object.entries(document.paths ?? {})) {
        if (!routePath.startsWith("/api/v3/")) continue;
        const responses = pathItem?.get?.responses;
        if (!responses) continue;
        for (const status of ["200", "304", "429", "503"]) {
          const response = responses[status];
          if (!response || "$ref" in response) continue;
          const headers: Record<string, { description: string; schema: { type: "string"; enum?: string[]; pattern?: string } }> = {
            "Cache-Control": { description: "每次请求重新确认当前公开资格；不保存响应副本。", schema: { type: "string", enum: ["no-store"] } },
          };
          if ((status === "200" || status === "304") && routePath !== "/api/v3/freshness")
            headers.ETag = { description: "当前公开表示的弱实体标签；不包含每次请求的生成时刻。", schema: { type: "string" } };
          if (status === "429" || status === "503")
            headers["Retry-After"] = { description: "建议等待的秒数。", schema: { type: "string", pattern: "^[0-9]+$" } };
          response.headers = { ...response.headers, ...headers };
        }
      }
    }
    const json = `${JSON.stringify(ordered(document), null, 2)}\n`;
    outputs.set(`reference/contracts/${audience}.openapi.json`, json);
    if (audience === "public") {
      const source = JSON.parse(json);
      const paths = Object.fromEntries(Object.entries(source.paths).filter(([name]) => name.startsWith("/api/v3/")));
      const used = new Set<string>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
            const name = child.slice("#/components/schemas/".length);
            if (!used.has(name)) {
              used.add(name);
              visit(source.components?.schemas?.[name]);
            }
          } else visit(child);
        }
      };
      visit(paths);
      const schemas = Object.fromEntries([...used].map((name) => [name, source.components.schemas[name]]));
      outputs.set(
        "reference/contracts/v3.openapi.json",
        `${JSON.stringify(ordered({ openapi: "3.1.0", info: { title: "AI矿策公开 API", version: "3.0.0" }, paths, components: { schemas } }), null, 2)}\n`,
      );
    }
    const prefix = `packages/api-client/src/${audience}`;
    outputs.set(`${prefix}.types.ts`, format(`${prefix}.types.ts`, astToString(await openapiTS(json, { alphabetize: true }))));
    const name = audience === "public" ? "Public" : "Private";
    outputs.set(
      `${prefix}.ts`,
      format(
        `${prefix}.ts`,
        `// Generated by pnpm contracts:gen; do not edit.\nimport createClient, { type ClientOptions } from "openapi-fetch";\nimport type { paths } from "./${audience}.types.ts";\nexport { schemas as ${audience}Schemas } from "@amp/contracts/http/${audience}";\nexport const create${name}Client = (options: ClientOptions) => createClient<paths>(options);\n`,
      ),
    );
  } finally {
    await app.close();
  }
}
const hashes = Object.fromEntries([...outputs].map(([file, content]) => [file, createHash("sha256").update(content).digest("hex")]));
outputs.set("reference/contracts/manifest.json", `${JSON.stringify(hashes, null, 2)}\n`);
if (process.argv.includes("--check")) {
  const changed = [...outputs]
    .filter(([file, content]) => {
      try {
        return readFileSync(path.join(root, file), "utf8") !== content;
      } catch {
        return true;
      }
    })
    .map(([file]) => file);
  for (const dir of ["reference/contracts", "packages/api-client/src"]) {
    for (const file of readdirSync(path.join(root, dir))) if (!outputs.has(`${dir}/${file}`)) changed.push(`${dir}/${file}`);
  }
  if (changed.length) throw new Error(`Contract drift: ${changed.join(", ")}`);
} else {
  for (const [file, content] of outputs) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}
