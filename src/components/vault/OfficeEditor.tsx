import { useEffect, useId, useRef, useState } from "react";
import { reportViewer } from "@/app/files";
import { onBeforeRestore } from "@/app/office";
import { useVault } from "@/app/vault/store";
import { knownToServer, onSynced, syncVault } from "@/app/vault/sync";
import { officeSession } from "@/server/office.functions";
import { t } from "@/app/i18n";

type Session = Extract<Awaited<ReturnType<typeof officeSession>>, { ok: true }>;

/** Timeout for the editor to save and close before restoring a version. */
const RESTORE_WAIT_MS = 8000;

/**
 * Collabora Office document in an iframe. A WOPI POST form carries the signed token, keeping it
 * out of URLs and history.
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
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stop = () => {};
    setSession(null);
    setError("");
    const started = performance.now();
    void officeSession({ data: { docId, shareId, origin: window.location.origin, lang } })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPending(false);
          setSession(result);
          return;
        }
        const owner = useVault.getState().owner;
        if ("pending" in result && owner && !knownToServer(owner, docId)) {
          // Still on its way to the server: open it once a synchronization went through.
          setPending(true);
          stop = onSynced(() => setAttempt((value) => value + 1));
          void syncVault(owner);
          return;
        }
        setPending(false);
        setError(result.error);
        reportViewer(
          "office",
          "pending" in result ? "missing" : "setup" in result ? "setup" : "refused",
          performance.now() - started,
        );
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError("No se pudo abrir el editor.");
        reportViewer(
          "office",
          failure instanceof Error ? `request ${failure.name}` : "request",
          performance.now() - started,
        );
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [docId, shareId, lang, attempt]);

  useEffect(() => {
    if (session) formRef.current?.submit();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const editorOrigin = new URL(session.url).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== editorOrigin) return;
      let message: {
        MessageId?: string;
        Values?: { Status?: string; IsModifiedStatus?: boolean };
      } = {};
      try {
        message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (
        message.MessageId === "App_LoadingStatus" &&
        message.Values?.Status === "Document_Loaded"
      ) {
        frameRef.current?.contentWindow?.postMessage(
          JSON.stringify({ MessageId: "Host_PostmessageReady" }),
          editorOrigin,
        );
      } else if (message.MessageId === "UI_Close") {
        onClose();
      } else if (
        message.MessageId === "Doc_ModifiedStatus" &&
        message.Values?.IsModifiedStatus === false
      ) {
        onSaved?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [session, onClose, onSaved]);

  useEffect(() => {
    if (!session) return;
    const editorOrigin = new URL(session.url).origin;
    return onBeforeRestore(
      docId,
      () =>
        new Promise<void>((resolve) => {
          const done = () => {
            window.clearTimeout(timer);
            window.removeEventListener("message", onAck);
            resolve();
          };
          const onAck = (event: MessageEvent) => {
            if (event.origin !== editorOrigin) return;
            let message: { MessageId?: string; Values?: { Status?: string } } = {};
            try {
              message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            } catch {
              return;
            }
            if (
              message.MessageId === "App_VersionRestore" &&
              message.Values?.Status === "Pre_Restore_Ack"
            )
              done();
          };
          const timer = window.setTimeout(done, RESTORE_WAIT_MS);
          window.addEventListener("message", onAck);
          frameRef.current?.contentWindow?.postMessage(
            JSON.stringify({ MessageId: "Host_VersionRestore", Values: { Status: "Pre_Restore" } }),
            editorOrigin,
          );
        }),
    );
  }, [session, docId]);

  if (error)
    return (
      <p data-ui="office-error" className="p-6 text-sm text-danger">
        {t(error)}
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="ml-3 inline-flex h-9 items-center rounded-md border border-line px-3 text-fg hover:bg-elevated"
        >
          {t("Reintentar")}
        </button>
      </p>
    );
  if (!session)
    return (
      <p data-ui="office-status" className="p-6 text-sm text-faint">
        {pending
          ? t("Este documento aún no está en el servidor; se abrirá en cuanto se sincronice.")
          : t("Cargando…")}
      </p>
    );
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
        // The Office editor requests light mode; keep its frame light during loading too.
        style={{ colorScheme: "light" }}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
