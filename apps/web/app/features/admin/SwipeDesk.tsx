// The desk itself: a stack of cards answered by swipe, button or arrow key. Left “不相关”, right “可以看看”,
// up “必须看”; the label follows the direction of the drag. Reasons are optional, every answer is saved at once,
// and any answer can be taken back.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { z } from "zod";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { useAdminAction } from "./action";
import { bj } from "./format";
import { Card } from "./ui";

type Deck = z.infer<typeof privateSchemas.SwipeDeck>;
type DeckCard = Deck["cards"][number];
type Answer = z.infer<typeof privateSchemas.SwipeAnswerValue>;
type Reason = z.infer<typeof privateSchemas.SwipeReason>;

const ANSWERS: Record<Answer, { label: string; hint: string; tone: string; stamp: string }> = {
  no: { label: "← 不相关", hint: "左滑 · 不该收", tone: "border-hot/50 text-hot", stamp: "left-3 top-6 -rotate-6 border-hot text-hot" },
  yes: { label: "可以看看 →", hint: "右滑 · 留在“全部”", tone: "border-ok/50 text-ok", stamp: "right-3 top-6 rotate-6 border-ok text-ok" },
  star: {
    label: "必须看 ↑",
    hint: "上滑 · 应进精选",
    tone: "border-accent/60 text-accent",
    stamp: "left-1/2 top-3 -translate-x-1/2 border-accent text-accent",
  },
};
const SHORT: Record<Answer, string> = { no: "不相关", yes: "可以看看", star: "必须看" };
const REASONS: Array<[Reason, string]> = [
  ["important", "很重要"],
  ["off_topic", "与矿业无关"],
  ["minor", "太小"],
  ["duplicate", "重复了"],
  ["wrong_category", "分类不对"],
];
const KIND: Record<DeckCard["kind"], string> = {
  near_miss: "差一点进精选",
  near_pass: "刚过线进了精选",
  split: "两次打分意见不一",
  blocked: "被预筛拦下",
  recheck: "复查：以前给您看过",
};
const SECONDS_PER_CARD = 15;

function systemLine(card: DeckCard) {
  const score = card.score === null || card.threshold === null ? "" : `（${card.score} 分，入选线 ${card.threshold}）`;
  if (card.system === "selected") return `进了精选${score}`;
  if (card.system === "kept") return `收进“全部”，未进精选${score}`;
  return "被预筛拦下，没有收录";
}
/** The direction a drag points at, once it is far enough to mean something. */
export function swipeDirection(dx: number, dy: number, far: number): Answer | null {
  if (dy < -far && Math.abs(dy) > Math.abs(dx)) return "star";
  if (dx > far) return "yes";
  if (dx < -far) return "no";
  return null;
}

type Local = { answer: Answer | null; reasons: Reason[]; revision: number };

export function SwipeDesk({ deck }: { deck: Deck }) {
  const { run } = useAdminAction();
  const revalidator = useRevalidator();
  const [answers, setAnswers] = useState<Map<string, Local>>(
    () =>
      new Map(
        deck.cards.flatMap((card) =>
          card.answer ? [[card.articleId, { answer: card.answer.answer, reasons: card.answer.reasons, revision: card.answer.revision }]] : [],
        ),
      ),
  );
  // Answered cards in the order they were answered, so “撤销” takes back the latest one.
  const [trail, setTrail] = useState<string[]>(() =>
    deck.cards
      .filter((card) => card.answer?.answer)
      .sort((a, b) => a.answer!.at.localeCompare(b.answer!.at))
      .map((card) => card.articleId),
  );
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [flying, setFlying] = useState<Answer | null>(null);
  const [saved, setSaved] = useState("");
  const origin = useRef<{ x: number; y: number } | null>(null);
  // Saves go out one at a time, so an undo always follows the answer it takes back.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map(deck.cards.map((card) => [card.articleId, card.answer?.revision ?? 0])));

  const standing = (id: string) => answers.get(id)?.answer ?? null;
  const open = deck.cards.filter((card) => !standing(card.articleId));
  const current = open[0] ?? null;
  const next = open[1] ?? null;
  const done = deck.cards.length - open.length;

  const save = useCallback(
    (card: DeckCard, answer: Answer | null, chosen: Reason[], previous: Local | undefined) => {
      queue.current = queue.current.then(async () => {
        const expectedRevision = revisions.current.get(card.articleId) ?? 0;
        const result = await run(
          "POST",
          `/api/admin/selectbench/swipe/${deck.day}/${encodeURIComponent(card.articleId)}`,
          { requestId: crypto.randomUUID(), expectedRevision, answer, reasons: answer ? chosen : [] },
          { revalidate: false, label: `swipe:${card.articleId}:${expectedRevision}`, parse: (value) => privateSchemas.SwipeAnswer.parse(value) },
        );
        if (result) {
          revisions.current.set(card.articleId, result.revision);
          setSaved(answer ? `${SHORT[answer]} · 已保存` : "已撤销上一张");
          return;
        }
        // Not saved: put the card back the way it was, so nothing looks answered that is not.
        setAnswers((map) => {
          const copy = new Map(map);
          if (previous) copy.set(card.articleId, previous);
          else copy.delete(card.articleId);
          return copy;
        });
        setTrail((list) => (answer ? list.filter((id) => id !== card.articleId) : [...list, card.articleId]));
      });
    },
    [deck.day, run],
  );

  const decide = useCallback(
    (answer: Answer) => {
      if (!current || flying) return;
      const card = current,
        chosen = reasons,
        previous = answers.get(card.articleId);
      setFlying(answer);
      setTimeout(() => {
        setAnswers((map) => new Map(map).set(card.articleId, { answer, reasons: chosen, revision: (previous?.revision ?? 0) + 1 }));
        setTrail((list) => [...list.filter((id) => id !== card.articleId), card.articleId]);
        setReasons([]);
        setDrag(null);
        setFlying(null);
      }, 200);
      save(card, answer, chosen, previous);
    },
    [answers, current, flying, reasons, save],
  );
  const undo = useCallback(() => {
    const id = trail.at(-1);
    const card = deck.cards.find((item) => item.articleId === id);
    if (!id || !card) return;
    const previous = answers.get(id);
    setAnswers((map) => new Map(map).set(id, { answer: null, reasons: [], revision: (previous?.revision ?? 0) + 1 }));
    setTrail((list) => list.slice(0, -1));
    setReasons(previous?.reasons ?? []);
    save(card, null, [], previous);
  }, [answers, deck.cards, save, trail]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      const answer = event.key === "ArrowLeft" ? "no" : event.key === "ArrowRight" ? "yes" : event.key === "ArrowUp" ? "star" : null;
      if (answer) {
        event.preventDefault();
        decide(answer);
      } else if (event.key === "z" || event.key === "Backspace") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, undo]);
  // When the deck is finished, read the week again so the summary below includes today.
  const finished = !current;
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  useEffect(() => {
    if (finished) void queue.current.then(() => revalidate.current());
  }, [finished]);

  const pointing = flying ?? (drag ? swipeDirection(drag.dx, drag.dy, 40) : null);
  const transform = flying
    ? `translate(${flying === "no" ? -520 : flying === "yes" ? 520 : 0}px, ${flying === "star" ? -700 : 0}px) rotate(${flying === "no" ? -18 : flying === "yes" ? 18 : 0}deg)`
    : drag
      ? `translate(${drag.dx}px, ${drag.dy}px) rotate(${drag.dx / 20}deg)`
      : undefined;
  const counts = { no: 0, yes: 0, star: 0 };
  for (const value of answers.values()) if (value.answer) counts[value.answer]++;

  return (
    <div className="mx-auto w-full max-w-[460px]" data-swipe-desk>
      <div className="flex items-center justify-between text-[13px] text-ink-2">
        <span>
          今天 <b className="num text-ink">{done}</b> / {deck.cards.length} 张
          {open.length ? ` · 还需约 ${Math.max(1, Math.round((open.length * SECONDS_PER_CARD) / 60))} 分钟` : " · 已全部答完"}
        </span>
        <button type="button" className="min-h-9 px-2 text-accent disabled:text-ink-4" disabled={!trail.length} onClick={undo}>
          ↶ 撤销
        </button>
      </div>
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-bg-sunk"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={deck.cards.length}
        aria-valuenow={done}
      >
        <i className="block h-full bg-accent transition-[width]" style={{ width: `${(done / deck.cards.length) * 100}%` }} />
      </div>
      {current ? (
        <>
          <p className="mt-4 text-center text-[14px] font-medium text-ink">这条值不值得全球矿业投资者看？</p>
          <div className="relative mt-3 h-[430px] select-none">
            {(Object.keys(ANSWERS) as Answer[]).map((answer) => (
              <div
                key={answer}
                aria-hidden
                className={`pointer-events-none absolute z-20 rounded-control border-2 bg-surface px-2.5 py-1 text-[15px] font-bold transition-opacity ${ANSWERS[answer].stamp} ${pointing === answer ? "opacity-100" : "opacity-0"}`}
              >
                {SHORT[answer]}
              </div>
            ))}
            {next && <article aria-hidden className="absolute inset-0 scale-[0.96] rounded-card border border-line bg-surface opacity-60" />}
            <article
              key={current.articleId}
              data-swipe-card={current.articleId}
              className={`absolute inset-0 z-10 flex touch-none flex-col overflow-hidden rounded-card border border-line bg-raised p-4 shadow-[var(--shadow-pop)] ${drag && !flying ? "" : "transition-transform duration-200"} ${flying ? "opacity-0 transition-[transform,opacity]" : ""}`}
              style={{ transform }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest("[data-swipe-reasons]")) return;
                origin.current = { x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({ dx: 0, dy: 0 });
              }}
              onPointerMove={(event) => origin.current && setDrag({ dx: event.clientX - origin.current.x, dy: event.clientY - origin.current.y })}
              onPointerUp={() => {
                const answer = drag && origin.current ? swipeDirection(drag.dx, drag.dy, 100) : null;
                origin.current = null;
                if (answer) decide(answer);
                else setDrag(null);
              }}
              onPointerCancel={() => {
                origin.current = null;
                setDrag(null);
              }}
            >
              <span className="self-start rounded-full bg-bg-sunk px-2.5 py-0.5 text-[12px] text-ink-2">{KIND[current.kind]}</span>
              <div className="mt-2 text-[12.5px] text-ink-3">
                {current.sourceName}
                {current.discoveredAt ? ` · ${bj(current.discoveredAt, true)}` : ""}
              </div>
              <h2 className="mt-1.5 text-[18px] font-semibold leading-snug text-ink">{current.title}</h2>
              <p className="mt-2 flex-1 overflow-hidden text-[14px] leading-relaxed text-ink-2">{current.preview}</p>
              <div className="mt-2 rounded-control bg-bg-sunk px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
                系统判断：<b className="text-ink">{systemLine(current)}</b>
                {current.category && (
                  <>
                    <br />
                    分类：{(CATEGORY_LABELS as Record<string, string>)[current.category] ?? current.category}
                  </>
                )}
              </div>
              <fieldset data-swipe-reasons className="mt-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0" aria-label="理由（可不选）">
                {REASONS.map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={reasons.includes(key)}
                    onClick={() => setReasons((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]))}
                    className={`rounded-full border px-2.5 py-1 text-[12px] ${reasons.includes(key) ? "border-ink bg-ink text-bg" : "border-line text-ink-2"}`}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            </article>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {(["no", "star", "yes"] as Answer[]).map((answer) => (
              <button
                type="button"
                key={answer}
                onClick={() => decide(answer)}
                className={`flex min-h-14 flex-col items-center justify-center rounded-card border bg-surface px-1 text-[14px] font-semibold active:scale-[0.98] ${ANSWERS[answer].tone}`}
              >
                {ANSWERS[answer].label}
                <small className="mt-0.5 text-[11px] font-normal text-ink-3">{ANSWERS[answer].hint}</small>
              </button>
            ))}
          </div>
          <p className="mt-3 text-center text-[12px] text-ink-3">理由可选可不选 · 自动保存 · 随时退出 · 电脑上可用 ← → ↑ 键，Z 撤销</p>
        </>
      ) : (
        <Card className="mt-5">
          <div className="px-2 py-4 text-center">
            <h2 className="text-[18px] font-semibold text-ink">今天刷完了</h2>
            <p className="mt-1.5 text-[13.5px] text-ink-2">
              {deck.cards.length} 张，必须看 {counts.star}、可以看看 {counts.yes}、不相关 {counts.no}。每张都已保存，点“撤销”可以改最后一张。
            </p>
          </div>
        </Card>
      )}
      <p role="status" aria-live="polite" className="mt-2 h-5 text-center text-[12.5px] text-ink-3">
        {saved}
      </p>
    </div>
  );
}

/** The last seven days of answers against what the system had decided. Numbers only: proposals come in the weekly report. */
export function SwipeWeek({ summary }: { summary: Deck["summary"] }) {
  if (!summary.answered) return null;
  const cells: Array<[string, number, string]> = [
    ["您认为必须看、系统没选进精选", summary.missed, "精选可能漏了"],
    ["系统选进了精选、您认为不必", summary.extra, "精选可能多了"],
    ["系统拦下了、您认为可以收", summary.widened, "收录范围可能窄了"],
  ];
  return (
    <section aria-label="最近七天" className="mx-auto mt-8 w-full max-w-[460px]">
      <h2 className="text-[14px] font-semibold text-ink">
        最近七天：{summary.days} 天，共答 {summary.answered} 张
      </h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        必须看 {summary.star} · 可以看看 {summary.yes} · 不相关 {summary.no}
      </p>
      <ul className="mt-3 divide-y divide-line rounded-card border border-line bg-surface">
        {cells.map(([label, value, meaning]) => (
          <li key={label} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px]">
            <span className="text-ink-2">
              {label}
              <span className="ml-2 text-ink-4">{meaning}</span>
            </span>
            <b className="num text-[16px] text-ink">{value}</b>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-ink-4">这里只是数字。要不要改规则，每周会另给您一份建议，您确认后才生效。</p>
    </section>
  );
}
