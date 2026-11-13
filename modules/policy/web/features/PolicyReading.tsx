/**
 * The text side of the review (TASK-0657): a tool row (which language, the original underneath, revision marks) over
 * the document's blocks, each article with its number in the margin. A block is the target of the clause numbers
 * on the interpretation side; with revision marks on, the words a newer version dropped and added are marked in
 * place and a dropped provision is shown where it used to be. The streams and their paging live in PolicyReview.tsx.
 */
import { Link } from "@amp/web/extension";
import { useTr, type Tr } from "@amp/web/i18n";
import type { KeyboardEvent } from "react";
import type { Policy } from "@amp/contracts/http/public";
import { DiffText, Deleted, provisionBody } from "./PolicyCompare";
import { blankStream, useReview } from "./PolicyReview";
import { policyHref } from "./PolicyUI";
import { usePolicyText, type PolicyText } from "./reader";
import { articleOf, blockDomId, readableExpressions, removedId, type BlockMark, type ProvisionChange, type ReadingBlock } from "./review";

type Expression = Policy["expressions"][number];

/** What a reading stream is, its language by name (“西班牙语原文”, not “原文 · es”). */
function label(expression: Expression, tr: Tr, text: PolicyText) {
  const language = text.language(expression.language) ?? expression.language;
  return expression.kind === "ai_translation"
    ? tr("AI 翻译（非官方译文）")
    : expression.kind === "official_translation"
      ? tr("{language}官方译本（发布机关：{body}）", { language, body: expression.issuing_body ?? "" })
      : expression.language.startsWith("zh")
        ? tr("正文")
        : tr("{language}原文", { language });
}
/** A stream as a choice in the tool row. */
function choice(expression: Expression, tr: Tr, text: PolicyText) {
  const language = text.language(expression.language) ?? expression.language;
  return expression.kind === "ai_translation"
    ? tr("中文译文")
    : expression.kind === "official_translation"
      ? tr("{language}官方译本", { language })
      : tr("{language}原文", { language });
}
const latin = (language: string) => !/^(?:zh|ja|ko)/i.test(language);

/** A focused wide table scrolls predictably; keys inside links or controls retain their native meaning. */
function scrollTable(event: KeyboardEvent<HTMLElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const delta = event.key === "ArrowRight" ? 80 : event.key === "ArrowLeft" ? -80 : 0;
  if (!delta || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
  event.preventDefault();
  event.currentTarget.scrollBy({ left: delta, behavior: "instant" });
}

/**
 * One block in one language. `strip` leaves out the article number the margin already shows; `mark` is given only
 * for the language the comparison was made in, with revision marks on.
 */
function BlockText({
  block,
  language,
  strip,
  mark,
  className,
}: {
  block: ReadingBlock;
  language: string;
  strip: boolean;
  mark?: BlockMark;
  className: string;
}) {
  const tr = useTr();
  const text = usePolicyText();
  if (mark?.kind === "covered") return null;
  const face = `${className}${latin(language) ? " pr-latin" : ""}${mark?.kind === "added" ? " pr-added" : ""}`;
  if (mark?.kind === "modified")
    return (
      <div className={face} lang={language}>
        <p className="pr-p">
          <DiffText diff={mark.spans} />
        </p>
      </div>
    );
  const semanticTable = !!block.semantic_html && /<table(?:\s|>)/i.test(block.semantic_html);
  const tableLabel = tr("正文表格（{language}）", { language: language.startsWith("zh") ? tr("中文") : (text.language(language) ?? language) });
  const semantic = block.semantic_html ? (
    <div
      className="pr-html"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The publisher sanitizes every block; scripts, handlers, styles and media are removed.
      dangerouslySetInnerHTML={{ __html: block.semantic_html }}
    />
  ) : null;
  const body = strip ? (articleOf(block.text)?.rest ?? block.text) : block.text;
  return (
    <div className={face} lang={language}>
      {semanticTable ? (
        <section
          aria-label={tableLabel}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Table scroll regions need keyboard access.
          tabIndex={0}
          onKeyDown={scrollTable}
          className="pr-table"
        >
          {semantic}
        </section>
      ) : semantic ? (
        semantic
      ) : block.kind === "heading" ? (
        <h3 className="pr-chap-title">{block.text}</h3>
      ) : (
        body && <p className="pr-p">{body}</p>
      )}
      {!block.semantic_html && block.table_rows && (
        <section
          aria-label={tableLabel}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Table scroll regions need keyboard access.
          tabIndex={0}
          onKeyDown={scrollTable}
          className="pr-table"
        >
          <table>
            <caption className="sr-only">{tr("原文表格")}</caption>
            <tbody>
              {block.table_rows.map((row, i) => (
                <tr key={JSON.stringify(block.table_rows!.slice(0, i + 1))}>
                  {row.map((cell, n) => (
                    <td key={JSON.stringify(row.slice(0, n + 1))}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {block.source_annotations?.length ? (
        <details className="pr-notes">
          <summary>{tr("原文结构化标注")}</summary>
          <dl>
            {block.source_annotations.map((a) => (
              <div key={a.annotation_id}>
                <dt>
                  {a.name} · {{ self: tr("本节点"), ancestor: tr("上级节点"), descendant: tr("下级节点") }[a.scope]}
                </dt>
                <dd>
                  {a.value} <span className="break-all">（{a.locator}）</span>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {block.links.map((link) => (
        <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="pr-block-link">
          {link.label} ↗
        </a>
      ))}
    </div>
  );
}

/** One block of the text as a row: the article number in the margin, the selected language, the original under it. */
function Row({ block, other }: { block: ReadingBlock; other: ReadingBlock | undefined }) {
  const tr = useTr();
  const review = useReview();
  const { selected, original, marked } = review;
  const id = blockDomId(block.block_id);
  const article = block.semantic_html ? null : articleOf(block.text);
  const mark = review.redlineOn ? review.redline?.marks.get(block.block_id) : undefined;
  const own = marked?.id === selected!.id;
  const heading = block.kind === "heading" && !block.semantic_html;
  const flag = !mark || mark.kind === "covered" || !mark.head ? null : mark.kind === "modified" ? tr("修改") : tr("新增");
  // A later block of an amended provision is already inside the diff its opening block shows.
  const covered = mark?.kind === "covered" && own;
  const state = review.hit?.ids.includes(id) ? (review.hit.settled ? " pr-rel" : " pr-hit") : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Pointing at a block only lights the clause numbers that cite it; the numbers themselves are the links.
    <div
      id={id}
      className={`pr-art${heading ? " pr-chap" : ""}${covered ? " pr-covered" : ""}${state}`}
      data-kind={block.kind}
      data-pr-head={mark?.kind === "covered" ? blockDomId(mark.head) : undefined}
      onMouseEnter={() => review.setHover(id)}
      onMouseLeave={() => review.setHover(null)}
    >
      {!heading && (
        <span className="pr-no">
          {article?.label}
          {flag && <em className={mark?.kind === "added" ? "pr-flag pr-flag-a" : "pr-flag"}>{flag}</em>}
        </span>
      )}
      <div className="pr-body">
        <BlockText block={block} language={selected!.language} strip={!!article} mark={own ? mark : undefined} className="pr-t" />
        {other && original && (
          <BlockText
            block={other}
            language={original.language}
            strip={!!article && !!articleOf(other.text)}
            mark={!own && marked?.id === original.id ? mark : undefined}
            className="pr-o"
          />
        )}
      </div>
    </div>
  );
}

/** A provision the newer version dropped, shown where it used to be while revision marks are on. */
function Gone({ change, index }: { change: ProvisionChange; index: number }) {
  const tr = useTr();
  const review = useReview();
  const id = removedId(index);
  const language = review.comparison?.language ?? "und";
  const state = review.hit?.ids.includes(id) ? (review.hit.settled ? " pr-rel" : " pr-hit") : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Pointing at the row only lights the entry that cites it; the entry itself is the link.
    <div id={id} className={`pr-art pr-gone${state}`} onMouseEnter={() => review.setHover(id)} onMouseLeave={() => review.setHover(null)}>
      <span className="pr-no">{tr("原 {label}", { label: change.from!.label })}</span>
      <div className="pr-body">
        <div className={`pr-t${latin(language) ? " pr-latin" : ""}`} lang={language}>
          <p className="pr-p">
            <Deleted text={provisionBody(change.from!)} />
          </p>
        </div>
      </div>
    </div>
  );
}

/** The text side; rendered only when some language of the document can be read here. */
export function PolicySource() {
  const tr = useTr();
  const text = usePolicyText();
  const review = useReview();
  const { policy, history, selected, original, streams, load, compare, source, comparison, redline, redlineOn } = review;
  if (!selected) return null;
  const current = streams[selected.id] ?? blankStream(),
    other = original ? streams[original.id] : undefined;
  const choices = readableExpressions(policy);
  const total = current.loaded ? current.total : (policy.reading?.total_blocks ?? 0);
  const whole = current.loaded && !current.next && current.rows.length === total;
  const official = (
    <a href={policy.original_url} target="_blank" rel="noopener noreferrer" className="pr-link">
      {history ? tr("留存来源地址") : tr("查看官方原文")} ↗
    </a>
  );
  const removedAfter = (blockId: string) =>
    (redlineOn ? redline?.removed.get(blockId) : undefined)?.map((entry) => <Gone key={removedId(entry.index)} {...entry} />) ?? [];
  return (
    <aside className="pr-src" id="pr-src" aria-labelledby="pr-src-title">
      <div className="pr-sbar">
        <h2 id="pr-src-title">{tr("原文")}</h2>
        {(choices.length > 1 || original) && (
          <nav className="pr-sw" aria-label={tr("阅读语言")} data-pr-compare={compare ? "" : undefined}>
            {choices.map((e) => (
              <Link
                key={e.id}
                to={`${policyHref(policy.id)}?expression_id=${encodeURIComponent(e.id)}`}
                preventScrollReset
                aria-current={e.id === selected.id ? "page" : undefined}
              >
                {choice(e, tr, text)}
              </Link>
            ))}
            {original && source.kind === "text" && (
              <button type="button" aria-pressed={compare} aria-label={tr("对照原文")} onClick={() => review.setCompare(!compare)}>
                {tr("对照")}
              </button>
            )}
          </nav>
        )}
        {review.marked && (
          <button type="button" className="pr-tog" aria-pressed={redlineOn} data-pr-redline="" onClick={() => review.setRedline(!redlineOn)}>
            <i aria-hidden="true" />
            {tr("修订痕迹")}
          </button>
        )}
      </div>
      <div className="pr-doc scrollbar-thin" data-pr-redline-on={redlineOn ? "" : undefined}>
        {source.kind !== "text" ? (
          <p className="pr-status">{tr("这个语言版本的正文没有在本站显示，可以换一种语言阅读。")}</p>
        ) : (
          <>
            <p className="pr-status">
              {label(selected, tr, text)}
              {!whole && (
                <>
                  {" "}
                  {tr("· 已载入")} {current.rows.length} / {total} {tr("段内容")}
                </>
              )}
            </p>
            {source.excerpt && (
              <p className="pr-excerpt" data-pr-excerpt="">
                {tr("这里显示的是节选，不是全文。")} {official}
              </p>
            )}
            {redlineOn && comparison && (
              <p className="pr-legend">
                {tr("与{version}（{date}）比较：", {
                  version: text.version(comparison.from.original_version),
                  date: text.date(comparison.from.published_time) ?? text.date(comparison.from.first_public_at) ?? "",
                })}
                <ins className="pr-ins">{tr("加入的文字")}</ins> <del className="pr-del">{tr("删去的文字")}</del>
              </p>
            )}
            {removedAfter("")}
            {current.rows.flatMap((block) => [
              <Row key={block.block_id} block={block} other={compare ? other?.rows.find((row) => row.block_id === block.block_id) : undefined} />,
              ...removedAfter(block.block_id),
            ])}
            {(current.error || other?.error) && (
              <p role="status" className="pr-status pr-warn">
                {current.rows.length || other?.rows.length
                  ? tr("暂时无法继续读取，已载入的内容仍保留。请重试。")
                  : tr("正文暂时无法读取，请重试或查看官方原文。")}
              </p>
            )}
            {(current.busy || other?.busy) && (
              <p role="status" className="pr-status">
                {tr("正在读取正文…")}
              </p>
            )}
            {current.error || current.next || !current.loaded || (compare && (other?.error || other?.next)) ? (
              <button
                type="button"
                disabled={current.busy || other?.busy}
                className="pr-link"
                onClick={() => {
                  void load(selected);
                  if (compare && original) void load(original);
                }}
              >
                {current.error || other?.error ? tr("重新读取正文") : tr("继续读取正文")}
              </button>
            ) : (
              !source.excerpt && (
                <p className="pr-status pr-end">
                  {policy.reading?.completeness === "complete" && current.complete && whole
                    ? tr("正文已全部载入。")
                    : tr("当前可读内容已载入，尚不能视为完整正文。")}
                </p>
              )
            )}
          </>
        )}
      </div>
    </aside>
  );
}
