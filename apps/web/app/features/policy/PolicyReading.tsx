import { useEffect, useRef, useState } from "react";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { Policy } from "@amp/contracts/http/public";
import { actionClass, EvidenceLinks } from "./PolicyUI";

type Page = ReturnType<typeof publicSchemas.PolicyReadingPage.parse>;
type Expression = Policy["expressions"][number];
type Stream = { rows: Page["blocks"]; total: number; next: string | null; loaded: boolean; busy: boolean; error: boolean };
const blank = (): Stream => ({ rows: [], total: 0, next: null, loaded: false, busy: false, error: false });
function label(expression: Expression) {
  return expression.kind === "ai_translation"
    ? "AI 翻译（非官方译文）"
    : expression.kind === "official_translation"
      ? `官方中文译本（发布机关：${expression.issuing_body}）`
      : expression.language.startsWith("zh")
        ? "正文"
        : `原文 · ${expression.language}`;
}
function Block({ block, language }: { block: Page["blocks"][number]; language: string }) {
  return (
    <div className="min-w-0 py-3 text-[15px] leading-7 text-ink-2" lang={language}>
      {block.kind === "heading" ? <h3 className="font-semibold text-ink">{block.text}</h3> : <p className="whitespace-pre-wrap break-words">{block.text}</p>}
      {block.table_rows && (
        <section
          aria-label={`${block.block_id} ${language}表格`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Table scroll regions need keyboard access.
          tabIndex={0}
          className="mt-2 overflow-x-auto rounded-control border border-line"
        >
          <table className="min-w-full text-[13px]">
            <caption className="sr-only">{block.block_id} 表格</caption>
            <tbody>
              {block.table_rows.map((row, i) => (
                <tr key={JSON.stringify(block.table_rows!.slice(0, i + 1))}>
                  {row.map((cell, n) => (
                    <td key={JSON.stringify(row.slice(0, n + 1))} className="border border-line px-3 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <EvidenceLinks ids={block.evidence_ids} />
      {block.links.map((link) => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="ml-2 text-[12px] text-accent underline">
          {link.label} ↗
        </a>
      ))}
    </div>
  );
}
export function PolicyReading({ policy, history, onInvalid }: { policy: Policy; history: boolean; onInvalid: () => void }) {
  const selected = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  const original =
    selected?.kind !== "original"
      ? policy.expressions.find((e) => e.policy_version_id === selected?.policy_version_id && e.kind === "original" && e.reading_state === "complete")
      : undefined;
  const [compare, setCompare] = useState(false),
    [originalOnPhone, setOriginalOnPhone] = useState(false);
  const [streams, setStreams] = useState<Record<string, Stream>>({});
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const requests = useRef(new Map<string, AbortController>()),
    mounted = useRef(true);
  const update = (id: string, value: Stream) => {
    streamsRef.current = { ...streamsRef.current, [id]: value };
    setStreams(streamsRef.current);
  };
  const load = async (expression: Expression) => {
    const old = streamsRef.current[expression.id] ?? blank();
    if (old.busy || (old.loaded && !old.next)) return;
    const controller = new AbortController();
    requests.current.set(expression.id, controller);
    update(expression.id, { ...old, busy: true, error: false });
    try {
      const client = createPublicClient({ baseUrl: window.location.origin });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      let cursor = old.next ?? (expression.id === selected?.id ? policy.reading?.next_cursor : null);
      if (!old.loaded && expression.id !== selected?.id) {
        const context = await client.GET("/api/site/policies/{id}", {
          params: {
            path: { id: policy.id },
            query: {
              expression_id: expression.id,
              ...(history ? { policy_version_id: expression.policy_version_id, document_revision_id: expression.document_revision_id } : {}),
            },
          },
          cache: "no-cache",
          signal,
        });
        if ([404, 409, 410].includes(context.response.status)) {
          onInvalid();
          return;
        }
        if (!context.response.ok) throw new Error("unavailable");
        const chosen = publicSchemas.Policy.parse(context.data);
        if (
          chosen.selected_policy_version_id !== expression.policy_version_id ||
          chosen.reading?.expression_id !== expression.id ||
          chosen.reading.document_revision_id !== expression.document_revision_id
        ) {
          onInvalid();
          return;
        }
        cursor = chosen.reading.next_cursor;
      }
      const result = await client.GET("/api/site/policies/{id}/reading", {
        params: {
          path: { id: policy.id },
          query: { expression_id: expression.id, document_revision_id: expression.document_revision_id, limit: 20, ...(cursor ? { cursor } : {}) },
        },
        cache: "no-cache",
        signal,
      });
      if ([404, 409, 410].includes(result.response.status)) {
        onInvalid();
        return;
      }
      if (!result.response.ok) throw new Error("unavailable");
      const next = publicSchemas.PolicyReadingPage.parse(result.data);
      if (next.expression_id !== expression.id || next.document_revision_id !== expression.document_revision_id || next.subject_id !== policy.id) {
        onInvalid();
        return;
      }
      if (!controller.signal.aborted && mounted.current)
        update(expression.id, {
          rows: [...old.rows, ...next.blocks],
          total: next.total_blocks,
          next: next.next_cursor,
          loaded: true,
          busy: false,
          error: false,
        });
    } catch {
      if (!controller.signal.aborted && mounted.current) update(expression.id, { ...old, busy: false, error: true });
    } finally {
      if (requests.current.get(expression.id) === controller) requests.current.delete(expression.id);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: The parent keys each reader by immutable expression and revision.
  useEffect(() => {
    mounted.current = true;
    if (selected && ["complete", "partial"].includes(selected.reading_state)) void load(selected);
    return () => {
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
    };
  }, []);
  if (!selected || selected.reading_state === "unavailable" || selected.reading_state === "restricted")
    return <p className="text-[13px] text-ink-3">暂无可展示的完整正文，请查阅官方原文入口。</p>;
  const current = streams[selected.id] ?? blank(),
    other = original ? streams[original.id] : undefined;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-ink-3">
        <p>
          {label(selected)} · 已载入 {current.rows.length} / {current.loaded ? current.total : (policy.reading?.total_blocks ?? 0)} 个原文节点
        </p>
        {original && (
          <button
            type="button"
            className={actionClass}
            aria-pressed={compare}
            onClick={() => {
              setCompare(!compare);
              if (!compare) void load(original);
            }}
          >
            {compare ? "仅看中文" : "对照原文"}
          </button>
        )}
      </div>
      {compare && (
        <div className="mt-3 flex gap-2 md:hidden">
          <button className={actionClass} type="button" aria-pressed={!originalOnPhone} onClick={() => setOriginalOnPhone(false)}>
            中文
          </button>
          <button className={actionClass} type="button" aria-pressed={originalOnPhone} onClick={() => setOriginalOnPhone(true)}>
            原文
          </button>
        </div>
      )}
      <div className="mt-3 divide-y divide-line-soft">
        {current.rows.map((block) => (
          <div id={`node-${block.block_id}`} key={block.block_id} className={`scroll-mt-20 ${compare ? "md:grid md:grid-cols-2 md:gap-6" : ""}`}>
            <div className={compare && originalOnPhone ? "hidden md:block" : ""}>
              <Block block={block} language={selected.language} />
            </div>
            {compare && (
              <div className={!originalOnPhone ? "hidden md:block" : ""}>
                {other?.rows.find((row) => row.block_id === block.block_id) ? (
                  <Block block={other.rows.find((row) => row.block_id === block.block_id)!} language={original!.language} />
                ) : (
                  <p className="py-3 text-[12px] text-ink-4">对应原文节点尚未载入。</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {(current.error || other?.error) && (
        <p role="status" className="mt-3 text-[13px] text-amber-ink">
          暂时无法继续读取，已载入的内容仍保留。请重试。
        </p>
      )}
      {(current.busy || other?.busy) && (
        <p role="status" className="mt-3 text-[13px] text-ink-4">
          正在读取正文…
        </p>
      )}
      {current.error || current.next || !current.loaded || (compare && (other?.error || other?.next)) ? (
        <button
          type="button"
          disabled={current.busy || other?.busy}
          className={`${actionClass} mt-3`}
          onClick={() => {
            void load(selected);
            if (compare && original) void load(original);
          }}
        >
          {current.error || other?.error ? "重新读取正文" : "继续读取正文"}
        </button>
      ) : (
        <p className="mt-3 text-[12px] text-ink-4">
          {policy.reading?.completeness === "complete" && current.rows.length === current.total
            ? "已载入全部正文节点。"
            : "已载入当前可读节点；不能视为完整正文。"}
        </p>
      )}
    </div>
  );
}
