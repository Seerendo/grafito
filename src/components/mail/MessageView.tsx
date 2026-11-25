import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Download,
  EyeOff,
  FileDown,
  ImageOff,
  Forward,
  MailOpen,
  Reply,
  ReplyAll,
  Paperclip,
  Star,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { intl, t } from "@/app/i18n";
import { mailFrameDocument, sanitizeMailHtml } from "@/app/mail/sanitize";
import { useVault } from "@/app/vault/store";
import { riskyAttachment } from "@/domain/mail/message";
import { Modal } from "@/components/ui/Modal";
import type { Draft } from "./Compose";
import { PdfView } from "@/components/vault/PdfView";
import {
  mailArchive,
  mailArchiveTargets,
  mailAttachment,
  mailMark,
  mailMessage,
} from "@/server/mailbox.functions";

/**
 * One message: who and when, the body (HTML cleaned and shown in a sandboxed frame, or the plain
 * text), its attachments (downloaded on demand by the worker, scanned, then shown with Grafito's
 * own viewers) and what can be done with it here: local marks and archiving into the vault.
 */

type Detail = Extract<Awaited<ReturnType<typeof mailMessage>>, { ok: true }>["message"];
type Attachment = Detail["attachments"][number];
type Link = { url: string; download: string };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function people(list: { name: string; address: string }[]): string {
  return list
    .map((item) => (item.name ? `${item.name} <${item.address}>` : item.address))
    .join(", ");
}

/** Ask the worker for an attachment and wait (at most a minute) until it is ready or refused. */
async function fetchAttachment(
  id: string,
  onStatus: (status: string) => void,
): Promise<Link | string> {
  const deadline = Date.now() + 60_000;
  let wait = 600;
  for (;;) {
    const answer = await mailAttachment({ data: { id } }).catch(() => null);
    if (!answer?.ok) return answer?.error ?? "No se pudo abrir el adjunto.";
    onStatus(answer.status);
    if (answer.status === "ready" && answer.url && answer.download)
      return { url: answer.url, download: answer.download };
    if (answer.status === "blocked") return "El antivirus bloqueó este adjunto.";
    if (answer.status === "too_large") return "El adjunto supera el tamaño permitido.";
    if (answer.status === "failed") return "No se pudo descargar el adjunto. Inténtalo otra vez.";
    if (Date.now() > deadline) return "El adjunto tarda en llegar. Inténtalo en un momento.";
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(3000, wait * 1.5);
  }
}

export function MessageView({
  id,
  onChanged,
  onCompose,
}: {
  id: string;
  onChanged: (change: { seen?: boolean; flagged?: boolean; hidden?: boolean }) => void;
  onCompose: (draft: Draft) => void;
}) {
  const [message, setMessage] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [remote, setRemote] = useState(false);
  const [cid, setCid] = useState<Map<string, string>>(new Map());
  const [states, setStates] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ attachment: Attachment; link: Link } | null>(null);
  const [archiving, setArchiving] = useState<{ attachments: string[] } | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void mailMessage({ data: { id } })
      .then((answer) => {
        if (!alive) return;
        if (answer.ok) setMessage(answer.message);
        else setError(answer.error);
      })
      .catch(() => alive && setError("No se pudo abrir el mensaje."));
    return () => {
      alive = false;
    };
  }, [id]);

  // Embedded images (cid:) are fetched like attachments, then shown through signed links.
  useEffect(() => {
    if (!message?.html || !/cid:/i.test(message.html)) return;
    let alive = true;
    const inline = message.attachments.filter(
      (item) => item.contentId && item.contentType.startsWith("image/"),
    );
    void Promise.all(
      inline.slice(0, 20).map(async (item) => {
        const link = await fetchAttachment(item.id, () => undefined);
        return typeof link === "string"
          ? null
          : ([item.contentId, `${window.location.origin}${link.url}`] as const);
      }),
    ).then((pairs) => {
      if (alive)
        setCid(new Map(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair))));
    });
    return () => {
      alive = false;
    };
  }, [message]);

  const body = useMemo(() => {
    if (!message?.html) return null;
    const clean = sanitizeMailHtml(message.html, { remote, cid });
    return {
      doc: mailFrameDocument(clean.html, {
        remote,
        origin: typeof window === "undefined" ? "" : window.location.origin,
      }),
      blocked: clean.blockedRemote,
    };
  }, [message, remote, cid]);

  if (error) return <p className="p-6 text-sm text-danger">{t(error)}</p>;
  if (!message) return <p className="p-6 text-sm text-faint">{t("Cargando…")}</p>;

  const mark = async (change: { seen?: boolean; flagged?: boolean; hidden?: boolean }) => {
    const answer = await mailMark({ data: { id, ...change } }).catch(() => null);
    if (!answer?.ok) return;
    setMessage({ ...message, ...change });
    onChanged(change);
  };

  const open = async (attachment: Attachment, download: boolean) => {
    const link = await fetchAttachment(attachment.id, (status) =>
      setStates((current) => ({ ...current, [attachment.id]: status })),
    );
    if (typeof link === "string") {
      setStates((current) => ({ ...current, [attachment.id]: link }));
      return;
    }
    setStates((current) => ({ ...current, [attachment.id]: "ready" }));
    if (download || riskyAttachment(attachment.filename)) window.location.assign(link.download);
    else setPreview({ attachment, link });
  };

  const files = message.attachments.filter((item) => !item.inline || !item.contentId);

  // Replies quote the text; forwarding repeats the header. Neither carries the attachments.
  const when = new Date(message.sentAt ?? message.receivedAt).toLocaleString(intl(), {
    dateStyle: "long",
    timeStyle: "short",
  });
  const quoted = message.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const prefixed = (prefix: string) =>
    new RegExp(`^${prefix}:`, "i").test(message.subject)
      ? message.subject
      : `${prefix}: ${message.subject}`;
  const reply = (all: boolean) => {
    const own = message.account.email.toLowerCase();
    const first = message.replyTo.length ? message.replyTo : [message.from];
    const others = all
      ? [...message.to, ...message.cc].filter(
          (item) =>
            item.address.toLowerCase() !== own &&
            !first.some((entry) => entry.address.toLowerCase() === item.address.toLowerCase()),
        )
      : [];
    onCompose({
      accountId: message.account.id,
      to: first.map((item) => item.address).join(", "),
      cc: others.map((item) => item.address).join(", "),
      subject: prefixed("Re"),
      text: `\n\n${t("El {0}, {1} escribió:", { 0: when, 1: people([message.from]) })}\n${quoted}`,
      replyTo: message.id,
    });
  };
  const forward = () =>
    onCompose({
      accountId: message.account.id,
      to: "",
      cc: "",
      subject: prefixed("Rv"),
      text: [
        "",
        "",
        `---------- ${t("Mensaje reenviado")} ----------`,
        `${t("De")}: ${people([message.from])}`,
        `${t("Fecha")}: ${when}`,
        `${t("Asunto")}: ${message.subject}`,
        `${t("Para")}: ${people(message.to)}`,
        "",
        message.text,
      ].join("\n"),
      replyTo: null,
    });

  return (
    <article data-ui="mail-message" className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-line p-4">
        <h2 className="text-lg font-semibold break-words">
          {message.subject || t("(sin asunto)")}
        </h2>
        <p className="text-sm">
          <span className="text-faint">{t("De")}: </span>
          {people([message.from])}
        </p>
        {message.to.length ? (
          <p className="text-sm text-muted">
            <span className="text-faint">{t("Para")}: </span>
            {people(message.to)}
          </p>
        ) : null}
        {message.cc.length ? (
          <p className="text-sm text-muted">
            <span className="text-faint">{t("CC")}: </span>
            {people(message.cc)}
          </p>
        ) : null}
        <p className="text-xs text-faint">
          {new Date(message.sentAt ?? message.receivedAt).toLocaleString(intl(), {
            dateStyle: "full",
            timeStyle: "short",
          })}{" "}
          · {message.account.email}
          {message.folders.length
            ? ` · ${message.folders.map((item) => item.name).join(", ")}`
            : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            onClick={() => reply(false)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
          >
            <Reply className="size-4" />
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => reply(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
          >
            <ReplyAll className="size-4" />
            {t("Responder a todos")}
          </button>
          <button
            type="button"
            onClick={forward}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
          >
            <Forward className="size-4" />
            {t("Reenviar")}
          </button>
          <button
            type="button"
            onClick={() => void mark({ flagged: !message.flagged })}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
            aria-pressed={message.flagged}
          >
            <Star className={`size-4 ${message.flagged ? "fill-current text-accent" : ""}`} />
            {message.flagged ? t("Quitar destacado") : t("Destacar")}
          </button>
          <button
            type="button"
            onClick={() => void mark({ seen: false })}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
          >
            <MailOpen className="size-4" />
            {t("Marcar como no leído")}
          </button>
          <button
            type="button"
            onClick={() => void mark({ hidden: true })}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-2.5 hover:bg-elevated"
          >
            <EyeOff className="size-4" />
            {t("Ocultar aquí")}
          </button>
          <button
            type="button"
            onClick={() => setArchiving({ attachments: [] })}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-2.5 font-medium text-accent-fg"
          >
            <Archive className="size-4" />
            {t("Archivar en Grafito")}
          </button>
        </div>
        {notice ? <p className="text-sm text-accent">{notice}</p> : null}
        {message.archived.length ? (
          <p className="text-xs text-muted">
            {t("Archivado en Grafito: {0}", { 0: message.archived.length })}
          </p>
        ) : null}
      </header>
      {files.length ? (
        <ul data-ui="mail-attachments" className="flex flex-col gap-1 border-b border-line p-3">
          {files.map((attachment) => {
            const state = states[attachment.id] ?? attachment.status;
            const risky = riskyAttachment(attachment.filename);
            return (
              <li
                key={attachment.id}
                data-attachment={attachment.id}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Paperclip className="size-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate" title={attachment.filename}>
                  {attachment.filename || t("(sin nombre)")}{" "}
                  <span className="text-xs text-faint">{size(attachment.size)}</span>
                  {risky ? (
                    <span className="ml-2 text-xs text-danger">
                      {t("Tipo de archivo peligroso")}
                    </span>
                  ) : null}
                </span>
                <span data-ui="attachment-state" className="text-xs text-faint">
                  {state === "queued" || state === "downloading"
                    ? t("Descargando…")
                    : state === "blocked"
                      ? t("Bloqueado por el antivirus")
                      : state === "ready" || state === "none"
                        ? ""
                        : t(state)}
                </span>
                {!risky ? (
                  <button
                    type="button"
                    onClick={() => void open(attachment, false)}
                    className="h-8 rounded-md border border-line px-2 hover:bg-elevated"
                  >
                    {t("Ver")}
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={t("Descargar")}
                  onClick={() => void open(attachment, true)}
                  className="grid size-8 place-items-center rounded-md border border-line hover:bg-elevated"
                >
                  <Download className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label={t("Guardar en Grafito")}
                  onClick={async () => {
                    const link = await fetchAttachment(attachment.id, (status) =>
                      setStates((current) => ({ ...current, [attachment.id]: status })),
                    );
                    if (typeof link === "string")
                      setStates((current) => ({ ...current, [attachment.id]: link }));
                    else setArchiving({ attachments: [attachment.id] });
                  }}
                  className="grid size-8 place-items-center rounded-md border border-line hover:bg-elevated"
                >
                  <FileDown className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {body?.blocked ? (
        <button
          type="button"
          onClick={() => setRemote(true)}
          className="flex items-center gap-2 border-b border-line px-4 py-2 text-left text-xs text-muted hover:bg-elevated"
        >
          <ImageOff className="size-4" />
          {t("Imágenes de internet bloqueadas: {0}. Cargarlas", { 0: body.blocked })}
        </button>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {message.bodyState === "too_large" ? (
          <p className="p-4 text-sm text-muted">
            {t(
              "El cuerpo de este mensaje es demasiado grande para guardarlo. Archívalo como .eml para conservarlo completo.",
            )}
          </p>
        ) : body ? (
          <iframe
            title={t("Contenido del mensaje")}
            data-ui="mail-body"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={body.doc}
            className="h-full min-h-[60vh] w-full border-0 bg-white"
          />
        ) : (
          <pre
            data-ui="mail-text"
            className="p-4 font-sans text-sm whitespace-pre-wrap break-words"
          >
            {message.text || message.snippet || t("(sin contenido)")}
          </pre>
        )}
      </div>
      {preview ? (
        <AttachmentPreview
          attachment={preview.attachment}
          link={preview.link}
          onClose={() => setPreview(null)}
          onSave={() => {
            setArchiving({ attachments: [preview.attachment.id] });
            setPreview(null);
          }}
        />
      ) : null}
      {archiving ? (
        <ArchiveDialog
          message={message}
          attachments={archiving.attachments}
          onClose={() => setArchiving(null)}
          onDone={(text) => {
            setArchiving(null);
            setNotice(text);
          }}
        />
      ) : null}
    </article>
  );
}

const TEXTUAL = /^(text\/(plain|markdown|csv)|application\/json)$/i;

function AttachmentPreview({
  attachment,
  link,
  onClose,
  onSave,
}: {
  attachment: Attachment;
  link: Link;
  onClose: () => void;
  onSave: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const type = attachment.contentType.toLowerCase();
  const textual = TEXTUAL.test(type) || /\.(txt|md|csv|log)$/i.test(attachment.filename);
  useEffect(() => {
    if (!textual) return;
    void fetch(link.url)
      .then((response) => response.text())
      .then((value) => setText(value.slice(0, 200_000)))
      .catch(() => setText(""));
  }, [link.url, textual]);
  let content: React.ReactNode;
  if (type === "application/pdf" || /\.pdf$/i.test(attachment.filename))
    content = (
      <div className="h-[70vh]">
        <PdfView url={link.url} title={attachment.filename} />
      </div>
    );
  else if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(type))
    content = (
      <img src={link.url} alt={attachment.filename} className="mx-auto max-h-[70vh] max-w-full" />
    );
  else if (type.startsWith("audio/"))
    content = <audio controls src={link.url} className="w-full" />;
  else if (type.startsWith("video/"))
    content = <video controls src={link.url} className="max-h-[70vh] w-full" />;
  else if (textual)
    content = (
      <pre className="max-h-[70vh] overflow-auto text-sm whitespace-pre-wrap">
        {text ?? t("Cargando…")}
      </pre>
    );
  else
    content = (
      <p className="text-sm text-muted">{t("Sin vista previa para este tipo de archivo.")}</p>
    );
  return (
    <Modal title={attachment.filename || t("Adjunto")} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        {content}
        <div className="flex gap-2">
          <a
            href={link.download}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-elevated"
          >
            <Download className="size-4" />
            {t("Descargar")}
          </a>
          <button
            type="button"
            onClick={onSave}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg"
          >
            <FileDown className="size-4" />
            {t("Guardar en Grafito")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

type Target = { key: string; label: string; shareId: string | null; portfolioId: string | null };

function ArchiveDialog({
  message,
  attachments,
  onClose,
  onDone,
}: {
  message: Detail;
  attachments: string[];
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [portfolios, setPortfolios] = useState<
    { id: string; name: string; parentId: string | null }[]
  >([]);
  const [shares, setShares] = useState<
    { id: string; title: string; access: string; workspace: boolean }[]
  >([]);
  const [target, setTarget] = useState("own:");
  const [newPortfolio, setNewPortfolio] = useState("");
  const [format, setFormat] = useState<"markdown" | "text" | "eml">("markdown");
  const [withAttachments, setWithAttachments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  // Asked to the server: this page does not keep the vault in sync.
  useEffect(() => {
    void mailArchiveTargets()
      .then((answer) => {
        setPortfolios(answer.portfolios);
        setShares(answer.shares);
      })
      .catch(() => undefined);
  }, []);
  const path = (id: string): string => {
    const item = portfolios.find((entry) => entry.id === id);
    if (!item) return "";
    return item.parentId ? `${path(item.parentId)} › ${item.name}` : item.name;
  };
  const targets: Target[] = [
    { key: "own:", label: t("Carpeta Personal"), shareId: null, portfolioId: null },
    ...portfolios
      .map((item) => ({
        key: `own:${item.id}`,
        label: path(item.id),
        shareId: null,
        portfolioId: item.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    ...shares.map((share) => ({
      key: `share:${share.id}`,
      label: `${share.title} (${share.workspace ? t("espacio de trabajo") : t("compartido")})`,
      shareId: share.id,
      portfolioId: null,
    })),
  ];
  const chosen = targets.find((item) => item.key === target) ?? targets[0]!;
  const ready = message.attachments.filter(
    (item) => !item.inline && item.status === "ready",
  ).length;
  const submit = async () => {
    setBusy(true);
    setError("");
    const answer = await mailArchive({
      data: {
        messageId: message.id,
        what: attachments.length ? "attachments" : "message",
        format,
        withAttachments,
        attachmentIds: attachments,
        target: {
          shareId: chosen.shareId,
          portfolioId: chosen.portfolioId,
          newPortfolio: !chosen.shareId && newPortfolio.trim() ? newPortfolio.trim() : undefined,
        },
      },
    }).catch(() => null);
    setBusy(false);
    if (!answer?.ok) {
      setError(answer?.error ?? "No se pudo archivar.");
      return;
    }
    if (answer.queued)
      onDone(t("El .eml se está guardando; aparecerá en la carpeta en unos segundos."));
    else {
      onDone(t("Guardado en Grafito ({0} documentos).", { 0: answer.saved }));
      if ("documentId" in answer && answer.documentId && !chosen.shareId) {
        useVault.getState().setActive(answer.documentId);
        void navigate({ to: "/" });
      }
    }
  };
  return (
    <Modal
      title={attachments.length ? t("Guardar adjunto en Grafito") : t("Archivar en Grafito")}
      onClose={onClose}
    >
      <form
        data-ui="mail-archive"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {t("Dónde")}
          <select
            aria-label={t("Dónde")}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="h-10 rounded-md border border-line bg-inset px-2"
          >
            {targets.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {!chosen.shareId ? (
          <label className="flex flex-col gap-1 text-sm">
            {t("En una carpeta nueva (opcional)")}
            <input
              value={newPortfolio}
              onChange={(event) => setNewPortfolio(event.target.value)}
              className="h-10 rounded-md border border-line bg-inset px-3"
            />
          </label>
        ) : null}
        {!attachments.length ? (
          <>
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1">{t("Formato")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={format === "markdown"}
                  onChange={() => setFormat("markdown")}
                />
                {t("Nota Markdown")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={format === "text"}
                  onChange={() => setFormat("text")}
                />
                {t("Texto plano (.txt)")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={format === "eml"} onChange={() => setFormat("eml")} />
                {t("Mensaje original (.eml)")}
              </label>
            </fieldset>
            {format !== "eml" && ready > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={withAttachments}
                  onChange={(event) => setWithAttachments(event.target.checked)}
                />
                {t("Guardar también los {0} adjuntos ya descargados", { 0: ready })}
              </label>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {t(error)}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="h-10 self-start rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy ? t("Guardando…") : t("Guardar")}
        </button>
      </form>
    </Modal>
  );
}
