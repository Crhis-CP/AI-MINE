// An acceptance case: one effect the Owner asked for, written so it can be run against any implementation.
// The rewrite (DEC-79) is judged by these cases, not by matching the old code: the same list runs on the code
// that is live today and on the code that replaces it. A case does not say how; it gives an input and says what
// a reader must end up seeing.

export interface AcceptanceCase<Effects> {
  /** Stable name; baselines refer to it. */
  id: string;
  /** What the reader saw or wants, in the Owner's words. */
  says: string;
  /** Null when the implementation gives the reader the right thing; otherwise what is wrong. */
  check: (effects: Effects) => string | null;
}

/** For an effect an implementation does not have at all. */
export const missing = (effect: string) => `no such ability yet: ${effect}`;

/** Each case's outcome on one implementation, in the order of the cases. A case that throws is a failed case. */
export function runCases<Effects>(cases: readonly AcceptanceCase<Effects>[], effects: Effects): Map<string, string | null> {
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error("Acceptance case ids must be unique");
  return new Map(
    cases.map((c) => {
      try {
        return [c.id, c.check(effects)];
      } catch (error) {
        return [c.id, `threw: ${(error as Error).message}`];
      }
    }),
  );
}
