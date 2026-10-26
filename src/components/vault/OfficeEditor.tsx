import { useEffect, useId, useRef, useState } from "react";
import { officeSession } from "@/server/office.functions";
import { t } from "@/app/i18n";

type Session = Extract<Awaited<ReturnType<typeof officeSession>>, { ok: true }>;

/**
 * Documento de Office abierto en el editor (Collabora) dentro de un iframe.
 * El editor se abre con un formulario POST que lleva la ficha firmada, como
 * pide WOPI; así la ficha no queda en la URL ni en el historial.
 */
export function OfficeEditor({
  docId,
  shareId,
  lang,
  onClose,
  onSaved,
}: {
  docId: string;
  shareId?: string;
  lang: "es" | "en";
  onClose: () => void;
  onSaved?: () => void;
}) {
  const frameName = `office-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const formRef = useRef<HTMLFormElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void officeSession({ data: { docId, shareId, origin: window.location.origin, lang } })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setSession(result);
        else setError(result.error);
      })
      .catch(() => {
        if (!cancelled) setError(t("No se pudo abrir el editor."));
      });
    return () => {
      cancelled = true;
    };
  }, [docId, shareId, lang]);

  useEffect(() => {
    if (session) formRef.current?.submit();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const editorOrigin = new URL(session.url).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== editorOrigin) return;
      let message: { MessageId?: string; Values?: { Status?: string; IsModifiedStatus?: boolean } } = {};
      try {
        message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (message.MessageId === "App_LoadingStatus" && message.Values?.Status === "Document_Loaded") {
        frameRef.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: "Host_PostmessageReady" }), editorOrigin);
      } else if (message.MessageId === "UI_Close") {
        onClose();
      } else if (message.MessageId === "Doc_ModifiedStatus" && message.Values?.IsModifiedStatus === false) {
        onSaved?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [session, onClose, onSaved]);

  if (error) return <p className="p-6 text-sm text-danger">{t(error)}</p>;
  if (!session) return <p className="p-6 text-sm text-faint">{t("Cargando…")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form ref={formRef} action={session.url} method="post" target={frameName} className="hidden">
        <input type="hidden" name="access_token" value={session.token} />
        <input type="hidden" name="access_token_ttl" value={String(session.expiresAt)} />
      </form>
      <iframe
        ref={frameRef}
        name={frameName}
        title={t("Editor de Office")}
        allow="clipboard-read; clipboard-write; fullscreen"
        className="min-h-0 w-full flex-1 border-0 bg-surface"
      />
    </div>
  );
}
