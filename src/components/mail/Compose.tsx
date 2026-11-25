import { ChevronRight, FileText, Folder, Paperclip, Send, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { mailAttachChoices, mailSend } from "@/server/mailbox.functions";

/**
 * Writing a message: from one of the person's accounts, to people, with documents taken straight
 * from the vault (Carpeta Personal or what is shared with them). Nothing is uploaded from the
 * computer; the server reads the chosen documents and checks the person may take them out.
 */

export type Draft = {
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  replyTo: string | null;
};

type Account = { id: string; email: string; name: string; hasSecret: boolean };

export type Picked = {
  docId: string;
  shareId: string | null;
  title: string;
  kind: "markdown" | "file";
};

const field = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

function split(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function Compose({
  draft,
  accounts,
  onClose,
  onSent,
}: {
  draft: Draft;
  accounts: Account[];
  onClose: () => void;
  onSent: (sentCopy: boolean) => void;
}) {
  const usable = accounts.filter((account) => account.hasSecret);
  const [form, setForm] = useState({
    ...draft,
    accountId: usable.some((item) => item.id === draft.accountId)
      ? draft.accountId
      : (usable[0]?.id ?? ""),
    bcc: "",
  });
  const [copies, setCopies] = useState(Boolean(draft.cc));
  const [files, setFiles] = useState<Picked[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    setBusy(true);
    setError("");
    const answer = await mailSend({
      data: {
        accountId: form.accountId,
        to: split(form.to),
        cc: split(form.cc),
        bcc: split(form.bcc),
        subject: form.subject,
        text: form.text,
        attachments: files.map((file) => ({ docId: file.docId, shareId: file.shareId })),
        replyTo: form.replyTo,
      },
    }).catch(() => null);
    setBusy(false);
    if (answer?.ok) onSent(answer.sentCopy);
    else setError(answer?.error ?? "No se pudo enviar.");
  };

  return (
    <Modal title={t("Nuevo mensaje")} onClose={onClose} wide keepOpen>
      <form
        data-ui="mail-compose"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {t("De")}
          <select
            aria-label={t("De")}
            value={form.accountId}
            onChange={(event) => setForm({ ...form, accountId: event.target.value })}
            className={field}
          >
            {usable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name === account.email
                  ? account.email
                  : `${account.name} <${account.email}>`}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            {t("Para")}
            <input
              required
              aria-label={t("Para")}
              value={form.to}
              autoComplete="email"
              onChange={(event) => setForm({ ...form, to: event.target.value })}
              className={field}
            />
          </label>
          {!copies ? (
            <button
              type="button"
              onClick={() => setCopies(true)}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm hover:bg-elevated"
            >
              <Users className="size-4" />
              {t("CC y CCO")}
            </button>
          ) : null}
        </div>
        {copies ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              {t("CC")}
              <input
                aria-label={t("CC")}
                value={form.cc}
                onChange={(event) => setForm({ ...form, cc: event.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("CCO")}
              <input
                aria-label={t("CCO")}
                value={form.bcc}
                onChange={(event) => setForm({ ...form, bcc: event.target.value })}
                className={field}
              />
            </label>
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
        <textarea
          aria-label={t("Mensaje")}
          value={form.text}
          onChange={(event) => setForm({ ...form, text: event.target.value })}
          rows={12}
          className="min-h-48 w-full rounded-md border border-line bg-inset p-3 text-sm leading-relaxed"
        />
        <div data-ui="mail-compose-files" className="flex flex-wrap items-center gap-2">
          {files.map((file) => (
            <span
              key={`${file.shareId ?? ""}:${file.docId}`}
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
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 text-sm text-muted hover:bg-elevated"
          >
            <Paperclip className="size-4" />
            {t("Adjuntar desde Grafito")}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {t(error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line px-3 text-sm hover:bg-elevated"
          >
            {t("Descartar")}
          </button>
          <button
            type="submit"
            disabled={busy || !form.accountId}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            <Send className="size-4" />
            {busy ? t("Enviando…") : t("Enviar")}
          </button>
        </div>
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
    </Modal>
  );
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
