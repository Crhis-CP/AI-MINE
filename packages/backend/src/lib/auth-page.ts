// MIT attribution and fixed source revision: UPSTREAM.md. Match path segments, never article prose.
const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|register|signup|sign-up|authorize|oauth2?|sso|auth)(?:\/|$)/i;

export function isSignInUrl(url: string): boolean {
  try {
    return AUTH_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isSignInRedirect(asked: string, landed: string): boolean {
  // An existing registry path gaining a slash still identifies the requested page.
  return !isSignInUrl(asked) && isSignInUrl(landed);
}
