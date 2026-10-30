/**
 * Quién puede recibir un recuadro de firma: quien ya puede abrir el documento
 * (`grantedIds`), el dueño y quien lo está pidiendo. Las cuentas internas de
 * un espacio de trabajo no firman (no entra nadie con ellas).
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
