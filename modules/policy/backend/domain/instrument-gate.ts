/**
 * The policy line's instrument gate (TASK-0576, Owner 2026-11-07): an edition is public only when the program recognises
 * a legal instrument, at its final officially published stage, that concerns mining. Drafts, bills, consultations and
 * “will publish” notices belong to the news lane's 政策监管 category, not here. Deterministic: the same input always gives
 * the same answer, nothing calls a model or the network. The vocabulary is `industry/policy-instruments.json`.
 */
import { POLICY_INSTRUMENTS, type PolicyInstrumentLanguage, type PolicyInstrumentNature } from "@amp/industry/policy-instruments";

export const INSTRUMENT_GATE_RECIPE = `instrument-gate-1/${POLICY_INSTRUMENTS.version}`;

export type InstrumentGateInput = {
  title: string;
  number: string | null;
  /** The issuing body as captured (for gazettes this is often the gazette itself, so the title and text are read too). */
  issuer: string | null;
  /** The head of the official text (program-extracted); empty when nothing was extracted. */
  excerpt: string;
  /** A document type the source registration states (`identity.documentType`); it wins over the title. */
  documentType?: string | null;
  language?: string | null;
  sourceId?: string | null;
};
export type InstrumentGateReason =
  | "instrument"
  | "not_final"
  | "not_normative"
  | "personnel"
  | "individual_act"
  | "unknown_kind"
  | "missing_number"
  | "not_mining";
export type InstrumentGateResult = {
  /** A recognised instrument kind (ley, decreto, resolucion, zh_law, …), or the class of what it is instead. */
  kind: string;
  nature: PolicyInstrumentNature | null;
  final: boolean;
  mining: boolean;
  /** What the operative text does to another instrument, when it says so. */
  change: "amendment" | "repeal" | null;
  publishable: boolean;
  reason: InstrumentGateReason;
  /** The matched words, for the dry run and the audit record. */
  detail: string;
  recipe: string;
};

/** Lower case without accents (Spanish, Portuguese, French marks), so “Resolución” and “RESOLUCION” match alike. */
export function foldText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ \s]+/g, " ")
    .trim();
}
const CJK = /[㐀-鿿]/;
function languageOf(input: InstrumentGateInput): PolicyInstrumentLanguage {
  const declared = input.language?.slice(0, 2).toLowerCase();
  if (declared === "zh" || declared === "es" || declared === "en") return declared;
  if (CJK.test(input.title)) return "zh";
  return /\b(?:articulo|resolucion|decreto|ley|visto|considerando|boletin)\b/.test(foldText(`${input.title} ${input.excerpt.slice(0, 400)}`)) ? "es" : "en";
}

const compiled = new Map<string, RegExp>();
function re(pattern: string, flags = "u") {
  const key = `${flags}:${pattern}`;
  let found = compiled.get(key);
  if (!found) {
    found = new RegExp(pattern, flags);
    compiled.set(key, found);
  }
  return found;
}
const firstHit = (patterns: readonly string[] | undefined, text: string) => (patterns ?? []).map((p) => text.match(re(p))?.[0]).find(Boolean) ?? null;
const hits = (patterns: readonly string[] | undefined, text: string) => (patterns ?? []).reduce((n, p) => n + [...text.matchAll(re(p, "gu"))].length, 0);

/** Chinese titles are read without book-title marks and quotes; “《中华人民共和国矿产资源法》” is a law title. */
const zhTitle = (title: string) => title.replace(/[《》“”"]/g, "").replace(/\s+/g, "");

const ZH_DOCUMENT_TYPES: Record<string, { kind: string; nature: PolicyInstrumentNature }> = {
  法律: { kind: "zh_law", nature: "law" },
  行政法规: { kind: "zh_regulation", nature: "regulation" },
  部门规章: { kind: "zh_regulation", nature: "regulation" },
  地方性法规: { kind: "zh_regulation", nature: "regulation" },
  地方政府规章: { kind: "zh_regulation", nature: "regulation" },
  规章: { kind: "zh_regulation", nature: "regulation" },
  规范性文件: { kind: "zh_normative_notice", nature: "notice" },
};

type Found = { kind: string; nature: PolicyInstrumentNature; index: number; order: number; requiresNumber?: string };
/** The instrument this text names first (a gazette title is “ISSUER Resolución 12/2026”, a promulgation decree names its law later). */
function kindIn(text: string, language: PolicyInstrumentLanguage, anchoredZh: boolean): Found | null {
  const candidates = POLICY_INSTRUMENTS.kinds
    .map((k, order) => ({ k, order }))
    .filter(({ k }) => k.language === language)
    .flatMap(({ k, order }) => {
      const match = (language === "zh" ? (anchoredZh ? zhTitle(text) : text) : foldText(text)).match(re(k.pattern));
      return match
        ? [{ kind: k.kind, nature: k.nature, index: match.index ?? 0, order, ...(k.requires_number ? { requiresNumber: k.requires_number } : {}) }]
        : [];
    });
  candidates.sort((a, b) => a.index - b.index || a.order - b.order);
  return candidates[0] ?? null;
}

/** “EL SECRETARIO DE MINERÍA RESUELVE:” — the body that signs the operative part, read from the text itself. */
export function operativeIssuer(excerpt: string) {
  const folded = foldText(excerpt);
  const match = folded.match(
    /\b(?:el|la)\s+((?:sub)?secretari[oa]|ministr[oa]|director[a]?|presidente|gobernador[a]?|jefe|interventor[a]?|juez|administrador[a]?)\s+(?:de\s+estado\s+)?(?:de\s+|del\s+)?([^:]{3,120}?)\s+(?:resuelve|dispone|decreta|decide)\b/u,
  );
  if (!match) return null;
  // The signer's office names its body: el ministro de minería → ministerio de minería, el secretario → secretaría.
  const office = match[1]!
    .replace(/^(sub)?secretari[oa]$/, "$1secretaria")
    .replace(/^ministr[oa]$/, "ministerio")
    .replace(/^director[a]?$/, "direccion")
    .replace(/^juez$/, "juzgado");
  return `${office} de ${match[2]}`;
}

function result(partial: Omit<InstrumentGateResult, "recipe" | "publishable">): InstrumentGateResult {
  return { ...partial, publishable: partial.reason === "instrument", recipe: INSTRUMENT_GATE_RECIPE };
}

/** Whether the instrument concerns mining: a mining issuer, a mining word in the title, or enough of them in the text. */
export function miningRelevance(input: Pick<InstrumentGateInput, "title" | "issuer" | "excerpt">, language: PolicyInstrumentLanguage) {
  const vocab = POLICY_INSTRUMENTS;
  const clean = (value: string) => {
    let text = language === "zh" ? value : foldText(value);
    for (const noise of vocab.mining_noise[language] ?? []) text = text.replace(re(noise, "gu"), " ");
    return text;
  };
  const issuers = [input.issuer ?? "", input.title, operativeIssuer(input.excerpt) ?? ""].map(foldText).join(" | ");
  const issuer = vocab.mining_issuers.find((name) => issuers.includes(foldText(name)));
  if (issuer) return { mining: true, detail: `矿业机关：${issuer}` };
  const title = clean(input.title);
  const titleTerm = firstHit(vocab.mining_terms[language], title);
  if (titleTerm) return { mining: true, detail: `标题矿业词：${titleTerm}` };
  const body = clean(input.excerpt);
  const strong = firstHit(vocab.strong_mining_terms[language], body);
  if (strong) return { mining: true, detail: `正文矿业词：${strong}` };
  const count = hits(vocab.mining_terms[language], body);
  if (count >= 2) return { mining: true, detail: `正文矿业词 ${count} 处` };
  return { mining: false, detail: count ? "正文只有 1 处矿业词，标题与机关无矿业依据" : "标题、机关与正文都没有矿业依据" };
}

/**
 * classify(title, number, issuer, excerpt, source) → kind, final, mining, reason. Publish only when `publishable`.
 * Order: not-final markers, non-normative notices, recognised kind (registered type, title, number, text head),
 * personnel and individual acts, then mining relevance.
 */
export function classifyInstrument(input: InstrumentGateInput): InstrumentGateResult {
  const vocab = POLICY_INSTRUMENTS;
  const language = languageOf(input);
  const head = input.excerpt.slice(0, 600);
  const fold = (value: string) => (language === "zh" ? value : foldText(value));
  const titleText = fold(input.title);
  const headText = fold(head);
  const base = { nature: null, mining: false, change: null } as const;

  // The operative part: the first article of a Spanish instrument (“ARTÍCULO 1°.- Desígnase …”); a VISTO clause that cites
  // a bill, a consultation or a designation does not make a promulgation decree or a mining resolution one of those.
  const firstArticle = language === "es" ? (foldText(input.excerpt).match(/\barticulo\s*1\s*[°ºo.]*\s*(?:[-.–:]\s*)*(.{0,400})/u)?.[1] ?? "") : "";
  const operative = language === "zh" ? zhTitle(input.title) : `${titleText} | ${firstArticle}`;
  const draft = firstHit(vocab.not_final[language], operative);
  if (draft) return result({ ...base, kind: "draft", final: false, reason: "not_final", detail: `未定稿、征求意见或预告：${draft}` });
  const notice = firstHit(vocab.not_normative[language], language === "zh" ? zhTitle(input.title) : `${titleText} | ${headText.slice(0, 120)}`);
  if (notice) return result({ ...base, kind: "notice", final: true, reason: "not_normative", detail: `非规范性公告：${notice}` });

  const registered = input.documentType?.trim() ?? "";
  const zhRegistered = ZH_DOCUMENT_TYPES[registered];
  // The text head names the instrument only when it reads like one (VISTO / CONSIDERANDO / RESUELVE / sancionan con fuerza de ley).
  const headIsInstrument = /\b(?:visto|considerando|resuelve|decreta|dispone|sancionan con fuerza de|articulo 1)\b/u.test(headText);
  const found: Found | null = zhRegistered
    ? { ...zhRegistered, index: 0, order: -1 }
    : ((registered ? kindIn(registered, language, false) : null) ??
      kindIn(input.title, language, true) ??
      (input.number ? kindIn(input.number, language, false) : null) ??
      (language !== "zh" && headIsInstrument ? kindIn(head.slice(0, 300), language, false) : null));
  if (!found) return result({ ...base, kind: "unknown", final: false, reason: "unknown_kind", detail: "标题、文号与原文开头都认不出法律文书种类" });
  if (found.requiresNumber && !re(found.requiresNumber).test(input.number ?? "") && !re(found.requiresNumber).test(input.title))
    return result({
      ...base,
      kind: found.kind,
      nature: found.nature,
      final: true,
      reason: "missing_number",
      detail: "通知、意见、公告须有正式文号才算规范性文件",
    });

  const personnel = firstHit(vocab.personnel[language], operative);
  if (personnel)
    return result({ ...base, kind: "personnel", nature: found.nature, final: true, reason: "personnel", detail: `人事、表彰或许可：${personnel}` });
  const individual = firstHit(vocab.individual_act[language], firstArticle);
  if (individual)
    return result({
      ...base,
      kind: "individual_act",
      nature: found.nature,
      final: true,
      reason: "individual_act",
      detail: `个案行政行为：${individual.slice(0, 60)}`,
    });

  const changeText = language === "zh" ? zhTitle(input.title) : `${titleText} ${foldText(input.excerpt.slice(0, 4000))}`;
  const change =
    vocab.repeal[language] && re(vocab.repeal[language]!).test(language === "zh" ? changeText : firstArticle || changeText)
      ? "repeal"
      : vocab.amendment[language] && re(vocab.amendment[language]!).test(language === "zh" ? changeText : firstArticle || changeText)
        ? "amendment"
        : null;
  const relevance = miningRelevance({ title: input.title, issuer: input.issuer, excerpt: input.excerpt.slice(0, 6000) }, language);
  return result({
    kind: found.kind,
    nature: found.nature,
    final: true,
    mining: relevance.mining,
    change,
    reason: relevance.mining ? "instrument" : "not_mining",
    detail: relevance.detail,
  });
}

/** Chinese reader wording for each reason (dry run, audit and the private record; readers never see excluded items). */
export const INSTRUMENT_GATE_REASON_ZH: Record<InstrumentGateReason, string> = {
  instrument: "正式公布的矿业相关法律文书",
  not_final: "草案、征求意见或预告，归资讯“政策监管”",
  not_normative: "公告、启事等非规范性文件",
  personnel: "人事任免、表彰或行政许可",
  individual_act: "针对具体企业的个案行政行为",
  unknown_kind: "认不出法律文书种类",
  missing_number: "缺少正式文号的通知或公告",
  not_mining: "与矿业无关",
};
