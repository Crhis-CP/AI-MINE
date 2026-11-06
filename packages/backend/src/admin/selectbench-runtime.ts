import { analysisPromptLayout, config } from "../config.ts";
import { SELECTION, MAJOR_COMPANIES } from "@amp/industry/selection";
import { promptText } from "@amp/backend/editorial/prompts";
import { promptVersionsFor, scoreStandardVersion } from "@amp/backend/editorial/analyze";
import * as modelPorts from "@amp/backend/admin/models";
import { sha256, stableJson } from "../lib/ids.ts";
import type { Db } from "../db.ts";
import type { z } from "zod";
import { SelectionModelIdentity } from "@amp/contracts/http/private";
export type ModelIdentityPort = (
  capability: "score",
  db?: Db,
) => Promise<{ key: string; service: string | null; requestedModel: string | null; configuration_hash: string | null }>;
/** Compatibility with the parallel model-registry checkpoint: absent identity is unknown, never a fabricated hash. */
export async function currentSelectionModel(db?: Db, port?: ModelIdentityPort): Promise<z.infer<typeof SelectionModelIdentity>> {
  const read = port ?? (modelPorts as unknown as { currentModelConfiguration?: ModelIdentityPort }).currentModelConfiguration;
  try {
    if (read) {
      const row = await read("score", db);
      return SelectionModelIdentity.parse({
        model: row.key,
        configurationHash: row.configuration_hash,
        state: row.configuration_hash ? "known" : "unknown",
        reason: row.configuration_hash ? null : "当前模型配置身份尚未取得",
      });
    }
    return { model: "unavailable", configurationHash: null, state: "unknown", reason: "当前运行版本尚未提供模型配置身份" };
  } catch {
    return { model: "unavailable", configurationHash: null, state: "unknown", reason: "当前模型配置暂不可核实" };
  }
}
/** The score standard as the configured prompt layout sends it: a layout switch is a new standard to confirm. */
export function selectionStandardSnapshot() {
  const text = promptText("selection-score", { majorCompanies: MAJOR_COMPANIES.join("、") }),
    layout = analysisPromptLayout(),
    standardVersion = scoreStandardVersion(layout);
  return {
    standardVersion,
    contentHash: sha256(text),
    prefilterVersion: promptVersionsFor(layout).prefilter,
    thresholdVersion: sha256(stableJson(SELECTION.thresholds)),
    thresholds: SELECTION.thresholds,
    text,
    prefilterText: promptText("prefilter"),
    deploymentConfirmedVersion: config.selectionConfirmedVersion,
    // SELECTION_CONFIRMED_VERSION binds the whole score recipe (prompt in this layout plus weights), as scoringConfirmed reads it.
    configuredForCurrent: config.selectionConfirmedVersion === promptVersionsFor(layout).score,
    effectiveAt: null,
  };
}

export async function selectionModelIdentity(key: string, db?: Db) {
  const read = (modelPorts as unknown as { modelConfigurationIdentity?: (key: string, db?: Db) => ReturnType<ModelIdentityPort> }).modelConfigurationIdentity;
  if (read) {
    try {
      return (await read(key, db)).configuration_hash;
    } catch {
      return null;
    }
  }
  const current = await currentSelectionModel(db);
  return current.model === key ? current.configurationHash : null;
}
