import { SITE, withSubject } from "@amp/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useNavigate, useLocation } from "react-router";
import type { Route } from "./+types/item";
import type { SiteItemDetail } from "@amp/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { relativeTime, fullDateTime, newsSourceDate } from "../lib/format";
import { SelectedBadge } from "@amp/ui/Badge";
import { ScoreLabel } from "@amp/ui/Score";
import { PillTabs } from "../components/ui/Tabs";
import { ArticleLayout, RailSection } from "../components/ui/Page";
import { Menu, MenuItem } from "@amp/ui/Menu";
import { StarButton, Attribution } from "../features/feed/parts";
import { GroupSources } from "../features/feed/ReadingGroup";
import { RelatedCoverage } from "../features/item/RelatedCoverage";
import { feedbackPath } from "../lib/feedback-origin";
import { StoryFollowups } from "../features/item/StoryFollowups";
import { IconArrowLeft, IconCopy, IconExternal, IconMenu, IconShare } from "../components/icons";

export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}`, { signal: request.signal });
  return { item };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("内容不存在") }, { name: "robots", content: "noindex" }];
  const { item } = loaderData;
  return pageMeta({
    title: item.title,
    description: item.summary ?? undefined,
    path: `/items/${item.id}`,
    image: `/og/items/${item.id}.png`,
    type: "article",
    noindex: !item.indexable,
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: item.selected ? "精选" : "全部动态", path: item.selected ? "/" : "/all" },
      { name: item.title, path: `/items/${item.id}` },
    ]),
  });
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

/** A 2px accent line across the top that follows long bodies. */
function ReadingProgress() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (ref.current) ref.current.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0})`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left scale-x-0 bg-accent transition-transform duration-150 ease-out"
    />
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function shareOrCopy(item: Pick<SiteItemDetail, "id" | "title">): Promise<"shared" | "copied" | null> {
  const url = `${siteUrl()}/items/${item.id}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: item.title, url });
      return "shared";
    }
    await navigator.clipboard.writeText(`${item.title}\n${url}`);
    return "copied";
  } catch {
    return null;
  }
}

export default function ItemPage() {
  const { item } = useLoaderData<typeof loader>();
  const currentLocation = useLocation();
  const navigate = useNavigate();
  const hasTranslation = item.hasTranslation;
  const lang = item.bodyLanguage;
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);
  const share = async () => {
    const r = await shareOrCopy(item);
    if (r === "copied") setToast("链接已复制");
  };

  const bodyHtml = lang === "zh" ? (item.body?.zh ?? item.body?.original) : (item.body?.original ?? item.body?.zh);
  const bodyLabel = !item.body
    ? null
    : lang === "zh" && item.body.zhKind === "translation"
      ? "正文 · AI 翻译"
      : lang === "original" && hasTranslation
        ? "正文 · 原文"
        : "正文";
  // The source's own date. Finding the page is not a publication date (收录时间 stays labeled as such).
  const sourceDate = newsSourceDate(item.sourceTime, item.publishedAt);
  const publishedIso = sourceDate && !sourceDate.dateOnly ? sourceDate.dateTime : null;
  const dateOnly = sourceDate?.dateOnly ?? false;
  const publishedAttr = sourceDate?.dateTime ?? null;
  const summaryOnly = item.readingMode === "summary-only";
  const showOutline = item.outline.length >= 3;
  const originalLabel = "打开原文";

  const related = item.relatedStories.filter((s) => s.publicId !== item.story?.publicId);

  const back = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(item.selected ? "/" : "/all");
  };
  const backButton = (
    <button
      type="button"
      onClick={back}
      className="-ml-1.5 inline-flex h-8 items-center gap-1.5 rounded-full px-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink lg:text-[13px] lg:text-ink-3"
    >
      <IconArrowLeft size={16} /> 返回
    </button>
  );
  const moreMenu = (
    <Menu label="更多操作" trigger={<IconMenu size={17} />}>
      {(close) => (
        <>
          <MenuItem
            icon={<IconShare size={15} />}
            onSelect={() => {
              close();
              void share();
            }}
          >
            分享链接
          </MenuItem>
          <MenuItem
            icon={<IconCopy size={15} />}
            onSelect={async () => {
              close();
              try {
                await navigator.clipboard.writeText(`${siteUrl()}/items/${item.id}`);
                setToast("链接已复制");
              } catch {
                // clipboard unavailable
              }
            }}
          >
            复制链接
          </MenuItem>
        </>
      )}
    </Menu>
  );
  // Desktop actions head the right rail, one row as tall as 返回 at the head of the left one.
  const actions = (
    <div className="flex items-center gap-1">
      <a
        href={item.links.original}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
      >
        {originalLabel} <IconExternal size={13} />
      </a>
      <StarButton item={item} size={32} />
      {moreMenu}
    </div>
  );
  const verdict = (item.selected || item.score !== null) && (
    <div className="flex items-center gap-2">
      {item.selected && <SelectedBadge />}
      <ScoreLabel score={item.score} />
    </div>
  );

  // Rails: the piece's facts on the left (wide screens), the editor's notes on the right, the outline
  // under the facts (or under the notes when only the right rail shows).
  const facts = (
    <RailSection title="来源">
      <div className="text-[14px] font-semibold leading-snug text-ink">{item.source.name}</div>
      <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{item.author ?? hostOf(item.links.original)}</div>
      <div className="mt-3 text-[12px] text-ink-4">
        {sourceDate?.label ?? "发布时间"}
        {sourceDate && !sourceDate.dateOnly ? " · 北京时间" : ""}
      </div>
      {sourceDate && publishedAttr ? (
        <>
          <time dateTime={publishedAttr} className="mono mt-0.5 block text-[12.5px] text-ink-2">
            {sourceDate.text}
          </time>
          {!dateOnly && publishedIso && (
            <div className="mt-0.5 text-[12px] text-ink-4" suppressHydrationWarning>
              {Date.parse(publishedIso) <= Date.now() ? relativeTime(publishedIso) : "原文标注"}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-0.5 text-[12.5px] text-ink-2">尚未确认</div>
          <div className="mt-3 text-[12px] text-ink-4">收录时间</div>
          <time dateTime={item.discoveredAt} className="mono mt-0.5 block text-[12.5px] text-ink-2">
            {fullDateTime(item.discoveredAt)}
          </time>
        </>
      )}
    </RailSection>
  );
  const outline = showOutline && (
    <RailSection title="本文目录">
      <nav aria-label="本文目录">
        <ol className="-ml-px space-y-0.5 border-l border-line">
          {item.outline.map((o) => (
            <li key={o.id}>
              <a
                href={`#${o.id}`}
                className={`-ml-px block border-l border-transparent py-1 text-[12.5px] leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink ${o.level > 2 ? "pl-5" : "pl-3"}`}
              >
                {o.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </RailSection>
  );
  const notes = (
    <>
      {item.reason && !summaryOnly ? (
        <RailSection title="推荐理由">
          {verdict && <div className="mb-3">{verdict}</div>}
          <p className="text-[13.5px] leading-[1.8] text-ink-2">{item.reason}</p>
        </RailSection>
      ) : (
        verdict && <RailSection title="AI 评分">{verdict}</RailSection>
      )}
      {item.tags.length > 0 && (
        <RailSection title="标签">
          <div className="flex flex-wrap gap-1.5">
            {item.tags.slice(0, 8).map((t) => (
              <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="chip">
                #{t}
              </Link>
            ))}
          </div>
        </RailSection>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      {item.body && <ReadingProgress />}

      {/* Phones: a sticky bar with back, 收藏, the original, share and more. Desktop puts these in the rails. */}
      <div className="sticky top-0 z-30 -mx-4 flex h-12 items-center gap-1.5 border-b border-line-soft bg-bg/95 px-4 backdrop-blur lg:hidden">
        {backButton}
        <span className="flex-1" />
        <StarButton item={item} size={32} />
        <a href={item.links.original} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 px-1.5 text-[14px] text-ink-2">
          <IconExternal size={15} /> 原文
        </a>
        <button
          type="button"
          aria-label="分享"
          onClick={share}
          className="inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:text-ink"
        >
          <IconShare size={17} />
        </button>
        {moreMenu}
      </div>

      {/* The text on the page in one column; back and the facts in the left rail, actions and notes in the right. */}
      <ArticleLayout
        left={
          <>
            {backButton}
            {facts}
            {outline}
          </>
        }
        right={
          <>
            {actions}
            {notes}
            <div className="space-y-8 2xl:hidden">{outline}</div>
          </>
        }
      >
        <div className="hidden lg:block 2xl:hidden">{backButton}</div>
        <article className="pb-6 pt-6 lg:pt-2 2xl:pt-1">
          {item.manualRevisionLabel && <p className="mb-3 text-[12px] text-ink-3">{item.manualRevisionLabel}</p>}
          <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink-3 2xl:hidden">
            <span className="font-semibold text-ink-2">{item.source.name}</span>
            {item.author && <span>· {item.author}</span>}
            <span>·</span>
            {sourceDate && publishedAttr ? (
              <>
                <time dateTime={publishedAttr} className="mono">
                  {sourceDate.text}
                </time>
                {!dateOnly && publishedIso && (
                  <span suppressHydrationWarning>· {Date.parse(publishedIso) <= Date.now() ? relativeTime(publishedIso) : "原文标注"}</span>
                )}
              </>
            ) : (
              <>
                <span>尚未确认</span>
                <span>· 收录时间</span>
                <time dateTime={item.discoveredAt} className="mono">
                  {fullDateTime(item.discoveredAt)}
                </time>
              </>
            )}
            {item.selected && (
              <span className="ml-1 lg:hidden">
                <SelectedBadge />
              </span>
            )}
            {item.score !== null && (
              <span className="ml-1 lg:hidden">
                <ScoreLabel score={item.score} />
              </span>
            )}
          </div>
          <h1 className="text-[26px] font-bold leading-[1.38] tracking-[-0.01em] text-ink lg:text-[32px] lg:leading-[1.34] xl:text-[36px] xl:leading-[1.3]">
            {item.title}
          </h1>
          {item.originalTitle && <p className="mt-2.5 text-[14px] leading-relaxed text-ink-4">{item.originalTitle}</p>}

          <p className="mt-2 text-[12px] text-ink-4">
            本站公开 {item.firstPublicAt ? <time dateTime={item.firstPublicAt}>{fullDateTime(item.firstPublicAt)}</time> : "时间未记录"}
          </p>
          <Attribution value={item.attribution} />
          {item.summary && (
            <section className="mt-7 xl:mt-8">
              <div className="mb-2 text-[12px] font-semibold text-accent">{summaryOnly ? "摘要" : "AI 导读"}</div>
              <p className="text-[18px] leading-[1.7] text-ink xl:text-[20px] xl:leading-[1.7]">{item.summary}</p>
            </section>
          )}

          <details className="mt-5 rounded-control border border-line px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-[13px] font-semibold">文章目录</summary>
            <nav aria-label="手机文章目录" className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-accent">
              {bodyHtml && <a href="#article-body">正文</a>}
              {item.outline.map((entry) => (
                <a key={entry.id} href={`#${entry.id}`}>
                  {entry.text}
                </a>
              ))}
              <a href="#article-source">来源与依据</a>
              {item.story && <a href="#article-developments">事件进展</a>}
            </nav>
          </details>

          {item.reason && !summaryOnly && (
            <section className="mt-6 border-t border-line pt-4 lg:hidden">
              <div className="mb-1 text-[12px] font-semibold text-ink-3">推荐理由</div>
              <p className="text-[15px] leading-[1.75] text-ink-2">{item.reason}</p>
            </section>
          )}

          {item.group && item.group.reportCount > 1 && (
            <div className="mt-5">
              <GroupSources group={item.group} parentId={item.id} />
            </div>
          )}

          {!bodyHtml && (
            <section className="mt-7 rounded-control bg-bg-sunk px-4 py-3 text-[13.5px] leading-relaxed text-ink-3" aria-label="正文状态">
              <h2 className="font-semibold">
                {item.readingState === "pending" ? "正文正在补齐" : item.readingState === "restricted" || summaryOnly ? "本站仅提供中文导读" : "本站暂无正文"}
              </h2>
              <p className="mt-1">
                {item.readingState === "pending"
                  ? "中文正文正在整理，完成后会显示在这里。你也可以先查看来源原文。"
                  : item.readingState === "restricted" || summaryOnly
                    ? "按来源许可，本站提供中文导读和原文链接。"
                    : "本站暂时没有可展示的完整正文。可以阅读导读，或打开来源网站继续阅读。"}
              </p>
              <a href={item.links.original} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-accent">
                打开来源原文
              </a>
            </section>
          )}

          {item.body && bodyHtml && (
            <section id="article-body" className="mt-9 scroll-mt-16 border-t border-line pt-4 xl:mt-10">
              <div className="mb-6 flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink-4">{bodyLabel}</span>
                {hasTranslation && (
                  <PillTabs
                    size="xs"
                    layoutId="item-body-lang"
                    label="正文语言"
                    active={lang}
                    items={[
                      { key: "zh", label: "中文", prefetch: "intent", replace: true, to: `/items/${item.id}` },
                      { key: "original", label: "原文", prefetch: "intent", replace: true, to: `/items/${item.id}/original` },
                    ]}
                  />
                )}
              </div>
              {hasTranslation && lang === "zh" && !item.body.complete && (
                <p className="mb-5 rounded-control bg-bg-sunk px-3 py-2 text-[13px] text-ink-3">译文尚不完整，完整内容请切换到原文。</p>
              )}
              <div className="prose" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            </section>
          )}

          <p id="article-source" className="mt-8 scroll-mt-16 text-[13px] text-ink-4">
            来源：
            <a href={item.links.original} target="_blank" rel="noopener noreferrer" className="text-ink-3 hover:text-accent">
              {item.source.name}
            </a>
            <span> · {hostOf(item.links.original)}</span>
          </p>

          <Attribution value={item.attribution} full />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
            原始来源可追溯；中文内容由 AI 辅助生成或翻译{item.manualRevisionLabel ? "，并经人工修订" : ""}，核对细节请看原文。
          </p>
          <RelatedCoverage value={item.eventCoverage} currentId={item.id} />
          <Link to={feedbackPath(currentLocation.pathname, currentLocation.search)} className="mt-4 inline-block text-[13px] text-accent">
            内容有误？告诉我们
          </Link>
          {!!item.companyContext?.length && (
            <section className="mt-7 border-t border-line pt-4" aria-label="文中公司资料">
              <h2 className="text-[16px] font-semibold">文中公司资料</h2>
              <ul className="mt-3 space-y-4">
                {item.companyContext.map((company) => (
                  <li key={`${company.name}:${company.originalName}`}>
                    <h3 className="text-[14px] font-semibold">
                      {company.name}
                      {company.originalName && company.originalName !== company.name ? `（${company.originalName}）` : ""}
                    </h3>
                    {company.description && <p className="mt-1 text-[14px] leading-relaxed text-ink-3">{company.description}</p>}
                    <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-4">
                      资料出处：
                      {company.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                          {source.name}
                        </a>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!item.relatedPolicies?.length && (
            <section className="mt-7 border-t border-line pt-4" aria-label="相关法规文书">
              <h2 className="text-[16px] font-semibold">相关法规文书</h2>
              <ul className="mt-3 space-y-3">
                {item.relatedPolicies.map((policy) => (
                  <li key={policy.id}>
                    <Link to={`/policies/${encodeURIComponent(policy.id)}`} className="text-[14px] text-accent">
                      {policy.title}
                    </Link>
                    {(policy.jurisdiction || policy.documentNumber) && (
                      <p className="mt-1 text-[12px] text-ink-4">{[policy.jurisdiction, policy.documentNumber].filter(Boolean).join(" · ")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {item.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 lg:hidden">
              {item.tags.slice(0, 6).map((t) => (
                <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="chip">
                  #{t}
                </Link>
              ))}
            </div>
          )}

          {item.story && (
            <section id="article-developments" className="scroll-mt-16">
              <StoryFollowups story={item.story} currentId={item.id} currentFactId={item.group?.factId} />
            </section>
          )}

          {related.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 text-[14px] font-semibold text-ink">相关事件</h2>
              <ul className="divide-y divide-line-soft">
                {related.map((s) => (
                  <li key={s.publicId}>
                    <Link to={`/story/${s.publicId}`} className="block py-2.5 text-[14px] text-ink-2 hover:text-accent">
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </ArticleLayout>
      {toast && (
        <div
          role="status"
          className="fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] text-bg shadow-[var(--shadow-pop)] lg:bottom-8"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
