/**
 * Signature recipients must already have document access, own it or request the signature.
 * Internal workspace accounts cannot sign because nobody signs in as them.
 */
export function keepSigners(input: {
  ownerId: string;
  callerId: string;
  grantedIds: readonly string[];
  hiddenIds: ReadonlySet<string>;
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const allow = (id: string) => {
    if (!id || input.hiddenIds.has(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  allow(input.ownerId);
  allow(input.callerId);
  for (const id of input.grantedIds) allow(id);
  return ids;
}
