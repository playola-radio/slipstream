/** Quotes a value for a POSIX shell command line only when it needs quoting. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
