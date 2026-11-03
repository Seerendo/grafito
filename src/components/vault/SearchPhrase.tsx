import { markSpans, type Passage } from "@/domain/search-text";

/** Pinta en negrita cada vez que la frase aparece en un título. */
export function Marked({ text, query }: { text: string; query: string }) {
  return markSpans(text, query).map((span, index) =>
    span.mark ? (
      <strong key={index} className="font-semibold text-fg">
        {span.text}
      </strong>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  );
}

/** Una línea por aparición: el texto del documento, con la frase en negrita. */
export function PassageLines({
  passages,
  more = 0,
  moreLabel = "",
}: {
  passages: Passage[];
  more?: number;
  moreLabel?: string;
}) {
  if (passages.length === 0) return null;
  return (
    <>
      {passages.map((passage, index) => (
        <span key={index} className="block truncate pl-6 text-xs text-muted">
          {passage.before}
          <strong className="font-semibold text-fg">{passage.match}</strong>
          {passage.after}
        </span>
      ))}
      {more > 0 && moreLabel ? (
        <span className="block truncate pl-6 text-xs text-faint">{moreLabel}</span>
      ) : null}
    </>
  );
}
