// Synthetic source-sensitive provider replies for local policy tests only (never a real model).
type Payload = ReturnType<typeof JSON.parse>;

/** A literal translation stand-in: keeps markup, numbers and dates, adds Han text to every text node. */
export function translate(part: { format: string; source: string }) {
  return part.format === "html" ? part.source.replace(/>([^<]*\S[^<]*)</g, (_m, text: string) => `>译文：${text}<`) : `译文：${part.source}`;
}
export function fulltextReply(input: Payload) {
  return { parts: input.parts.map((part: Payload) => ({ sourceHash: part.sourceHash, zh: translate(part) })) };
}
/** One interpret delta citing the first part of every provision in the request (no numbers, so code can verify it). */
export function interpretReply(input: Payload) {
  // At most 16 main points per reply, as the schema allows.
  const provisions = input.provisions.filter((p: Payload) => p.parts.length).slice(0, 16);
  const evidence = provisions.map((p: Payload, index: number) => ({ id: `e${index + 1}`, part_id: p.parts[0].ref, quote: p.parts[0].text.slice(0, 200) }));
  const first = evidence[0]?.id;
  const known = (value: string) => ({ value, basis: "原文", evidence_ids: [first] });
  const unknown = { value: "unknown", basis: null, evidence_ids: [] };
  return {
    title_zh: "合成矿业规章",
    relevance: "relevant",
    relevance_evidence_ids: [first],
    legal_state: {
      nature: known("regulation"),
      legislative_stage: known("published"),
      publication: { ...known("published"), time: null },
      enforcement: { ...unknown, arrangements: [] },
      applicability: [],
      deadlines: [],
      repeal: unknown,
    },
    main_points: provisions.map((p: Payload, index: number) => ({
      text: p.change === "modified" ? "条款要求已修改" : "矿业规定要点",
      clause_ref: p.label ?? "原文",
      evidence_ids: [evidence[index].id],
    })),
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
        impact: "适用原文规定",
        deadline: null,
        exceptions: "保留原文例外",
        evidence_ids: [first],
      },
    ],
    relationships: [],
    dynamic_zh: input.mode === "amendment" ? "本次修订改变了相关条款。" : "矿业活动适用本规定。",
    gaps: [],
    evidence,
  };
}
export function verifyReply(input: Payload, verdict: (claim: Payload) => string = () => "supports") {
  return {
    judgments: input.claims.map((claim: Payload) => {
      const value = verdict(claim);
      return {
        claim_id: claim.id,
        verdict: value,
        quotes: value === "not_applicable" ? [] : [{ part_id: input.parts[0].ref, quote: input.parts[0].text.slice(0, 200) }],
        reason: "合成provider判断",
      };
    }),
  };
}
export function answer(input: Payload): Payload {
  if (!input.phase) return fulltextReply(input);
  if (input.phase === "interpret") return interpretReply(input);
  return verifyReply(input);
}
