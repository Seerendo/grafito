/** Characters of one document sent to the model in a single read. */
export const READ_SLICE = 4_000;

/**
 * A window of document text. The model can ask for the next window with offset instead of
 * receiving the whole file.
 */
export function readSlice(
  text: string,
  offset: number,
  size = READ_SLICE,
): { content: string; offset: number; length: number; truncated: boolean } {
  const length = text.length;
  const start = Number.isInteger(offset) && offset > 0 ? Math.min(offset, length) : 0;
  const content = text.slice(start, start + size);
  return {
    content,
    offset: start,
    length,
    truncated: start + content.length < length,
  };
}
