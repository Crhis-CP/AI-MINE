/** Copy succeeds only when either browser path confirms it. Restore focus after fallback. */
export async function copyText(url: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {
    /* The bounded legacy fallback still has to prove it copied. */
  }
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = url;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy rejected");
  } finally {
    field.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
