/** Representative preference: first-party, full text, higher score, earliest. */
export interface RepresentativeRow {
  first_party: boolean;
  body_mode: string;
  score: number | null;
  timeline_at: Date;
}
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  return [...rows].sort((a, b) => {
    if (a.first_party !== b.first_party) return a.first_party ? -1 : 1;
    if (a.body_mode !== b.body_mode) return a.body_mode === "full" ? -1 : 1;
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sa !== sb) return sb - sa;
    return a.timeline_at.getTime() - b.timeline_at.getTime();
  })[0]!;
}
