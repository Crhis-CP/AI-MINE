/** Carry only the current local page and query; document.referrer does not follow SPA navigation. */
export function feedbackPath(pathname: string, search = "") {
  // The feedback page itself, in either interface language (/en/feedback is the same page in English).
  return /^(?:\/en)?\/feedback$/.test(pathname) ? "/feedback" : `/feedback?${new URLSearchParams({ from: pathname + search })}`;
}
export function localFeedbackOrigin(value: string | null | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") && !/[\\\r\n]/.test(value) ? value.slice(0, 500) : "";
}
