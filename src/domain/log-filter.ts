/** ILIKE pattern that matches text anywhere, with the user's wildcards removed. */
export function likePattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, "")}%`;
}

/** ISO instant for a date filter, or "" when the value is blank or not a date. */
export function filterInstant(value: string | undefined): string {
  if (!value?.trim()) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}
