// The public jurisdiction list with news counts, read once per page view and shared by the country
// filter and the world map (both only render it after hydration; the list is not part of the HTML).
import { useCallback, useEffect, useMemo, useState } from "react";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { z } from "zod";
import { apiFetch } from "../../lib/http.ts";
import { useLocale, useTr } from "../../i18n";

export type JurisdictionChoice = z.infer<typeof publicSchemas.PolicyJurisdictionList>[number];

let shared: Promise<JurisdictionChoice[]> | null = null;
function load(): Promise<JurisdictionChoice[]> {
  shared ??= apiFetch("/api/site/jurisdictions", { baseUrl: window.location.origin })
    .then(async (response) => {
      if (!response.ok) throw new Error("jurisdictions unavailable");
      return publicSchemas.PolicyJurisdictionList.parse(await response.json());
    })
    .catch((error: unknown) => {
      shared = null; // a later mount may try again
      throw error;
    });
  return shared;
}

export function useJurisdictionChoices(): { choices: JurisdictionChoice[] | null; failed: boolean } {
  const [choices, setChoices] = useState<JurisdictionChoice[] | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    // Like the news map: one quiet retry before the select and the chips give up (TASK-0568 Q2).
    const attempt = (retries: number) =>
      load().then(
        (list) => live && setChoices(list),
        () => {
          if (!live) return;
          if (retries > 0) timer = setTimeout(() => attempt(retries - 1), 2500);
          else setFailed(true);
        },
      );
    attempt(1);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return { choices, failed };
}

/**
 * A place's name in the interface language: the English interface names countries itself (the API's labels
 * are Chinese) and other kinds through the phrase list. Shared by the country filter, the country chips and
 * the news map (TASK-0568).
 */
export function useRegionName(): (place: { code: string; label: string; kind?: string }) => string {
  const english = useLocale() === "en";
  const tr = useTr();
  const names = useMemo(() => (english && typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null), [english]);
  return useCallback((place) => ((place.kind ?? "country") === "country" ? (names?.of(place.code) ?? place.label) : tr.maybe(place.label)), [names, tr]);
}
