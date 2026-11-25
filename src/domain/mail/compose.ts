/**
 * Writing mail: where the account's signature goes. Relative imports allow direct Node tests.
 */

/** The signature as it is written into a message: the usual "-- " separator line, then the text. */
export function signatureBlock(signature: string): string {
  return signature.trim() ? `\n\n-- \n${signature.trim()}` : "";
}

/** The signature goes below a new message, and above the quoted text of a reply or forward. */
export function withSignature(text: string, signature: string): string {
  const block = signatureBlock(signature);
  if (!block) return text;
  if (!text) return block;
  return text.startsWith("\n\n") ? `${block}${text}` : `${text}${block}`;
}

/** Switching the sending account swaps its signature, or adds the new one. */
export function swapSignature(text: string, before: string, after: string): string {
  const old = signatureBlock(before);
  const next = signatureBlock(after);
  if (old && text.includes(old)) return text.replace(old, next);
  return next ? withSignature(text, after) : text;
}
