// The about page's "how it works" (TASK-0654): six steps, 收集 → 预筛 → 合并 → 评分 → 写作 → 出版. The server renders
// the whole stage list with its explanations and the site's real figures, so the page reads without scripts; the
// moving river (pipeline-canvas.ts) is loaded and mounted in the browser only. Figures come from SiteStats alone:
// a figure the statistics do not carry is not shown. Hover, focus or a tap picks a step and shows what it does.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SiteStats } from "@amp/contracts/site";
import { EDITION_TIMES } from "@amp/industry/site";
import { useTr, type Tr } from "../../i18n";
import type { PipelineHandle, PipelineLabels } from "./pipeline-canvas";
import "./pipeline-flow.css";

type StatKey = "sources" | "collected" | "selected" | "dailies";
interface Figure {
  key: StatKey;
  label: string;
  value: number;
  gold?: boolean;
}
interface Stage {
  title: string;
  sum: string;
  text: string;
  illus?: ReactNode;
  notes?: ReactNode;
  figures: Figure[];
}

const count = (n: number) => n.toLocaleString("en-US");

function Icon({ d, fill = false, width = 1.5, className = "pf-glyph" }: { d: string; fill?: boolean; width?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
const ICON = {
  pick: "M9.3 1.5 3.4 9.1h4.1l-.9 5.4 6-7.7H8.5z",
  daily: "M2 4a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 12 4v9.5H3.5A1.5 1.5 0 0 1 2 12zM12 6h2v5.8a1.7 1.7 0 0 1-3.4 0M4.5 5.5h5M4.5 8h5M4.5 10.5h3",
  hot: "M8 1.8c.5 2.4 3.8 3.7 3.8 7.3a3.8 3.8 0 0 1-7.6 0c0-1.7.9-2.7 1.7-3.3.1 1.3.7 2.1 1.4 2.4C7.2 6.4 7.4 4.1 8 1.8z",
  all: "M5.5 4h8M5.5 8h8M5.5 12h8M2.6 4h.1M2.6 8h.1M2.6 12h.1",
  policy: "M8 2.2v11.3M4 13.5h8M3.2 4.6h9.6M3.2 4.6 1.6 8.8a1.7 1.7 0 0 0 3.2 0zM12.8 4.6l-1.6 4.2a1.7 1.7 0 0 0 3.2 0z",
  official: "M2 6.2 8 2.8l6 3.4M3.4 6.6v5.2M6.4 6.6v5.2M9.6 6.6v5.2M12.6 6.6v5.2M2 13.4h12",
  company: "M2 13.5h12M3 13.5V7l3.5-2.5v9M6.5 13.5V3h6.5v10.5M9 5.5h1.5M9 8h1.5M9 10.5h1.5",
  media: "M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3zM4.5 6h4M4.5 8.5h7M4.5 11h7",
  place: "M8 14.5s4.8-4.3 4.8-8a4.8 4.8 0 0 0-9.6 0c0 3.7 4.8 8 4.8 8zM8 4.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z",
};
/** The outputs, in the order of the docks: 精选, 日报, 热点榜, 全部, 法规. */
const OUTPUTS = [
  { name: "精选", icon: ICON.pick, fill: true, gold: true },
  { name: "日报", icon: ICON.daily, fill: false, gold: true },
  { name: "热点榜", icon: ICON.hot, fill: false, gold: false },
  { name: "全部", icon: ICON.all, fill: false, gold: false },
  { name: "法规", icon: ICON.policy, fill: false, gold: false },
] as const;
const LANGUAGES = [
  ["中文", "--lang-zh"],
  ["English", "--lang-en"],
  ["Español", "--lang-es"],
  ["Português", "--lang-pt"],
  ["其他语言", "--lang-other"],
] as const;

function figuresOf(stats: SiteStats | null, tr: Tr): Record<StatKey, Figure> | null {
  if (!stats) return null;
  return {
    sources: { key: "sources", label: tr("在用资讯来源"), value: stats.sources },
    collected: { key: "collected", label: tr("过去 24 小时收到"), value: stats.day.collected },
    selected: { key: "selected", label: tr("过去 24 小时入选精选"), value: stats.day.selected, gold: true },
    dailies: { key: "dailies", label: tr("已出日报"), value: stats.dailies },
  };
}

function stagesOf(stats: SiteStats | null, tr: Tr): Stage[] {
  const f = figuresOf(stats, tr);
  const name = (text: (typeof OUTPUTS)[number]["name"]) => tr(text).trim();
  return [
    {
      title: tr("收集"),
      sum: stats ? tr("{count} 个来源，多国多语言", { count: count(stats.sources) }) : tr("多国多语言的资讯来源"),
      text: tr("我们跟踪各国的资讯来源，语言有中文、English、Español、Português 等。系统定时去每个来源取回新报道。"),
      illus: (
        <ul className="pf-kinds">
          {(
            [
              [ICON.official, tr("官方"), tr("各国政府和监管机构的公告")],
              [ICON.company, tr("企业"), tr("矿企的新闻稿和交易所公告")],
              [ICON.media, tr("媒体"), tr("矿业和金属行业媒体的报道")],
            ] as const
          ).map(([icon, title, text]) => (
            <li key={title} className="pf-row">
              <span className="pf-ic">
                <Icon d={icon} width={1.4} />
              </span>
              <b>{title}</b>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ),
      figures: f ? [f.sources, f.collected] : [],
    },
    {
      title: tr("预筛"),
      sum: tr("AI 判断是否和金属矿业有关"),
      text: tr("AI 先把每篇读一遍，判断它讲的是不是金属矿业，或者会不会影响金属矿业。只挡掉明显无关的；拿不准的，照常往下走。"),
      illus: (
        <div className="pf-eg">
          <div className="pf-eg-col">
            <span className="pf-eg-h">{tr("留下")}</span>
            <span>{tr("智利铜矿工人罢工")}</span>
            <span>{tr("印尼调整镍矿出口政策")}</span>
          </div>
          <div className="pf-eg-col" data-drop="">
            <span className="pf-eg-h">{tr("挡掉")}</span>
            <span>{tr("动力煤周度价格")}</span>
            <span>{tr("某市砂石厂招标")}</span>
          </div>
          <p className="pf-eg-note">{tr("示例标题")}</p>
        </div>
      ),
      notes: (
        <ul className="pf-notes">
          <li className="pf-note">{tr("单纯讲煤炭、铀、砂石的消息不在收录范围。")}</li>
        </ul>
      ),
      figures: [],
    },
    {
      title: tr("合并"),
      sum: tr("多家报道，合成一个事件"),
      text: tr("几家来源报道同一件事时，合成一个事件，并标出有几家来源。后续进展会接着并进来；想核对时，每一家的原文都能打开。"),
      figures: [],
    },
    {
      title: tr("评分"),
      sum: tr("五个方面，合成 0–100 分"),
      text: tr("AI 从五个方面给每个事件打分，再合成 0–100 的 AI 评分。分数过了精选线，就进入精选。"),
      illus: (
        <dl className="pf-axes">
          {(
            [
              [tr("份量"), tr("这件事本身有多重要")],
              [tr("新信息"), tr("带来了多少新事实")],
              [tr("证据"), tr("材料能不能撑住说法")],
              [tr("影响面"), tr("牵动多少企业、地区和市场")],
              [tr("可用性"), tr("能否据此调整经营、合规或投资")],
            ] as const
          ).map(([term, text]) => (
            <div key={term} className="pf-axis">
              <dt>{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      ),
      notes: (
        <ul className="pf-notes">
          <li className="pf-note">{tr("离精选线近的，会再独立评一次，按平均分算。")}</li>
          <li className="pf-note">{tr("分数很低的不放进“全部”列表，但不会删除，搜索仍能找到。")}</li>
        </ul>
      ),
      figures: f ? [f.selected] : [],
    },
    {
      title: tr("写作"),
      sum: tr("中文标题、导读和译文"),
      text: tr("每一条都有中文标题和 AI 导读，来源和原文链接始终保留。获准转载的外文精选，另附中文全文译文。"),
      notes: (
        <ul className="pf-notes">
          <li className="pf-note">{tr("中文为 AI 翻译，仅供参考，以原文为准。")}</li>
        </ul>
      ),
      figures: [],
    },
    {
      title: tr("出版"),
      sum: OUTPUTS.map((o) => name(o.name)).join(tr("、")),
      text: tr("整理好的内容分到五个地方，网页、RSS 都能看。"),
      notes: (
        <p className="pf-home">
          <Icon d={ICON.place} />
          <span>{tr("首页先给你看所在国家的最新消息，也可以换成别的国家。")}</span>
        </p>
      ),
      illus: (
        <ul className="pf-outs">
          {OUTPUTS.map((o) => (
            <li key={o.name} className="pf-row" data-gold={o.gold ? "" : undefined}>
              <span className="pf-ic">
                <Icon d={o.icon} fill={o.fill} />
              </span>
              <b>{name(o.name)}</b>
              <span>
                {o.name === "精选"
                  ? tr("过了精选线的事件，附推荐理由")
                  : o.name === "日报"
                    ? tr("每天北京时间 {time} 出刊，另有周报、月报", { time: EDITION_TIMES.daily })
                    : o.name === "热点榜"
                      ? tr("72 小时内多家来源都在报道的事件")
                      : o.name === "全部"
                        ? tr("收录的全部动态，可按国家、类别筛选")
                        : tr("各国法规政策的新变化")}
              </span>
            </li>
          ))}
        </ul>
      ),
      figures: f ? [f.dailies] : [],
    },
  ];
}

function Figures({ items }: { items: Figure[] }) {
  if (!items.length) return null;
  return (
    <dl className="pf-figs">
      {items.map((f) => (
        <div key={f.key} className="pf-fig" data-gold={f.gold ? "" : undefined}>
          <dt>{f.label}</dt>
          <dd className="pf-val num" data-stat={f.key}>
            {count(f.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A step's explanation: inside its card on narrow screens, in the panel under the river on wide ones. */
function StageText({ stage }: { stage: Stage }) {
  return (
    <>
      <p className="pf-text">{stage.text}</p>
      {stage.illus && <div className="pf-illus">{stage.illus}</div>}
      {stage.notes}
      <Figures items={stage.figures} />
    </>
  );
}

const no = (i: number) => String(i + 1).padStart(2, "0");

export function PipelineFlow({ stats, notice, onArrive }: { stats: SiteStats | null; notice?: ReactNode; onArrive?: () => void }) {
  const tr = useTr();
  const stages = stagesOf(stats, tr);
  const figures = figuresOf(stats, tr);
  const overview = figures ? [figures.sources, figures.collected, figures.selected, figures.dailies] : [];
  // The river draws one dot per source in use; with no statistics or no source there is nothing true to draw.
  const sources = stats?.sources ?? 0;
  const river = sources > 0;

  const [hover, setHover] = useState<number | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  const [open, setOpen] = useState<readonly number[]>([]);
  const [across, setAcross] = useState(true);
  // Set once the page has taken over in the browser; until then the stylesheet keeps every step's text readable.
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  const active = hover ?? pin;

  const flowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const riverRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docksRef = useRef<HTMLDivElement>(null);
  const handle = useRef<PipelineHandle | null>(null);
  const acrossRef = useRef(across);
  acrossRef.current = across;
  const activeRef = useRef(active);
  activeRef.current = active;
  const arriveRef = useRef(onArrive);
  arriveRef.current = onArrive;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const labels = useMemo<PipelineLabels>(
    () => ({
      sources: tr("{count} 个资讯来源", { count: count(sources) }),
      regulationSources: tr("法规来源"),
      regulationLane: tr("法规文件单独整理，保留原文"),
      line: tr("精选线"),
    }),
    [tr, sources],
  );
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const tap = (k: number) => {
    setHover(null);
    if (acrossRef.current) {
      setPin((p) => (p === k ? null : k));
      return;
    }
    const next = open.includes(k) ? open.filter((i) => i !== k) : [...open, k];
    setOpen(next);
    setPin(next.includes(k) ? k : (next.at(-1) ?? null));
  };
  const tapRef = useRef(tap);
  tapRef.current = tap;

  // Which layout the stylesheet chose (the stage heads in a row, or cards in a column).
  useEffect(() => {
    const flow = flowRef.current;
    const list = listRef.current;
    if (!flow || !list) return;
    const check = () => setAcross(getComputedStyle(list).display === "grid");
    check();
    const observer = new ResizeObserver(check);
    observer.observe(flow);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !acrossRef.current) return;
      setHover(null);
      setPin(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // The river: a separate module, loaded and mounted only in the browser.
  useEffect(() => {
    if (!river) return;
    let cancelled = false;
    void import("./pipeline-canvas").then(({ mountPipeline }) => {
      const flow = flowRef.current;
      const list = listRef.current;
      const wrap = riverRef.current;
      const canvas = canvasRef.current;
      const docks = docksRef.current;
      if (cancelled || !flow || !list || !wrap || !canvas || !docks) return;
      handle.current = mountPipeline({
        flow,
        wrap,
        canvas,
        stagesList: list,
        stages: [...list.children] as HTMLElement[],
        docks: [...docks.children] as HTMLElement[],
        sources: sourcesRef.current,
        labels: labelsRef.current,
        onHover: setHover,
        onTap: (k) => tapRef.current(k),
        onArrive: () => arriveRef.current?.(),
      });
      handle.current.setActive(activeRef.current);
    });
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
  }, [river]);
  useEffect(() => handle.current?.setSources(sources, labels), [sources, labels]);
  useEffect(() => handle.current?.setActive(active), [active]);

  return (
    <div className="pf-box">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div>
          <p className="text-[13px] font-semibold tracking-wide text-ink-3">{tr("怎么工作")}</p>
          <h2 id="how" className="mt-2 text-[21px] font-extrabold leading-[1.3] tracking-[-0.02em] text-ink [text-wrap:balance] sm:text-[28px]">
            {tr("六步，从各国报道到值得跟进的线索")}
          </h2>
          <p className="mt-2 text-[14.5px] leading-[1.7] text-ink-3 sm:text-[15px]">{tr("AI 帮我们读、筛、合并、打分和翻译；每一条都保留来源和原文链接。")}</p>
        </div>
        {river && (
          <div className="pf-legend lg:justify-end" aria-hidden="true">
            {LANGUAGES.map(([name, color]) => (
              <span key={name}>
                <i className="pf-sw" style={{ "--c": `var(${color})` } as CSSProperties} />
                {name === "其他语言" ? tr("其他语言") : name}
              </span>
            ))}
            <span>
              <i className="pf-sw" data-shape="square" />
              {tr("法规来源")}
            </span>
            <span>
              <i className="pf-sw" data-shape="gold" />
              {tr("入选精选")}
            </span>
          </div>
        )}
      </div>
      {notice}
      <div className="pf-narrow pf-strip mt-5 grid gap-4">
        <Figures items={overview} />
        <p className="pf-hint">{tr("点一下任意一步，看说明和数字。")}</p>
      </div>

      <div
        ref={flowRef}
        className="pf mt-5 lg:mt-7"
        data-river={river ? "" : undefined}
        data-active={active ?? undefined}
        data-enhanced={enhanced ? "" : undefined}
      >
        <ol ref={listRef} className="pf-stages">
          {stages.map((s, i) => {
            const isOpen = !across && open.includes(i);
            return (
              <li
                key={no(i)}
                className="pf-stage"
                data-stage={i}
                data-active={active === i ? "" : undefined}
                data-open={isOpen ? "" : undefined}
                onPointerEnter={(e) => e.pointerType === "mouse" && across && setHover(i)}
                onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
              >
                <button
                  type="button"
                  className="pf-head"
                  aria-pressed={across ? pin === i : undefined}
                  aria-expanded={across ? undefined : isOpen}
                  aria-controls={across ? "pf-detail" : `pf-body-${i}`}
                  onClick={() => tap(i)}
                  onFocus={(e) => across && e.currentTarget.matches(":focus-visible") && setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <span className="pf-no">{no(i)}</span>
                  <span className="pf-title">{s.title}</span>
                  <span className="pf-sum">{s.sum}</span>
                  <span className="pf-chev" aria-hidden="true" />
                </button>
                <div className="pf-body" id={`pf-body-${i}`}>
                  <div>
                    <StageText stage={s} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {river && (
          <div ref={riverRef} className="pf-river" aria-hidden="true">
            <canvas ref={canvasRef} tabIndex={-1} />
            <div ref={docksRef} className="pf-docks">
              {OUTPUTS.map((o) => (
                <span key={o.name} className="pf-dock" data-gold={o.gold ? "" : undefined}>
                  <Icon d={o.icon} fill={o.fill} className="pf-dock-glyph" />
                  {tr(o.name).trim()}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="pf-detail" id="pf-detail">
          <div className="pf-overview" data-shown={active === null}>
            <Figures items={overview} />
            <p className="pf-hint">{tr("把鼠标移到任意一步上，看看它在做什么；点一下可以停在这一步。")}</p>
          </div>
          {stages.map((s, i) => (
            <div key={no(i)} className="pf-pane" data-shown={active === i}>
              <div className="pf-pane-head">
                <span className="pf-no">{no(i)}</span>
                <span className="pf-title">{s.title}</span>
              </div>
              <StageText stage={s} />
            </div>
          ))}
        </div>
      </div>
      <p className="mt-6 text-[12.5px] leading-[1.7] text-ink-4">{tr("图中的流动只用来说明流程；数字来自网站的实时统计。")}</p>
    </div>
  );
}
