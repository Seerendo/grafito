import { uuid } from "@/lib/uuid";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderInput,
  HardDriveUpload,
  Loader2,
  Paperclip,
  Send,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useAccountProfile } from "@/app/account-profile";
import { uploadVaultFile } from "@/app/files";
import { intl, t } from "@/app/i18n";
import { usePermissions } from "@/app/permissions";
import { Modal } from "@/components/ui/Modal";
import { swapSignature, withSignature } from "@/domain/mail/compose";
import { QuotedOriginal } from "./Quoted";
import { readSaveTo, useSaveFolders, writeSaveTo } from "@/app/mail/save-to";
import { PERMISSION } from "@/domain/permissions";
import {
  mailAttachChoices,
  mailDiscardUploads,
  mailRecipients,
  mailSaveDraft,
  mailSend,
} from "@/server/mailbox.functions";

/**
 * Writing a message: from one of the person's accounts, to people found by name (contacts and the
 * server's directory), with the account's signature, and with documents taken straight from the
 * vault (Carpeta Personal or what is shared) or dropped from the computer. A dropped file is
 * either only attached, or attached and kept in the vault where the person chooses, like
 * Outlook asks. Uploads take the vault's own path (limits, antivirus).
 */

export type Draft = {
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  replyTo: string | null;
  /** The message answered or forwarded: shown below the text and sent after it. */
  quote?: { messageId: string; kind: "reply" | "forward" } | null;
};

type Account = { id: string; email: string; name: string; hasSecret: boolean; signature: string };

export type Picked = {
  docId: string;
  shareId: string | null;
  title: string;
  kind: "markdown" | "file";
};

/** A file from the computer on its way: only attached (key) or kept in the vault (doc). */
type Upload = {
  id: string;
  name: string;
  mime: string;
  status: "uploading" | "ready" | "failed";
  key?: string;
  error?: string;
};

const field = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

function split(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The message being written, in its own tab of the reading pane (like Outlook). It lives only in
 * this tab until it is sent or kept as a draft: closing a tab with changes asks «¿Desea guardarlo
 * como borrador?»; «No» throws away everything, the files uploaded for it included.
 */
export function Compose({
  draft,
  accounts,
  closing,
  onCancelClose,
  onClosed,
  onSent,
  onTitle,
}: {
  draft: Draft;
  accounts: Account[];
  /** The tab's close button was pressed. */
  closing: boolean;
  onCancelClose: () => void;
  /** The tab may go: sent, kept as a draft, or thrown away. */
  onClosed: (outcome: "discarded" | "draft") => void;
  onSent: (sentCopy: boolean) => void;
  onTitle: (title: string) => void;
}) {
  const usable = accounts.filter((account) => account.hasSecret);
  const first = usable.some((item) => item.id === draft.accountId)
    ? draft.accountId
    : (usable[0]?.id ?? "");
  const signatureOf = (id: string) => usable.find((item) => item.id === id)?.signature ?? "";
  const [form, setForm] = useState(() => ({
    ...draft,
    accountId: first,
    text: withSignature(draft.text, signatureOf(first)),
    bcc: "",
  }));
  const [copies, setCopies] = useState(Boolean(draft.cc));
  const [fromShown, setFromShown] = useState(false);
  const [files, setFiles] = useState<Picked[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [zone, setZone] = useState<"save" | "attach" | null>(null);
  const saveFolders = useSaveFolders();
  const [saveTo, setSaveTo] = useState(readSaveTo);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chooser = useRef<HTMLInputElement>(null);
  const can = usePermissions();
  const profile = useAccountProfile();
  const mayUpload = can(PERMISSION.filesUpload);

  const changeAccount = (accountId: string) =>
    setForm({
      ...form,
      accountId,
      text: swapSignature(form.text, signatureOf(form.accountId), signatureOf(accountId)),
    });

  const initial = useRef({ ...form });
  const dirty =
    files.length > 0 ||
    uploads.length > 0 ||
    (["to", "cc", "bcc", "subject", "text"] as const).some(
      (name) => form[name] !== initial.current[name],
    );

  useEffect(() => onTitle(form.subject), [form.subject, onTitle]);

  // Leaving the page with a message being written asks the browser to confirm.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const discard = () => {
    const keys = uploads.flatMap((item) => (item.key ? [item.key] : []));
    if (keys.length) void mailDiscardUploads({ data: { keys } }).catch(() => undefined);
    onClosed("discarded");
  };

  // Closing without changes needs no question.
  useEffect(() => {
    if (closing && !dirty) discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  const attach = (list: File[], save: { portfolioId: string | null } | null) => {
    for (const file of list) {
      const id = uuid();
      const entry: Upload = {
        id,
        name: file.name,
        mime: file.type || "application/octet-stream",
        status: "uploading",
      };
      setUploads((current) => [...current, entry]);
      const done = (change: Partial<Upload>) =>
        setUploads((current) =>
          current.map((item) => (item.id === id ? { ...item, ...change } : item)),
        );
      const work = save
        ? uploadVaultFile(
            file,
            { portfolioId: save.portfolioId },
            {
              doc: {
                id: uuid(),
                title: file.name.replace(/\.[^.]+$/, "") || file.name,
                name: file.name,
                mime: entry.mime,
                createdAt: Date.now(),
                actor: profile?.displayName || profile?.loginName || "",
              },
            },
          ).then((stored) => {
            if (!stored.doc) throw new Error(t("El servidor no guardó el documento del archivo."));
            // Kept in the vault: it goes out as a vault document.
            setUploads((current) => current.filter((item) => item.id !== id));
            setFiles((current) => [
              ...current,
              { docId: stored.doc!.id, shareId: null, title: stored.doc!.title, kind: "file" },
            ]);
          })
        : uploadVaultFile(file, {}).then((stored) => done({ status: "ready", key: stored.key }));
      work.catch((failure: unknown) =>
        done({
          status: "failed",
          error: failure instanceof Error ? failure.message : t("No se pudo subir."),
        }),
      );
    }
  };

  // Like Outlook: while files are dragged over the message, its body becomes two places to drop
  // them, «keep in Grafito and attach» or «attach»; a drop anywhere else only attaches.
  const dragging = (event: DragEvent) => mayUpload && event.dataTransfer.types.includes("Files");
  const dropInto = (event: DragEvent, save: boolean) => {
    if (!dragging(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    setZone(null);
    void droppedFiles(event.dataTransfer).then((list) => {
      if (list.length) attach(list, save ? { portfolioId: saveTo || null } : null);
    });
  };

  const pending = uploads.some((item) => item.status === "uploading");

  const payload = () => ({
    accountId: form.accountId,
    to: split(form.to),
    cc: split(form.cc),
    bcc: split(form.bcc),
    subject: form.subject,
    text: form.text,
    attachments: files.map((file) => ({ docId: file.docId, shareId: file.shareId })),
    uploads: uploads.flatMap((item) =>
      item.status === "ready" && item.key
        ? [{ key: item.key, name: item.name, mime: item.mime }]
        : [],
    ),
    replyTo: form.replyTo,
    quote: draft.quote ?? null,
  });

  const keepDraft = async () => {
    setBusy(true);
    setError("");
    const answer = await mailSaveDraft({ data: payload() }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onClosed("draft");
    else {
      onCancelClose();
      setError(answer?.error ?? "No se pudo guardar el borrador.");
    }
  };

  const send = async () => {
    setBusy(true);
    setError("");
    const answer = await mailSend({ data: payload() }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSent(answer.sentCopy);
    else setError(answer?.error ?? "No se pudo enviar.");
  };

  return (
    <div data-ui="mail-compose-pane" className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
      {closing && dirty ? (
        <div
          role="alertdialog"
          data-ui="mail-close-draft"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent bg-accent/10 p-3 text-sm"
        >
          <span className="min-w-0 flex-1 font-medium">{t("¿Desea guardarlo como borrador?")}</span>
          <button
            type="button"
            disabled={busy || pending}
            onClick={() => void keepDraft()}
            className="h-9 rounded-md bg-accent px-3 font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? t("Guardando…") : t("Sí")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={discard}
            className="h-9 rounded-md border border-line px-3 hover:bg-elevated"
          >
            {t("No")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancelClose}
            className="h-9 rounded-md px-3 text-muted hover:bg-elevated"
          >
            {t("Cancelar")}
          </button>
        </div>
      ) : null}
      <form
        data-ui="mail-compose"
        className="flex flex-col gap-3"
        onDragOver={(event) => {
          if (!dragging(event)) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) {
            setOver(false);
            setZone(null);
          }
        }}
        onDrop={(event) => dropInto(event, false)}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {/* Send and discard stay on top while the message scrolls (as in Outlook). */}
        <div
          data-ui="mail-compose-bar"
          className="sticky -top-3 z-10 -mx-3 -mt-3 flex flex-wrap items-center gap-2 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur sm:-top-4 sm:-mx-4 sm:-mt-4 sm:px-4"
        >
          <button
            type="submit"
            disabled={busy || pending || !form.accountId}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            <Send className="size-4" />
            {busy ? t("Enviando…") : t("Enviar")}
          </button>
          <button
            type="button"
            onClick={discard}
            className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated"
          >
            {t("Descartar")}
          </button>
        </div>
        <label
          className="flex flex-col gap-1 text-sm"
          onDoubleClick={() => setFromShown((value) => !value)}
        >
          {t("De")}
          <select
            aria-label={t("De")}
            value={form.accountId}
            onChange={(event) => changeAccount(event.target.value)}
            className={field}
          >
            {usable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name || account.email}
              </option>
            ))}
          </select>
          {fromShown ? (
            <span data-ui="from-address" className="px-1 text-xs text-faint">
              {usable.find((account) => account.id === form.accountId)?.email}
            </span>
          ) : null}
        </label>
        <div className="flex items-end gap-2">
          <Recipients
            label="Para"
            required
            value={form.to}
            onChange={(to) => setForm((current) => ({ ...current, to }))}
          />
          <button
            type="button"
            aria-expanded={copies}
            onClick={() => setCopies(!copies)}
            className={`inline-flex h-10 shrink-0 items-center gap-1.5 self-end rounded-md border px-3 text-sm hover:bg-elevated ${copies ? "border-accent/60 bg-accent/10" : "border-line"}`}
          >
            <Users className="size-4" />
            {t("CC y CCO")}
            {!copies && split(form.cc).length + split(form.bcc).length ? (
              <span className="rounded bg-accent/20 px-1 text-xs">
                {split(form.cc).length + split(form.bcc).length}
              </span>
            ) : null}
            <ChevronDown
              className={`size-3.5 transition-transform ${copies ? "rotate-180" : ""}`}
            />
          </button>
        </div>
        {copies ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Recipients
              label="CC"
              value={form.cc}
              onChange={(cc) => setForm((current) => ({ ...current, cc }))}
            />
            <Recipients
              label="CCO"
              value={form.bcc}
              onChange={(bcc) => setForm((current) => ({ ...current, bcc }))}
            />
          </div>
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          {t("Asunto")}
          <input
            aria-label={t("Asunto")}
            value={form.subject}
            onChange={(event) => setForm({ ...form, subject: event.target.value })}
            className={field}
          />
        </label>
        {files.length || uploads.length ? (
          <div className="flex flex-col gap-1 text-sm">
            {t("Adjuntos")}
            <div
              data-ui="mail-compose-files"
              className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-inset/40 p-2"
            >
              {files.map((file) => (
                <span
                  key={`${file.shareId ?? ""}:${file.docId}`}
                  data-attachment={file.title}
                  className="inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md border border-line bg-inset pr-1 pl-2 text-xs"
                >
                  <Paperclip className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{file.title}</span>
                  <button
                    type="button"
                    aria-label={t("Quitar {0}", { 0: file.title })}
                    onClick={() => setFiles(files.filter((item) => item !== file))}
                    className="grid size-6 place-items-center rounded text-faint hover:bg-elevated hover:text-fg"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
              {uploads.map((item) => (
                <span
                  key={item.id}
                  data-attachment={item.name}
                  data-status={item.status}
                  data-key={item.key}
                  title={item.error ? t(item.error) : undefined}
                  className={`inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md border bg-inset pr-1 pl-2 text-xs ${item.status === "failed" ? "border-danger text-danger" : "border-line"}`}
                >
                  {item.status === "uploading" ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" />
                  ) : (
                    <HardDriveUpload className="size-3.5 shrink-0 text-faint" />
                  )}
                  <span className="truncate">{item.name}</span>
                  <button
                    type="button"
                    aria-label={t("Quitar {0}", { 0: item.name })}
                    disabled={item.status === "uploading"}
                    onClick={() => {
                      if (item.key)
                        void mailDiscardUploads({ data: { keys: [item.key] } }).catch(
                          () => undefined,
                        );
                      setUploads(uploads.filter((entry) => entry.id !== item.id));
                    }}
                    className="grid size-6 place-items-center rounded text-faint hover:bg-elevated hover:text-fg disabled:opacity-40"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="relative">
          <textarea
            aria-label={t("Mensaje")}
            value={form.text}
            onChange={(event) => setForm({ ...form, text: event.target.value })}
            rows={12}
            className="min-h-48 w-full rounded-md border border-line bg-inset p-3 text-sm leading-relaxed"
          />
          {over ? (
            <div
              data-ui="mail-drop-zones"
              className="absolute inset-0 grid grid-cols-2 gap-3 rounded-md bg-surface p-3"
            >
              {(
                [
                  {
                    id: "save",
                    icon: <FolderInput className="size-10" />,
                    label: t("Guardar en Grafito y adjuntar"),
                    detail:
                      saveFolders.find((item) => item.id === saveTo)?.path ?? t("Carpeta Personal"),
                  },
                  {
                    id: "attach",
                    icon: <Paperclip className="size-10" />,
                    label: t("Adjuntar archivos"),
                    detail: "",
                  },
                ] as const
              ).map((item) => (
                <div
                  key={item.id}
                  data-ui={`mail-drop-${item.id}`}
                  onDragOver={(event) => {
                    if (!dragging(event)) return;
                    event.preventDefault();
                    setZone(item.id);
                  }}
                  onDrop={(event) => dropInto(event, item.id === "save")}
                  className={`flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 text-center text-sm transition-colors ${zone === item.id ? "border-accent bg-accent/10 text-fg" : "border-line text-muted"}`}
                >
                  {item.icon}
                  <span className="font-medium">{item.label}</span>
                  {item.detail ? <span className="text-xs text-faint">{item.detail}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {draft.quote ? (
          <QuotedOriginal messageId={draft.quote.messageId} kind={draft.quote.kind} />
        ) : null}
        <div data-ui="mail-compose-tools" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 text-sm text-muted hover:bg-elevated"
          >
            <Paperclip className="size-4" />
            {t("Adjuntar desde Grafito")}
          </button>
          {mayUpload ? (
            <>
              <button
                type="button"
                onClick={() => chooser.current?.click()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 text-sm text-muted hover:bg-elevated"
              >
                <HardDriveUpload className="size-4" />
                {t("Desde el equipo")}
              </button>
              <input
                ref={chooser}
                type="file"
                multiple
                hidden
                aria-label={t("Desde el equipo")}
                onChange={(event) => {
                  const list = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (list.length) attach(list, null);
                }}
              />
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                {t("Guardar en")}
                <select
                  aria-label={t("Guardar en")}
                  value={saveTo}
                  onChange={(event) => {
                    setSaveTo(event.target.value);
                    writeSaveTo(event.target.value);
                  }}
                  className="h-8 max-w-56 rounded-md border border-line bg-inset px-2 text-xs"
                >
                  <option value="">{t("Carpeta Personal")}</option>
                  {saveFolders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.path}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {t(error)}
          </p>
        ) : null}
      </form>
      {picking ? (
        <VaultPicker
          chosen={files}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setFiles(picked);
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** «Name <address>» or a bare address, as written in a recipients field. */
function person(entry: string): { name: string; address: string } {
  const match = /^(.*?)<([^<>]+)>\s*$/.exec(entry.trim());
  if (match) return { name: match[1]!.trim().replace(/^"|"$/g, ""), address: match[2]!.trim() };
  return { name: "", address: entry.trim() };
}

/**
 * People separated by commas. Each one chosen shows as a chip with the full name; its address
 * stays hidden and shows below the name on a double click. While typing, suggestions by name
 * (contacts and the server's directory). The value is kept as «Name <address>, …».
 */
export function Recipients({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [people, setPeople] = useState<{ name: string; address: string; source: string }[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const parts = value.split(/[,;]/);
  const typed = parts.at(-1) ?? "";
  const chips = parts
    .slice(0, -1)
    .map((item) => item.trim())
    .filter(Boolean);
  const write = (list: string[], text: string) =>
    onChange(list.length ? `${list.join(", ")}, ${text}` : text);

  useEffect(() => {
    const term = typed.trim();
    if (term.length < 2 || /<.+>/.test(term)) {
      setPeople([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(
      () =>
        void mailRecipients({ data: { query: term } })
          .then((answer) => {
            if (!alive) return;
            setPeople(answer.people);
            setActive(0);
          })
          .catch(() => undefined),
      200,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [typed]);

  const choose = (chosen: { name: string; address: string }) => {
    const entry = chosen.name
      ? `${chosen.name.replace(/[<>,;"]/g, "")} <${chosen.address}>`
      : chosen.address;
    write([...chips, entry], "");
    setPeople([]);
  };
  const listing = open && people.length > 0;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col gap-1 text-sm">
      <span>{t(label)}</span>
      <div
        data-recipients={label}
        data-value={value}
        className="flex min-h-10 flex-wrap items-center gap-1 rounded-md border border-line bg-inset px-1.5 py-1"
      >
        {chips.map((entry, index) => {
          const one = person(entry);
          const key = `${index}:${one.address}`;
          return (
            <span
              key={key}
              data-ui="recipient"
              onDoubleClick={() => setShown(shown === key ? null : key)}
              className="inline-flex max-w-64 cursor-default items-start gap-1 rounded-md border border-line bg-surface py-0.5 pr-0.5 pl-2 text-xs select-none"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{one.name || one.address}</span>
                {shown === key && one.name ? (
                  <span data-ui="recipient-address" className="truncate text-faint">
                    {one.address}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                aria-label={t("Quitar {0}", { 0: one.name || one.address })}
                onClick={() =>
                  write(
                    chips.filter((_, other) => other !== index),
                    typed.trim(),
                  )
                }
                className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-elevated hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          required={required && chips.length === 0}
          aria-label={t(label)}
          aria-expanded={listing}
          aria-autocomplete="list"
          role="combobox"
          value={typed.trimStart()}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setTimeout(() => setOpen(false), 150);
            // A full address left typed becomes a chip.
            if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(typed.trim()))
              write([...chips, typed.trim()], "");
          }}
          onChange={(event) => {
            setOpen(true);
            write(chips, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !typed && chips.length) {
              event.preventDefault();
              write(chips.slice(0, -1), "");
              return;
            }
            if (listing) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, people.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                const chosen = people[active];
                if (chosen) {
                  event.preventDefault();
                  choose(chosen);
                }
                return;
              }
              if (event.key === "Escape") {
                setPeople([]);
                return;
              }
            }
            if (event.key === "Enter" && typed.trim()) {
              event.preventDefault();
              write([...chips, typed.trim()], "");
            }
          }}
          className="h-8 min-w-32 flex-1 bg-transparent px-1.5 text-sm outline-none"
        />
      </div>
      {listing ? (
        <ul
          role="listbox"
          data-ui="mail-recipients"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-2xl"
        >
          {people.map((item, index) => (
            <li
              key={item.address}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 ${index === active ? "bg-elevated" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">
                {item.name ? <span className="font-medium">{item.name} </span> : null}
                <span className="text-muted">{item.address}</span>
              </span>
              <span className="text-xs text-faint">
                {t(item.source === "directorio" ? "Directorio" : "Contactos")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const MAX_DROPPED = 50;

/**
 * The files of a drop; a dropped folder gives the files inside it (and its subfolders). The
 * entries are taken at once, as the browser empties the drop after the event.
 */
async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const plain = [...data.files];
  const entries = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (out.length >= MAX_DROPPED) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) out.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child);
    }
  };
  for (let index = 0; index < Math.max(plain.length, entries.length); index += 1) {
    const entry = entries[index];
    if (entry?.isDirectory) await walk(entry);
    else if (plain[index] && out.length < MAX_DROPPED) out.push(plain[index]!);
  }
  return out;
}

type Choices = Extract<Awaited<ReturnType<typeof mailAttachChoices>>, { ok: true }>;

/** Browse the Carpeta Personal and what is shared, or search, and tick documents. */
function VaultPicker({
  chosen,
  onClose,
  onPick,
}: {
  chosen: Picked[];
  onClose: () => void;
  onPick: (picked: Picked[]) => void;
}) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState<string | null>(null);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Picked[]>(chosen);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(
      () =>
        void mailAttachChoices({ data: { query } })
          .then((answer) => {
            if (!alive) return;
            if (answer.ok) setChoices(answer);
            else setError(answer.error);
          })
          .catch(() => alive && setError("No se pudo leer la bóveda.")),
      query ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const folder = path.at(-1)?.id ?? null;
  const listing = useMemo(() => {
    if (!choices) return { folders: [], docs: [] };
    if (query.trim()) return { folders: [], docs: choices.docs };
    const here = choices.folders.filter((item) => item.shareId === place);
    const known = new Set(here.map((item) => item.id));
    const inside = (parent: string | null) =>
      folder === null ? parent === null || !known.has(parent) : parent === folder;
    return {
      folders: here
        .filter((item) => inside(item.parentId))
        .sort((a, b) => a.name.localeCompare(b.name, intl())),
      docs: choices.docs
        .filter((item) => item.shareId === place && inside(item.portfolioId))
        .sort((a, b) => a.title.localeCompare(b.title, intl())),
    };
  }, [choices, query, place, folder]);

  const key = (item: { docId?: string; id?: string; shareId: string | null }) =>
    `${item.shareId ?? ""}:${item.docId ?? item.id}`;
  const isPicked = (item: Choices["docs"][number]) =>
    picked.some((entry) => key(entry) === key(item));
  const toggle = (item: Choices["docs"][number]) =>
    setPicked(
      isPicked(item)
        ? picked.filter((entry) => key(entry) !== key(item))
        : [
            ...picked,
            { docId: item.id, shareId: item.shareId, title: item.title, kind: item.kind },
          ],
    );
  const placeLabel = (shareId: string | null) =>
    choices?.places.find((item) => item.shareId === shareId)?.label ?? "";

  return (
    <Modal title={t("Adjuntar desde Grafito")} onClose={onClose} wide>
      <div data-ui="mail-vault-picker" className="flex flex-col gap-3">
        <input
          type="search"
          aria-label={t("Buscar en Grafito")}
          placeholder={t("Buscar en Grafito")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={field}
        />
        {!query.trim() && choices ? (
          <div className="flex flex-wrap gap-2">
            {choices.places.map((item) => (
              <button
                key={item.shareId ?? "own"}
                type="button"
                aria-pressed={item.shareId === place}
                onClick={() => {
                  setPlace(item.shareId);
                  setPath([]);
                }}
                className={`h-8 rounded-md border px-2.5 text-sm ${item.shareId === place ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:bg-elevated"}`}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        ) : null}
        {!query.trim() && path.length ? (
          <nav className="flex flex-wrap items-center gap-1 text-sm text-muted">
            <button type="button" onClick={() => setPath([])} className="hover:text-fg">
              {t(placeLabel(place))}
            </button>
            {path.map((step, index) => (
              <span key={step.id} className="inline-flex items-center gap-1">
                <ChevronRight className="size-3.5" />
                <button
                  type="button"
                  onClick={() => setPath(path.slice(0, index + 1))}
                  className="hover:text-fg"
                >
                  {step.name}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
        <div className="max-h-[45vh] min-h-48 overflow-y-auto rounded-md border border-line">
          {error ? <p className="p-4 text-sm text-danger">{t(error)}</p> : null}
          {!choices && !error ? <p className="p-4 text-sm text-faint">{t("Cargando…")}</p> : null}
          {listing.folders.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPath([...path, { id: item.id, name: item.name }])}
              className="flex h-10 w-full items-center gap-2 border-b border-line px-3 text-left text-sm hover:bg-elevated"
            >
              <Folder className="size-4 shrink-0 text-faint" />
              <span className="truncate">{item.name}</span>
            </button>
          ))}
          {listing.docs.map((item) => (
            <label
              key={key(item)}
              data-doc={item.title}
              className="flex h-10 cursor-pointer items-center gap-2 border-b border-line px-3 text-sm hover:bg-elevated"
            >
              <input
                type="checkbox"
                checked={isPicked(item)}
                onChange={() => toggle(item)}
                className="size-4 accent-[var(--color-accent)]"
              />
              {item.kind === "file" ? (
                <Paperclip className="size-4 shrink-0 text-faint" />
              ) : (
                <FileText className="size-4 shrink-0 text-faint" />
              )}
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {query.trim() ? (
                <span className="truncate text-xs text-faint">{t(placeLabel(item.shareId))}</span>
              ) : null}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated"
          >
            {t("Cancelar")}
          </button>
          <button
            type="button"
            onClick={() => onPick(picked)}
            className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
          >
            {picked.length ? t("Adjuntar ({0})", { 0: picked.length }) : t("Listo")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
