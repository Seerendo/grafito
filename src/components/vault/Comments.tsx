import { FileText, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteComment, sendComment, useComments, useDocComments, type DocComment, type PdfNote } from "@/app/comments";
import { intl, t } from "@/app/i18n";

const NO_NOTES: PdfNote[] = [];

/**
 * Comentarios de una nota o un archivo, propio o compartido conmigo (`shareId`).
 * Comentar no edita el documento: sirve aunque se tenga solo lectura. En un
 * PDF también están las notas sobre una frase (se dejan desde el visor) y las
 * que ya traía el archivo; al pulsarlas, el visor va a su sitio.
 */
export function Comments({ docId, shareId, onCount }: { docId: string; shareId?: string; onCount?: (count: number) => void }) {
  const { comments, isOwner } = useDocComments(docId, shareId);
  const pdfNotes = useComments((state) => state.pdfNotes[docId] ?? NO_NOTES);
  const focusPdf = useComments((state) => state.focusPdf);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft("");
    setError("");
  }, [docId, shareId]);

  useEffect(() => {
    if (comments) onCount?.(comments.length + pdfNotes.length);
  }, [comments, pdfNotes, onCount]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    const failed = await sendComment(docId, shareId, body);
    if (failed) setError(failed);
    else setDraft("");
    setSending(false);
  };

  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

  return (
    <div data-ui="comments" className="space-y-2">
      {comments === null ? (
        <p className="px-1.5 text-sm text-faint">{t("Cargando…")}</p>
      ) : comments.length === 0 && pdfNotes.length === 0 ? (
        <p className="px-1.5 text-sm text-faint italic">{t("Sin comentarios.")}</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              when={when(comment.at)}
              canDelete={comment.mine || isOwner}
              onDelete={() => void deleteComment(docId, shareId, comment.id)}
              onFocus={comment.anchor ? () => focusPdf(docId, comment.anchor!.page, comment.anchor!.exact) : undefined}
            />
          ))}
        </ul>
      )}
      {pdfNotes.length > 0 ? (
        <div className="space-y-2">
          <p className="px-1.5 pt-1 text-xs font-medium text-faint">{t("Notas que trae el PDF")}</p>
          <ul className="space-y-2">
            {pdfNotes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => focusPdf(docId, note.page)}
                  className="block w-full rounded-md bg-inset px-2.5 py-2 text-left hover:bg-elevated"
                >
                  <span className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium text-fg">{note.author || t("Sin autor")}</span>
                    <span className="shrink-0 text-faint">{t("Pág. {n}", { n: note.page })}</span>
                  </span>
                  <span className="mt-1 block text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{note.body}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="flex items-end gap-1.5 rounded-md border border-line bg-inset p-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={4000}
          aria-label={t("Escribe un comentario")}
          placeholder={t("Escribe un comentario…")}
          className="min-h-9 w-full resize-y border-0 bg-transparent px-1.5 py-1 text-sm text-fg outline-none placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          aria-label={t("Comentar")}
          title={t("Comentar")}
          className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-40"
        >
          <Send className="size-3.5" />
        </button>
      </form>
      {error ? <p className="px-1.5 text-xs text-danger">{t(error)}</p> : null}
    </div>
  );
}

function CommentItem({
  comment,
  when,
  canDelete,
  onDelete,
  onFocus,
}: {
  comment: DocComment;
  when: string;
  canDelete: boolean;
  onDelete: () => void;
  onFocus?: () => void;
}) {
  return (
    <li className="group rounded-md bg-inset px-2.5 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{comment.author}</span>
        <span className="shrink-0 text-faint">{when}</span>
        {canDelete ? (
          <button
            type="button"
            aria-label={t("Borrar comentario")}
            title={t("Borrar comentario")}
            onClick={onDelete}
            className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {comment.anchor && onFocus ? (
        <button
          type="button"
          onClick={onFocus}
          className="mt-1.5 flex w-full items-start gap-1.5 rounded border-l-2 border-yellow-400 bg-surface px-2 py-1 text-left text-xs text-muted hover:text-fg"
        >
          <FileText className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1 line-clamp-2">{comment.anchor.exact}</span>
          <span className="shrink-0 text-faint">{t("Pág. {n}", { n: comment.anchor.page })}</span>
        </button>
      ) : null}
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{comment.body}</p>
    </li>
  );
}
