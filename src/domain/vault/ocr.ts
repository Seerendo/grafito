/** Files OCR can read (server/ocr.ts): PDFs and the common image formats. */
export function ocrCandidate(name: string, mime: string): boolean {
  return (
    mime === "application/pdf" ||
    /^image\/(png|jpe?g|tiff?)$/i.test(mime) ||
    /\.(pdf|png|jpe?g|tiff?)$/i.test(name)
  );
}
