// The 2026.11 major update's showcase (Owner 2026-11-06: the news map leads the notice, and the notice shows what is
// new instead of listing it). The map is the home page's own live map, so its circles are today's real counts and a
// circle opens the home feed for that country; the five tiles below draw small interface sketches, never real
// articles or prices. Motion is the site's shared entrance set and stops when the reader asks for reduced motion.
import type { CSSProperties, ReactNode } from "react";
import { CATEGORIES } from "@amp/industry/taxonomy";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { type Phrase, useCategoryLabel, useT, useTr } from "../../i18n";
import { WorldMap } from "../feed/WorldMap";

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

function Tile({ index, title, text, to, action, children }: { index: number; title: Phrase; text: Phrase; to: string; action: Phrase; children: ReactNode }) {
  const tr = useTr();
  return (
    <li
      className="animate-fade-up group/tile flex flex-col rounded-control border border-line bg-bg-sunk p-4 transition duration-200 hover:-translate-y-0.5 hover:border-accent"
      style={delay(900 + index * 140)}
    >
      <div className="mb-3 h-[72px] text-accent" aria-hidden="true">
        {children}
      </div>
      <h3 className="text-[15.5px] font-bold text-ink">{tr(title)}</h3>
      <p className="mt-1.5 flex-1 text-[13px] leading-[1.75] text-ink-3">{tr(text)}</p>
      <Link to={to} className="mt-3 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent group-hover/tile:text-hot">
        {tr(action)} →
      </Link>
    </li>
  );
}

/** Nine category chips arriving one by one. */
function Categories({ base }: { base: number }) {
  const label = useCategoryLabel();
  return (
    <div className="flex flex-wrap gap-1.5">
      {CATEGORIES.map((c, i) => (
        <span key={c.key} className="anim-pop-in rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-semibold text-accent" style={delay(base + i * 70)}>
          {label(c.key)}
        </span>
      ))}
    </div>
  );
}

/** A storyline: three progress dots joined by a drawn line, the newest one breathing. */
function Storyline({ base }: { base: number }) {
  return (
    <svg viewBox="0 0 200 72" className="h-full w-full" aria-hidden="true">
      <path d="M20 14 V58" pathLength={1} className="anim-draw stroke-current" strokeWidth={2} fill="none" style={delay(base)} />
      {[14, 36, 58].map((y, i) => (
        <g key={y}>
          <circle
            cx={20}
            cy={y}
            r={5}
            className="anim-pop-in fill-current"
            style={{ ...delay(base + i * 220), transformBox: "fill-box", transformOrigin: "center" }}
          />
          <rect
            x={34}
            y={y - 5}
            width={i === 2 ? 132 : 100 - i * 18}
            height={10}
            rx={3}
            className="anim-fade-in fill-current"
            opacity={i === 2 ? 0.85 : 0.25}
            style={delay(base + i * 220)}
          />
        </g>
      ))}
    </svg>
  );
}

/** Two versions of a clause: the added words underlined, the removed ones struck through. */
function Compare({ base }: { base: number }) {
  return (
    <svg viewBox="0 0 200 72" className="h-full w-full" aria-hidden="true">
      {[0, 104].map((x, col) => (
        <g key={x}>
          <rect x={x + 2} y={4} width={92} height={64} rx={5} className="fill-none stroke-current" opacity={0.35} />
          <path d={`M${x + 12} 20h60M${x + 12} 34h72M${x + 12} 48h48`} className="stroke-current" opacity={0.25} strokeWidth={3} strokeLinecap="round" />
          {col === 0 ? (
            <path d={`M${x + 12} 34h72`} pathLength={1} className="anim-draw stroke-hot" strokeWidth={1.6} style={delay(base)} />
          ) : (
            <path d={`M${x + 12} 52h48`} pathLength={1} className="anim-draw stroke-current" strokeWidth={1.6} style={delay(base + 260)} />
          )}
        </g>
      ))}
    </svg>
  );
}

/** One metal's card: a drawn price line and the mark a held quote carries. */
function MetalCard({ base, held }: { base: number; held: Phrase }) {
  const tr = useTr();
  return (
    <svg viewBox="0 0 200 72" className="h-full w-full" aria-hidden="true">
      <rect x={2} y={4} width={196} height={64} rx={6} className="fill-none stroke-current" opacity={0.35} />
      <rect x={12} y={14} width={46} height={9} rx={3} className="fill-current" opacity={0.85} />
      <path
        d="M12 54 L42 46 L70 50 L98 36 L126 40 L154 26 L186 30"
        pathLength={1}
        className="anim-draw stroke-current"
        strokeWidth={2}
        fill="none"
        style={delay(base)}
      />
      <g className="anim-pop-in" style={{ ...delay(base + 700), transformBox: "fill-box", transformOrigin: "center" }}>
        <rect x={118} y={10} width={70} height={16} rx={8} className="fill-hot" />
        <text x={153} y={21.5} textAnchor="middle" className="fill-white text-[9px] font-semibold">
          {tr(held)}
        </text>
      </g>
    </svg>
  );
}

/** Reading: the bilingual company name, the two typefaces and the English switch. */
function Reading({ base }: { base: number }) {
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <span className="anim-fade-in text-[15px] font-bold text-ink" style={delay(base)}>
        必和必拓（BHP）
      </span>
      <span className="flex items-center gap-1.5">
        {["宋", "黑", "EN"].map((label, i) => (
          <span
            key={label}
            className={`anim-pop-in grid h-7 min-w-7 place-items-center rounded-full px-2 text-[12px] font-semibold ${i === 0 ? "bg-accent text-white" : "bg-accent-soft text-accent"} ${i === 0 ? "font-serif" : ""}`}
            style={delay(base + 200 + i * 120)}
          >
            {label}
          </span>
        ))}
      </span>
    </div>
  );
}

export function Showcase202611() {
  const tr = useTr();
  const mapTitle = useT().map.title;
  return (
    <section className="mt-6 space-y-4" aria-label={tr("本次更新亮点")}>
      <div
        className="animate-fade-up grid gap-4 rounded-control border border-accent/40 bg-accent-soft/40 p-4 sm:p-5 lg:grid-cols-[minmax(0,15em)_minmax(0,1fr)] lg:items-center"
        style={delay(300)}
      >
        <div>
          <p className="text-[12.5px] font-semibold tracking-wide text-hot">{tr("本次主角")}</p>
          <h3 className="mt-1 text-[26px] font-black leading-[1.2] text-ink">{mapTitle}</h3>
          <p className="mt-1 text-[16px] font-bold leading-[1.5] text-ink-2">{tr("一眼看到矿业新闻发生在哪里")}</p>
          <p className="mt-2 text-[13.5px] leading-[1.8] text-ink-3">
            {tr("首页顶部的地图按国家标出今天、近 7 天、近 30 天的资讯，圆越大消息越多，涨得快的会标出来。点一个国家，下面就只看这个国家。")}
          </p>
          <Link to="/" className="mt-3 inline-flex min-h-10 items-center whitespace-nowrap rounded-full bg-ink px-4 text-[13px] font-semibold text-bg transition hover:bg-hot hover:text-white">
            {tr("去首页看地图")} →
          </Link>
        </div>
        <div className="min-w-0 [&>section]:mb-0">
          <WorldMap base="/" selected={null} hint={tr("点一个圆，去首页看这个国家的资讯。")} />
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile index={0} title="资讯分成新的 9 类" text="按文章量重新划分，每一类都有足够的内容；以前收藏的分类链接照常能用。" to="/all" action="按分类浏览">
          <Categories base={1000} />
        </Tile>
        <Tile
          index={1}
          title="事件脉络"
          text="同一件事按进展排开，多家报道收在一起，关键数字的变化和接下来要关注的日期一目了然。"
          to="/hot"
          action="看热点事件"
        >
          <Storyline base={1140} />
        </Tile>
        <Tile index={2} title="法规逐条对照" text="先选国家、再选主题，一层层找到法规；新旧版本逐条标出新增、修改和删除。" to="/policies" action="打开法规政策">
          <Compare base={1280} />
        </Tile>
        <Tile index={3} title="金属价格卡片" text="每种金属一张卡片，先看最新价格和涨跌；报价异常跳动时只暂缓那一种。" to="/metals" action="查看金属价格">
          <MetalCard base={1420} held="待下期确认" />
        </Tile>
        <Tile
          index={4}
          title="读起来更顺"
          text="标题摘要都是中文，外国矿企写成“必和必拓（BHP）”；可换宋体或黑体，也可切到英文界面。"
          to="/more"
          action="阅读设置"
        >
          <Reading base={1560} />
        </Tile>
      </ul>
    </section>
  );
}
