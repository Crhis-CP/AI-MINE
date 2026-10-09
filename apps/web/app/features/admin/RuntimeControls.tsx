import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { LaneControlActionRequest, type LaneControlsResponse } from "@amp/contracts/http/private";
import { Badge, Button, Card, Input, ReasonDialog, Select } from "./ui";
import { bj } from "./format";

type Snapshot = z.infer<typeof LaneControlsResponse>;
type Action = z.infer<typeof LaneControlActionRequest>;
type Selection = { lane: Action["lane"]; action: Action["action"] };
const laneLabel = { news: "资讯线", policy: "法规线", all: "全部业务线" };
const switchLabel = { collection: "采集", processing: "新的模型处理", publication: "发布" };
const holderLabel = { owner: "负责人暂停", deploy: "部署保护", system: "系统保护" };

/** The view only describes explicit controls, never infers collection health from an unpaused flag. */
export function RuntimeControls({
  initial,
  onAction,
  canManage = true,
}: {
  initial: Snapshot | null;
  onAction: (action: Action) => Promise<Snapshot | null>;
  canManage?: boolean;
}) {
  const submitting = useRef(false);
  const [snapshot, setSnapshot] = useState(initial),
    [selection, setSelection] = useState<Selection | null>(null),
    [mode, setMode] = useState<Action["mode"]>("processing"),
    [expires, setExpires] = useState(""),
    [confirmedAll, setConfirmedAll] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setSnapshot(initial);
  }, [initial]);
  const close = useCallback(() => {
    if (!submitting.current) setSelection(null);
  }, []);
  const begin = (lane: Action["lane"], action: Action["action"]) => {
    const until = new Date(Date.now() + 4 * 3600_000);
    setExpires(new Date(until.getTime() - until.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    setMode("processing");
    setConfirmedAll(false);
    setError("");
    setSelection({ lane, action });
  };
  const revisions = (lane: Action["lane"]) => ({
    processing: snapshot?.owner_revisions.find((r) => r.lane === lane && r.switch === "processing")?.revision,
    collection: snapshot?.owner_revisions.find((r) => r.lane === lane && r.switch === "collection")?.revision,
  });
  return (
    <Card title="自动运行开关" className="mb-5" right={<span>已公开内容保持可读</span>}>
      {!snapshot ? (
        <p role="status" className="text-[13px] text-amber-ink">
          暂时无法读取暂停状态，请刷新后再操作；当前状态未被更改。
        </p>
      ) : (
        <>
          {!canManage && <p className="mb-3 text-[13px] text-ink-3">当前为只读状态，暂停和恢复由负责人操作。</p>}
          <div className="grid gap-4 md:grid-cols-2">
            {(["news", "policy"] as const).map((lane) => {
              const controls = snapshot.controls.filter((c) => c.lane === lane || c.lane === "all"),
                own = snapshot.controls.filter((c) => c.lane === lane && c.holder === "owner" && c.switch !== "publication"),
                available = Object.values(revisions(lane)).every((r) => r !== undefined);
              return (
                <section key={lane} className="rounded-panel border border-line px-4 py-4">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <h3 className="text-[16px] font-semibold">{laneLabel[lane]}</h3>
                    <Badge tone={controls.length ? "warn" : "ok"}>{controls.length ? "有暂停项" : "未暂停"}</Badge>
                  </div>
                  <dl className="space-y-2 text-[13px]">
                    {(["collection", "processing", "publication"] as const).map((kind) => (
                      <div key={kind} className="flex items-center justify-between gap-4">
                        <dt className="text-ink-3">{switchLabel[kind]}</dt>
                        <dd className={controls.some((c) => c.switch === kind) ? "text-amber-ink" : "text-ink-2"}>
                          {controls.some((c) => c.switch === kind) ? "已暂停" : "未暂停"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button size="sm" disabled={!canManage || !available || busy} onClick={() => begin(lane, "pause")}>
                      {own.length ? "调整暂停" : "暂停"}
                    </Button>
                    <Button size="sm" tone="primary" disabled={!canManage || !own.length || !available || busy} onClick={() => begin(lane, "resume")}>
                      恢复负责人暂停
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-[12px] leading-5 text-ink-3">暂停到期会提醒，须明确恢复。解除负责人暂停后，部署保护、系统保护和熔断仍分别生效。</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canManage || busy || Object.values(revisions("all")).some((r) => r === undefined)}
                onClick={() => begin("all", "pause")}
              >
                暂停全部业务线
              </Button>
              {snapshot.controls.some((c) => c.lane === "all" && c.holder === "owner" && c.switch !== "publication") && (
                <Button size="sm" disabled={!canManage || busy} onClick={() => begin("all", "resume")}>
                  解除全部业务线的负责人暂停
                </Button>
              )}
            </div>
          </div>
          {!!snapshot.controls.length && (
            <section className="mt-4 space-y-2" aria-label="生效中的暂停记录">
              {snapshot.controls.map((control) => (
                <div key={`${control.lane}:${control.switch}:${control.holder}`} className="rounded-control bg-bg-sunk p-3 text-[12px] leading-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>
                      {laneLabel[control.lane]} · {switchLabel[control.switch]}
                    </strong>
                    <Badge tone={control.overdue ? "bad" : "warn"}>{control.overdue ? "已到期，仍暂停" : holderLabel[control.holder]}</Badge>
                  </div>
                  <p className="mt-1 break-words text-ink-2">{control.reason}</p>
                  <p className="text-ink-3">
                    {holderLabel[control.holder]} · {control.actor} · 到期：{bj(control.expires_at, true)}（北京时间）
                  </p>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <ReasonDialog
        open={selection !== null}
        title={selection ? `${selection.action === "pause" ? "暂停" : "恢复"}${laneLabel[selection.lane]}` : "运行开关"}
        description={
          selection?.action === "pause"
            ? "选择暂停范围并填写期限与原因。已经公开的内容仍可阅读。"
            : "只解除你所选范围的负责人暂停，不会解除其他业务线或部署、系统保护。"
        }
        confirmLabel={selection?.action === "pause" ? "确认暂停" : "确认恢复"}
        danger={selection?.action === "pause"}
        busy={busy}
        onClose={close}
        onSubmit={async (reason) => {
          if (!selection || !snapshot || busy) return false;
          const rev = revisions(selection.lane),
            until = new Date(expires);
          if (rev.processing === undefined || (mode === "automatic" && rev.collection === undefined)) {
            setError("当前版本不可用，请刷新后重试。");
            return false;
          }
          if (selection.lane === "all" && !confirmedAll) {
            setError("请先确认这是对全部业务线的操作。");
            return false;
          }
          if (selection.action === "pause" && (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now())) {
            setError("请选择未来的到期时间。");
            return false;
          }
          if (selection.action === "pause" && selection.lane === "all" && mode === "automatic" && until.getTime() - Date.now() > 24 * 3600_000) {
            setError("全部业务线的全部自动处理，每次暂停最长24小时。");
            return false;
          }
          const value = LaneControlActionRequest.safeParse({
            ...selection,
            mode,
            reason,
            confirm_all: confirmedAll,
            ...(selection.action === "pause" ? { expires_at: until.toISOString() } : {}),
            expected_revisions: { processing: rev.processing, ...(mode === "automatic" ? { collection: rev.collection } : {}) },
          });
          if (!value.success) {
            setError("暂停资料不完整，请核对期限和原因。");
            return false;
          }
          setError("");
          submitting.current = true;
          setBusy(true);
          try {
            const next = await onAction(value.data);
            if (!next) {
              setError("操作尚未确认。若状态已由其他操作更改，请刷新后重新选择。");
              return false;
            }
            setSnapshot(next);
            setSelection(null);
            return true;
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <label className="block text-[13px]">
          操作范围
          <Select
            className="mt-1"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as Action["mode"]);
              setError("");
            }}
          >
            <option value="processing">仅新的模型处理</option>
            <option value="automatic">采集和新的模型处理</option>
          </Select>
        </label>
        {selection?.action === "pause" && (
          <label className="block text-[13px]">
            到期时间（按当前设备时区）
            <Input className="mt-1" type="datetime-local" required value={expires} onChange={(e) => setExpires(e.target.value)} />
            <span className="mt-1 block text-[12px] text-ink-3">到期只提醒，不会自动恢复。</span>
          </label>
        )}
        {selection?.lane === "all" && (
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-1" checked={confirmedAll} onChange={(e) => setConfirmedAll(e.target.checked)} />
            我已了解这会同时影响资讯线和法规线。
          </label>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-hot">
            {error}
          </p>
        )}
      </ReasonDialog>
    </Card>
  );
}
