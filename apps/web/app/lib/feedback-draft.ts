import { WEB_MODULES } from "@amp/site/modules/web";
import { KEYS } from "./local-state";

export interface Draft {
  content: string;
  email: string;
  pageUrl: string;
  submission?: { key: string; signature: string };
}

function parseDraft(value: unknown): Draft | null {
  if (typeof value !== "object" || !value || Array.isArray(value)) return null;
  const d = value as Partial<Draft>;
  const submission =
    typeof d.submission?.key === "string" && /^[0-9a-f-]{36}$/i.test(d.submission.key) && typeof d.submission?.signature === "string"
      ? { key: d.submission.key, signature: d.submission.signature }
      : undefined;
  return { content: String(d.content ?? ""), email: String(d.email ?? ""), pageUrl: String(d.pageUrl ?? ""), submission };
}

export function readDraft(): Draft | null {
  try {
    const draft = parseDraft(JSON.parse(localStorage.getItem(KEYS.feedbackDraft) ?? "null"));
    if (draft) return draft;
  } catch {
    // A module copy may still be readable when browser storage is unavailable.
  }
  for (const module of WEB_MODULES) {
    try {
      const draft = parseDraft(module.feedbackDraft?.read());
      if (draft) return draft;
    } catch {
      // One unavailable copy must not hide the next recoverable draft.
    }
  }
  return null;
}

export function writeDraft(draft: Draft | null, submitted = false): boolean {
  let saved = false;
  try {
    if (draft === null) localStorage.removeItem(KEYS.feedbackDraft);
    else localStorage.setItem(KEYS.feedbackDraft, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
    saved = true;
  } catch {
    // Keep module copies until this browser saves, or the server confirms receipt.
  }
  if ((saved && draft !== null) || (draft === null && submitted)) {
    for (const module of WEB_MODULES) {
      try {
        module.feedbackDraft?.clear();
      } catch {
        // The saved draft or confirmed receipt is still valid.
      }
    }
  }
  return saved;
}
