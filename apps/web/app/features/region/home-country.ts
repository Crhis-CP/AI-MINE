// Which country the home page opens with (TASK-0633). Mining news is local in a way most news is not: someone working in
// Argentina first needs Argentina's notices, companies and projects. The reader's own choice is kept in this browser
// only; without one, the device's time zone suggests a country. No address is looked up and nothing is sent anywhere.
export const HOME_COUNTRY_KEY = "amp-home-country";
/** The stored value for “open with the whole world”: a reader who said so is not asked again. */
export const WORLD = "world";

export function readHomeCountry(): string | null {
  try {
    const value = window.localStorage.getItem(HOME_COUNTRY_KEY);
    return value && (value === WORLD || /^[A-Z]{2}$/.test(value)) ? value : null;
  } catch {
    return null;
  }
}

/** The reader's province or state inside the chosen country (TASK-0636), e.g. "CN-XJ"; kept in this browser only. */
export const HOME_PROVINCE_KEY = "amp-home-province";

export function readHomeProvince(country: string): string | null {
  try {
    const value = window.localStorage.getItem(HOME_PROVINCE_KEY);
    return value?.startsWith(`${country}-`) && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** An empty value forgets the province. */
export function writeHomeProvince(value: string): void {
  try {
    if (value) window.localStorage.setItem(HOME_PROVINCE_KEY, value);
    else window.localStorage.removeItem(HOME_PROVINCE_KEY);
  } catch {
    // Private mode: the choice lasts for this page view.
  }
}

export function writeHomeCountry(value: string): void {
  try {
    window.localStorage.setItem(HOME_COUNTRY_KEY, value);
  } catch {
    // Private mode: the choice lasts for this page view.
  }
}

/** The device's IANA time zone name, or null where the browser does not say. */
export function deviceZone(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The countries the home page can open with. Owner 2026-11-13: “先开始从中国和阿根廷就可以了”. A country joins when its
 * sources are deep enough that its own block is worth opening with; everyone else opens with the world.
 */
export const HOME_COUNTRIES: readonly string[] = ["CN", "AR"];

export type HomeCountry = { code: string | null; chosen: boolean };

/** The reader's choice, else the time zone's country; `chosen` says which. A stored “world” is a choice of no country. */
export async function resolveHomeCountry(): Promise<HomeCountry> {
  const stored = readHomeCountry();
  if (stored) return { code: HOME_COUNTRIES.includes(stored) ? stored : null, chosen: true };
  const { countryOfZone } = await import("./zones.ts");
  const guess = countryOfZone(deviceZone());
  return { code: guess && HOME_COUNTRIES.includes(guess) ? guess : null, chosen: false };
}
