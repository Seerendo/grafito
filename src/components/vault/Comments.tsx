import { Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { addDocComment, docComments, removeDocComment } from "@/server/comments.functions";
import { intl, t } from "@/app/i18n";

type Comment = { id: string; author: string; body: string; at: number; mine: boolean };

/** Cada cuánto se vuelven a leer mientras están a la vista. */
const REFRESH_MS = 20_000;

/**
 * Comentarios de una nota o un archivo, propio o compartido conmigo (`shareId`).
 * Comentar no edita el documento: sirve aunque se tenga solo lectura.
 */
export function Comments({ docId, shareId, onCount }: { docId: string; shareId?: string; onCount?: (count: number) => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await docComments({ data: { docId, ...(shareId ? { shareId } : {}) } });
      setComments(result.comments);
      setIsOwner(result.isOwner);
    } catch {
      setComments((current) => current ?? []);
    }
  }, [docId, shareId]);

  useEffect(() => {
    setComments(null);
    setDraft("");
    setError("");
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (comments) onCount?.(comments.length);
  }, [comments, onCount]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await addDocComment({ data: { docId, body, ...(shareId ? { shareId } : {}) } });
      if (!result.ok) setError(result.error);
      else {
        setDraft("");
        await load();
      }
    } catch {
      setError("No se pudo enviar.");
    } finally {
      setSending(false);
    }
  };

  const remove = async (id: string) => {
    setComments((current) => current?.filter((comment) => comment.id !== id) ?? null);
    try {
      await removeDocComment({ data: { docId, id, ...(shareId ? { shareId } : {}) } });
    } finally {
      void load();
    }
  };

  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

  return (
    <div data-ui="comments" className="space-y-2">
      {comments === null ? (
        <p className="px-1.5 text-sm text-faint">{t("Cargando…")}</p>
      ) : comments.length === 0 ? (
        <p className="px-1.5 text-sm text-faint italic">{t("Sin comentarios.")}</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <li key={comment.id} className="group rounded-md bg-inset px-2.5 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{comment.author}</span>
                <span className="shrink-0 text-faint">{when(comment.at)}</span>
                {comment.mine || isOwner ? (
                  <button
                    type="button"
                    aria-label={t("Borrar comentario")}
                    title={t("Borrar comentario")}
                    onClick={() => void remove(comment.id)}
                    className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
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
