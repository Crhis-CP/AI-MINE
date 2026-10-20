/** Legacy command quoting cannot delimit an unescaped credential; discard the diagnostic suffix. */
export function redactDatabaseConnection(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[\s\S]*/gi, "[database connection]");
}
