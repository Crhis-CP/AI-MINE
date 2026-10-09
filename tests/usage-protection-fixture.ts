// Explicit synthetic setup only. No production fallback, price discovery, or provider request.
import defaults from "../industry/usage-controls.json" with { type: "json" };
import { dbOf, type Db } from "@amp/backend/db";
import { environmentModelMetadata } from "../packages/backend/src/providers/llm.ts";
import { registeredModelId, connectionRow, modelConfigurationHash } from "../packages/backend/src/providers/model-registry.ts";
import { usagePriceId, rateMicros } from "../packages/backend/src/providers/usage-pricing.ts";
const sql = dbOf("ai-gateway");
function isolated() {
  if (!/_(test|ci)$/.test(new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname))
    throw new Error("Synthetic pricing requires an isolated test database");
}
export async function installUsageProtectionFixture(db: Db = sql) {
  isolated();
  await db`INSERT INTO ai.usage_control_versions(version,config,actor,reason) SELECT 1,${db.json(defaults)},'synthetic-only','explicit isolated test fixture' WHERE NOT EXISTS(SELECT 1 FROM ai.usage_control_versions)`;
}
export async function installUsageFixtureForModel(key: string, db: Db = sql) {
  await installUsageProtectionFixture(db);
  const id = registeredModelId(key),
    registered = id ? await connectionRow(id, db) : null,
    env = id ? null : environmentModelMetadata(key);
  if (!registered && !env?.configuration_hash) throw new Error("Configure the synthetic model before installing its test price");
  const service = registered ? `registered:${registered.id}` : env!.service,
    model = registered ? registered.config.model : env!.model,
    hash = registered ? modelConfigurationHash(registered.config) : env!.configuration_hash;
  const price = {
    service,
    model,
    configuration_hash: hash,
    currency: "CNY",
    input_per_million_micros: registered ? rateMicros(registered.config.input_cny_per_million)! : "0",
    output_per_million_micros: registered ? rateMicros(registered.config.output_cny_per_million)! : "0",
    per_request_micros: null,
    max_request_micros: null,
    image_input_token_bound: 65536,
    protocol_input_token_allowance: 32,
    basis_url: registered ? registered.config.billing_basis : "https://synthetic-pricing.invalid",
    observed_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    valid_until: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  };
  await db`INSERT INTO ai.usage_prices(id,version,price) VALUES(${usagePriceId(service, model, hash)},1,${db.json(price)}) ON CONFLICT(id) DO UPDATE SET price=EXCLUDED.price,version=ai.usage_prices.version+1,updated_at=now()`;
}
export async function installUsageFixtureForService(service: string, db: Db = sql) {
  await installUsageProtectionFixture(db);
  const price = {
    service,
    model: "",
    configuration_hash: null,
    currency: "CNY",
    input_per_million_micros: null,
    output_per_million_micros: null,
    per_request_micros: "0",
    max_request_micros: null,
    image_input_token_bound: null,
    protocol_input_token_allowance: 0,
    basis_url: "https://synthetic-pricing.invalid",
    observed_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    valid_until: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  };
  await db`INSERT INTO ai.usage_prices(id,version,price) VALUES(${usagePriceId(service, "", null)},1,${db.json(price)}) ON CONFLICT(id) DO UPDATE SET price=EXCLUDED.price,version=ai.usage_prices.version+1,updated_at=now()`;
}
