// The words of the film's current scene (TASK-0367): HTML over the canvas, in the reader's language, placed with the
// scene's own layout functions and moved by the scene as it plays (data-k). Hidden from screen readers: they get the
// storyboard on the page, which carries the same scenes, figures and links.
import { type CSSProperties, Fragment } from "react";
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useLocale, useTr } from "../../../i18n";
import { countryName, usePriceWords } from "../blocks/format";
import type { FilmData } from "../blocks/types";
import { columns, countArea, feedRows, frame, trendBox } from "./scenes";
import type { Scene, Script } from "./types";

const at = (x: number, y: number, w?: number): CSSProperties => ({ left: x, top: y, width: w });

export function Overlay({ script, scene, data, w, h, onLeave }: { script: Script; scene: Scene; data: FilmData; w: number; h: number; onLeave: () => void }) {
  const tr = useTr();
  const say = usePriceWords();
  const english = useLocale() === "en";
  const { m } = frame(w, h);
  const heading = (
    <p className="pl-heading" style={at(m, m, w - 2 * m)}>
      {tr(scene.heading)}
    </p>
  );
  const sketch = (
    <span data-k="sketch" className="pl-tag" style={at(w - m - 80, m + 4)}>
      {tr("示意图")}
    </span>
  );
  switch (scene.kind) {
    case "title":
      return (
        <div className="pl-center">
          <p data-k="kicker" className="pl-kicker">
            {tr(scene.heading)}
          </p>
          <p data-k="title" className="pl-title">
            {tr(script.title)}
          </p>
        </div>
      );
    case "feed": {
      const lists = data.countries.filter((c) => c.items.length);
      const rows = feedRows(w, h);
      return (
        <>
          {heading}
          <div className="pl-tabs" style={at(rows[0]!.x, rows[0]!.y - 40)}>
            {lists.map((c, i) => (
              <span key={c.code} data-t={`tab-${i}`} data-on={i === 0} className="pl-tab">
                {countryName(c.code) ? tr(countryName(c.code)!) : c.code}
              </span>
            ))}
          </div>
          {lists.flatMap((c, ci) =>
            c.items.map((item, i) => (
              <p
                key={`${c.code}-${item.at}-${item.title}`}
                data-k={`row-${ci}-${i}`}
                className="pl-row"
                style={{ ...at(rows[i]!.x + 18, rows[i]!.y, rows[i]!.w - 30), height: rows[i]!.h }}
              >
                <span className="pl-row-title">{(english && item.titleEn) || item.title}</span>
                <span className="pl-row-source">{item.source}</span>
              </p>
            )),
          )}
          {!lists.length && sketch}
        </>
      );
    }
    case "trend": {
      const box = trendBox(w, h);
      const metals = data.metals;
      return (
        <>
          {heading}
          {metals.map((metal, i) => (
            <Fragment key={`${metal.metal}-${metal.quote}`}>
              <p data-k={`metal-${i}`} className="pl-sub" style={at(box.x, box.y - 26, box.w)}>
                <b>{say(metal.metal)}</b> {say(metal.quote)} · {say(metal.unit)}
              </p>
              <p data-k={`read-${i}`} className="pl-read" style={at(box.x, box.y + box.h + 8)}>
                <span data-t={`point-${i}`} />
                <b data-t={`value-${i}`} className="mono" />
              </p>
            </Fragment>
          ))}
          {metals.length > 0 && (
            <p className="pl-note" style={at(m, h - m + 4, w - 2 * m)}>
              {tr("官方公布的每一期价格，不补数、不估算")}
            </p>
          )}
          {!metals.length && sketch}
        </>
      );
    }
    case "count": {
      const { number } = countArea(w, h);
      return (
        <>
          {heading}
          <div className="pl-count" style={at(number.x, number.y, number.w)}>
            <p data-k="number">
              {data.hot ? (
                <b data-t="count" className="num">
                  0
                </b>
              ) : (
                <b className="pl-count-none">{tr("热点榜")}</b>
              )}
            </p>
            <p data-k="rule" className="pl-rule">
              {data.hot
                ? tr("件事件 · 最近 {hours} 小时 · 至少两家独立来源报道", { hours: data.hot.windowHours })
                : tr("最近 {hours} 小时内被至少两家独立来源报道的矿业事件，符合条件的全部列出。", { hours: 72 })}
            </p>
          </div>
          {!data.hot && sketch}
        </>
      );
    }
    case "sideBySide": {
      const [left, right] = columns(w, h);
      return (
        <>
          {heading}
          <div data-k="labels" className="pl-layer">
            <span className="pl-label" style={at(left.x + 12, left.y - 22)}>
              {tr("解读")}
            </span>
            <span className="pl-label" style={at(right.x + 12, right.y - 22)}>
              {tr("原文")}
            </span>
          </div>
          <span data-k="revise" className="pl-tag" style={at(right.x + right.w - 120, right.y + right.h + 4)}>
            {tr("修订痕迹")}
          </span>
          <span className="pl-tag pl-tag-still" style={at(w - m - 80, m + 4)}>
            {tr("示意图")}
          </span>
        </>
      );
    }
    case "outro":
      return (
        <div className="pl-center">
          <div data-k="links" className="pl-links">
            <p className="pl-kicker">{tr(scene.heading)}</p>
            <nav aria-label={tr(scene.heading)} className="pl-link-row">
              {script.scenes
                .filter((one) => one.to)
                .map((one) => (
                  <Link key={one.heading} to={one.to!} className="pl-link" onClick={onLeave}>
                    {tr(one.heading)}
                  </Link>
                ))}
            </nav>
          </div>
        </div>
      );
  }
}
