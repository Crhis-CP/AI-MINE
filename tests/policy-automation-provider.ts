// Synthetic source-sensitive provider reply for local automation tests only.
type Payload = ReturnType<typeof JSON.parse>;
const visible = (value: string) => value.replace(/<[^>]+>/g, "");
function candidate(input: Payload) {
  const quote = input.root.quotes[0],
    known = (value: string) => ({ value, basis: "原文", evidence_ids: ["e1"] });
  const unknown = { value: "unknown", basis: null, evidence_ids: [] };
  return {
    id: input.id,
    input_hash: input.input_hash,
    input_ids: [input.root.id],
    document_title: input.identity.title,
    title_zh: "合成矿业规章",
    instrument_number: input.identity.number,
    relevance: "relevant",
    relevance_evidence_ids: ["e1"],
    legal_state: {
      nature: known("regulation"),
      legislative_stage: known("published"),
      publication: { ...known("published"), time: null },
      enforcement: { ...unknown, arrangements: [] },
      applicability: [],
      deadlines: [],
      repeal: unknown,
    },
    main_points: [{ text: "矿业阈值规定", clause_ref: quote.node_path ?? "原文", evidence_ids: ["e1"] }],
    impacts: [
      {
        id: "impact1",
        theme: "safety_environment",
        region: "AR",
        legal_actor: "矿权人",
        affected_actor: "矿权人",
        activity: "矿业生产",
        condition: "符合原文条件",
        effect_mode: "direct",
        impact: "适用阈值规定",
        deadline: null,
        exceptions: "保留原文例外",
        evidence_ids: ["e1"],
      },
    ],
    relationships: [],
    dynamic_zh: input.previous_candidate ? "仅在原文条件下适用阈值规定。" : "矿业活动适用阈值规定。",
    gaps: [],
    comparisons: [],
    evidence: [{ id: "e1", part_id: quote.part_id, quote: quote.quote }],
  };
}
export function answer(input: Payload): Payload {
  if (!input.phase)
    return {
      parts: input.parts.map((part: Payload) => ({
        partId: part.partId,
        sourceHash: part.sourceHash,
        classification: "facts",
        facts: [{ statement: "适用量和例外", role: "scope", quote: visible(part.source) }],
        zh: part.source
          .replaceAll("Published Regulation: Mining threshold at", "已公布的规章：矿业阈值为")
          .replaceAll("Exception: mining above", "例外：矿业量超过")
          .replaceAll("is prohibited.", "被禁止。"),
      })),
    };
  const bound = { id: input.id, input_hash: input.input_hash };
  if (input.phase === "group") {
    const result = {
      ...bound,
      input_ids: input.parts.map((part: Payload) => part.partId),
      consistent: true,
      roles: input.parts.map((part: Payload) => ({ part_id: part.partId, roles: ["scope"] })),
      summary: "本组全部矿业阈值及文末例外。",
      quotes: input.parts.slice(0, 2).map((part: Payload) => ({ part_id: part.partId, quote: visible(part.source).slice(0, 200) })),
    };
    return result;
  }
  if (input.phase === "merge")
    return {
      ...bound,
      input_ids: input.children.map((child: Payload) => child.id),
      summary: "全部子组的矿业阈值、条件与例外。",
      quotes: input.children.flatMap((child: Payload) => child.quotes).slice(0, 2),
    };
  if (input.phase === "candidate") return candidate(input);
  return {
    ...bound,
    group_id: input.group_id,
    candidate_hash: input.candidate_hash,
    publication_authorized: false,
    judgments: input.claims.map((claim: Payload) => ({
      claim_id: claim.id,
      verdict: claim.requiresSupport ? "supports" : "not_applicable",
      quotes: claim.requiresSupport ? [{ part_id: input.parts[0].partId, quote: visible(input.parts[0].source).slice(0, 200) }] : [],
      reason: "合成provider判断",
    })),
  };
}
