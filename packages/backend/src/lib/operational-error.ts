/** Also matches a URI cut off by a legacy database projection before its host or closing quote. */
export function redactDatabaseConnection(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]*/gi, "[database connection]");
}
