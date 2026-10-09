import { LaneControlActionRequest, LaneControlsResponse } from "@amp/contracts/http/private";
import { dbOf, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { audit } from "../admin/auth.ts";
const sql = dbOf("ops");
export type RuntimeLane = "news" | "policy";
export type RuntimeSwitch = "collection" | "processing" | "publication";
export type ControlHolder = "owner" | "deploy" | "system";
type Row = {
  lane: RuntimeLane | "all";
  switch: RuntimeSwitch;
  holder: ControlHolder;
  revision: number;
  paused: boolean;
  reason: string | null;
  actor: string | null;
  expires_at: Date | null;
  updated_at: Date;
};
export class LaneControlConflict extends Error {
  readonly code = "conflict";
}
export class RuntimeControlInputError extends Error {
  readonly statusCode = 400;
}
export class RuntimeControlPaused extends Error {
  readonly code = "conflict";
  readonly retryAfterSeconds = 60;
}
export class RuntimeControlStale extends Error {
  readonly code = "conflict";
}
export type RuntimeControlSnapshot = { lane: RuntimeLane; switches: RuntimeSwitch[]; version: string; paused: boolean };
const switches: RuntimeSwitch[] = ["collection", "processing", "publication"],
  lanes = ["news", "policy", "all"] as const;
const lock = async (db: Db, exclusive = false) => {
  const [transaction] = await db`SHOW transaction_isolation`;
  if (transaction?.transaction_isolation !== "read committed") throw new RuntimeControlStale("Runtime fences require read committed transactions");
  if (exclusive) await db`SELECT pg_advisory_xact_lock(hashtext('lane-controls'))`;
  else await db`SELECT pg_advisory_xact_lock_shared(hashtext('lane-controls'))`;
};
async function rows(db: Db = sql) {
  const rows = await db<Row[]>`SELECT lane,switch,holder,revision,paused,reason,actor,expires_at,updated_at FROM ops.lane_controls ORDER BY lane,switch,holder`;
  if (rows.length !== 27) throw new Error("Runtime control records unavailable");
  return rows;
}
export async function listLaneControls() {
  const all = await rows(),
    now = Date.now();
  return LaneControlsResponse.parse({
    controls: all
      .filter((r) => r.paused)
      .map(({ paused: _paused, ...r }) => ({
        ...r,
        expires_at: r.expires_at!.toISOString(),
        updated_at: r.updated_at.toISOString(),
        overdue: r.expires_at!.getTime() <= now,
      })),
    owner_revisions: all
      .filter((r) => r.holder === "owner" && r.switch !== "publication")
      .map((r) => ({ lane: r.lane, switch: r.switch, revision: r.revision })),
  });
}
/** Expires only affect alerting. Every holder remains active until its own explicit CAS release. */
export async function runtimeControlSnapshot(lane: RuntimeLane, requested: RuntimeSwitch[], db: Db = sql): Promise<RuntimeControlSnapshot> {
  if (!["news", "policy"].includes(lane) || !requested.length || requested.some((s) => !switches.includes(s))) throw new Error("Invalid runtime control scope");
  const selected = (await rows(db)).filter((r) => (r.lane === lane || r.lane === "all") && requested.includes(r.switch));
  return {
    lane,
    switches: [...new Set(requested)].sort(),
    version: sha256(stableJson(selected.map((r) => [r.lane, r.switch, r.holder, r.revision, r.paused]))),
    paused: selected.some((r) => r.paused),
  };
}
/** The caller holds this shared fence until its business transaction commits. */
export async function assertRuntimeControl(db: Db, snapshot: RuntimeControlSnapshot, requireRunning = true) {
  await lock(db);
  const current = await runtimeControlSnapshot(snapshot.lane, snapshot.switches, db);
  if (current.version !== snapshot.version) throw new RuntimeControlStale("Lane control changed while work was in flight");
  if (requireRunning && current.paused) throw new RuntimeControlPaused("The requested lane and stage are paused");
}
export async function requireRuntimeRunning(lane: RuntimeLane, requested: RuntimeSwitch[], db: Db = sql) {
  await lock(db);
  const current = await runtimeControlSnapshot(lane, requested, db);
  if (current.paused) throw new RuntimeControlPaused("The requested lane and stage are paused");
  return current;
}
type Change = {
  lane: RuntimeLane | "all";
  switches: RuntimeSwitch[];
  holder: ControlHolder;
  action: "pause" | "resume";
  expected: Partial<Record<RuntimeSwitch, number>>;
  reason: string;
  actor: string;
  expiresAt?: string;
};
async function change(value: Change) {
  if (
    !lanes.includes(value.lane) ||
    !value.switches.length ||
    new Set(value.switches).size !== value.switches.length ||
    value.switches.some((s) => !switches.includes(s)) ||
    !value.reason.trim() ||
    !value.actor.trim()
  )
    throw new RuntimeControlInputError("运行控制参数不完整，请核对范围、原因与操作人");
  const expiry = value.expiresAt ? new Date(value.expiresAt) : null;
  if (value.action === "pause" && (!expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()))
    throw new RuntimeControlInputError("暂停到期时间必须晚于当前时间");
  if (
    value.action === "pause" &&
    value.lane === "all" &&
    value.switches.includes("collection") &&
    value.switches.includes("processing") &&
    expiry!.getTime() > Date.now() + 24 * 3600_000
  )
    throw new RuntimeControlInputError("暂停全部业务线的全部自动处理最多 24 小时，请缩短期限");
  const result = await sql.begin(async (tx) => {
    await lock(tx, true);
    const before = (await rows(tx)).filter((r) => r.lane === value.lane && r.holder === value.holder && value.switches.includes(r.switch));
    const mismatch = before.filter((r) => r.revision !== value.expected[r.switch]);
    if (mismatch.length) {
      if (value.holder !== "owner" && value.action === "resume")
        for (const r of mismatch)
          await tx`INSERT INTO ops.lane_control_conflicts(id,lane,switch,holder,expected_revision,actual_revision,actor)
    VALUES(${sha256(stableJson([r.lane, r.switch, r.holder, value.expected[r.switch], r.revision]))},${r.lane},${r.switch},${r.holder},${value.expected[r.switch] ?? -1},${r.revision},${value.actor}) ON CONFLICT DO NOTHING`;
      return false;
    }
    for (const r of before) {
      await tx`UPDATE ops.lane_controls SET paused=${value.action === "pause"},revision=revision+1,reason=${value.reason.trim()},actor=${value.actor},expires_at=${value.action === "pause" ? expiry : r.expires_at},updated_at=now()
    WHERE lane=${value.lane} AND switch=${r.switch} AND holder=${value.holder} AND revision=${r.revision}`;
      await tx`UPDATE ops.lane_control_conflicts SET resolved_at=now() WHERE lane=${value.lane} AND switch=${r.switch} AND holder=${value.holder} AND resolved_at IS NULL`;
    }
    await audit(
      value.actor,
      `lane_control.${value.action}`,
      `${value.holder}:${value.lane}:${value.switches.join("+")}`,
      value.reason,
      before,
      { ...value, expiresAt: expiry?.toISOString() },
      undefined,
      tx,
    );
    return Object.fromEntries(before.map((r) => [r.switch, r.revision + 1])) as Partial<Record<RuntimeSwitch, number>>;
  });
  if (!result) throw new LaneControlConflict("运行状态已被其他操作修改，请刷新后重新选择；未解除任何暂停");
  return result;
}
export async function changeOwnerLaneControls(input: unknown, actor: string) {
  const value = LaneControlActionRequest.parse(input);
  await change({
    lane: value.lane,
    switches: value.mode === "automatic" ? ["collection", "processing"] : ["processing"],
    holder: "owner",
    action: value.action,
    expected: value.expected_revisions,
    reason: value.reason,
    actor,
    expiresAt: value.expires_at,
  });
  return listLaneControls();
}
/** Internal controllers read their own exact inactive-or-active record versions before acquiring a new hold. */
export async function laneControlHolderRevisions(lane: RuntimeLane | "all", holder: ControlHolder) {
  return Object.fromEntries((await rows()).filter((r) => r.lane === lane && r.holder === holder).map((r) => [r.switch, r.revision])) as Record<
    RuntimeSwitch,
    number
  >;
}
/** Trusted deployment code can only change its own holder, never Owner or system records. */
export const changeDeploymentLaneControl = (input: Omit<Change, "holder">) => change({ ...input, holder: "deploy" });
export const changeSystemLaneControl = (input: Omit<Change, "holder">) => change({ ...input, holder: "system" });
export async function laneControlFindings(now = Date.now()) {
  const laneName: Record<string, string> = { news: "资讯线", policy: "法规线", all: "全部业务线" };
  const switchName: Record<string, string> = { collection: "采集", processing: "模型处理", publication: "新内容公开" };
  const holderName: Record<string, string> = { owner: "负责人", deploy: "部署保护", system: "系统保护" };
  const held = (await rows()).filter((r) => r.paused && r.expires_at!.getTime() <= now);
  const conflicts = await sql<
    { id: string; lane: string; switch: string; holder: string; occurred_at: Date }[]
  >`SELECT id,lane,switch,holder,occurred_at FROM ops.lane_control_conflicts WHERE resolved_at IS NULL ORDER BY occurred_at`;
  return [
    ...held.map((r) => ({
      key: `lane-control.expired:${r.lane}:${r.switch}:${r.holder}`,
      level: "today" as const,
      title: "运行暂停已到期，仍保持暂停",
      impact: `${laneName[r.lane]}的${switchName[r.switch]}由${holderName[r.holder]}暂停，原因：${r.reason}`,
      heals: "不会自动恢复",
      action: "核对后由原持有者明确恢复或续期",
      detail: `操作人${r.actor}；控制版本${r.revision}`,
      since: r.expires_at!,
    })),
    ...conflicts.map((r) => ({
      key: `lane-control.conflict:${r.id}`,
      level: "today" as const,
      title: "运行保护恢复遇到版本变化，已保留暂停",
      impact: `${holderName[r.holder]}未能释放${laneName[r.lane]}的${switchName[r.switch]}保护，其他持有者不受影响`,
      heals: "不会自动覆盖新的控制记录",
      action: "核对当前控制记录后明确恢复",
      detail: `控制持有者：${holderName[r.holder]}`,
      since: r.occurred_at,
    })),
  ];
}
