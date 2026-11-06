// The public jurisdiction list with news counts, read once per page view and shared by the country
// filter and the world map (both only render it after hydration; the list is not part of the HTML).
import { useEffect, useState } from "react";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { z } from "zod";
import { apiFetch } from "../../lib/http.ts";

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
    let live = true;
    load().then(
      (list) => live && setChoices(list),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  return { choices, failed };
}
