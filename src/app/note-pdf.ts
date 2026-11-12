/** A note to print as PDF. NotePdfHost renders it and opens the print dialog. */
export type PdfJob = { title: string; content: string };

type Handler = (job: PdfJob) => void;

let handler: Handler | null = null;

export function requestNotePdf(job: PdfJob) {
  handler?.(job);
}

export function bindNotePdf(next: Handler) {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}
