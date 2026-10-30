import { useEffect, useState } from "react";
import { fetchSharedTree } from "@/app/shared-open";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { answerSignature, askSignatures, myPendingSignatures, signaturePeople, signatureState } from "@/server/signature.functions";

/**
 * Pedir firmas y ver quién confirmó cada versión. No es un certificado: queda
 * la persona, el momento y si el documento cambió después.
 */

type Row = {
  id: string;
  signerName: string;
  status: string;
  requestedByName: string;
  requestedAt: number;
  decidedAt: number | null;
  note: string;
  stale: boolean;
  mine: boolean;
};

export function SignatureDialog({ docId, shareId, onClose }: { docId: string; shareId?: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [people, setPeople] = useState<{ id: string; name: string; loginName: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    void signatureState({ data: { docId, shareId } })
      .then((result) => {
        setRows(result.rows);
        setCanRequest(result.canRequest);
      })
      .catch(() => setError(t("No se pudieron leer las firmas.")));
  };

  useEffect(() => {
    load();
    void signaturePeople({ data: { docId, shareId } })
      .then(setPeople)
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shareId]);

  const ask = async () => {
    if (picked.size === 0) {
      setError(t("Elige al menos una persona."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await askSignatures({ data: { docId, shareId, userIds: [...picked] } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPicked(new Set());
      if (result.blocked.length > 0) {
        setError(t("Comparte el documento con {0} antes de pedirle la firma.", { 0: result.blocked.join(", ") }));
      }
      load();
    } catch {
      setError(t("No se pudieron pedir las firmas."));
    } finally {
      setBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (people ?? []).filter(
    (person) => !needle || person.name.toLowerCase().includes(needle) || person.loginName.toLowerCase().includes(needle),
  );

  return (
    <Modal title={t("Firmas")} onClose={onClose}>
      <p className="text-sm text-muted">{t("Queda quién confirmó esta versión y cuándo. No es un certificado.")}</p>
      <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
        {rows === null ? <li className="text-sm text-muted">{t("Cargando…")}</li> : null}
        {rows && rows.length === 0 ? <li className="text-sm text-muted">{t("Nadie ha firmado todavía.")}</li> : null}
        {rows?.map((row) => (
          <li key={row.id} className="rounded-md border border-line px-3 py-2 text-sm">
            <span className="font-medium">{row.signerName}</span>
            <span className="text-muted">{" · "}{statusLabel(row.status, row.stale)}</span>
            <span className="mt-0.5 block text-xs text-faint">
              {t("Pedida por {0}", { 0: row.requestedByName })}
              {" · "}
              {formatWhen(row.decidedAt ?? row.requestedAt)}
            </span>
            {row.note ? <span className="mt-1 block text-xs text-muted">{row.note}</span> : null}
          </li>
        ))}
      </ul>
      {canRequest ? (
        <div className="mt-4">
          <SearchField value={query} onChange={setQuery} placeholder={t("Buscar persona")} />
          <ul className="mt-2 max-h-40 overflow-y-auto rounded-md border border-line">
            {people === null ? <li className="px-3 py-3 text-sm text-muted">{t("Cargando…")}</li> : null}
            {people && shown.length === 0 ? <li className="px-3 py-3 text-sm text-muted">{t("Ningún usuario coincide.")}</li> : null}
            {shown.map((person) => {
              const on = picked.has(person.id);
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() =>
                      setPicked((current) => {
                        const next = new Set(current);
                        if (next.has(person.id)) next.delete(person.id);
                        else next.add(person.id);
                        return next;
                      })
                    }
                    className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-elevated"
                  >
                    <span className={`grid size-4 place-items-center rounded border ${on ? "border-accent bg-accent text-accent-fg" : "border-line"}`}>
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    {person.loginName ? <span className="shrink-0 text-xs text-faint">{person.loginName}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-danger">{t(error)}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg">
          {t("Cerrar")}
        </button>
        {canRequest ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void ask()}
            className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
          >
            {busy ? t("Guardando…") : t("Pedir firmas")}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

/** Aviso en la nota o el archivo abierto, y los botones de firmar o rechazar. */
export function SignatureBar({ docId, shareId }: { docId: string; shareId?: string }) {
  const setDialog = useVault((state) => state.setDialog);
  const [rows, setRows] = useState<Row | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    void signatureState({ data: { docId, shareId } })
      .then((result) => {
        if (result.ok) {
          setRows(result.rows);
          setCanRequest(result.canRequest);
        }
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shareId]);

  const mine = rows?.find((row) => row.mine && row.status === "pending");
  const signed = rows?.filter((row) => row.status === "signed").length ?? 0;
  const pending = rows?.filter((row) => row.status === "pending").length ?? 0;
  if (!rows || (rows.length === 0 && !canRequest)) return null;

  const answer = async (status: "signed" | "declined") => {
    if (!mine) return;
    setBusy(true);
    setError("");
    try {
      const result = await answerSignature({ data: { id: mine.id, status } });
      if (!result.ok) setError(result.error);
      else load();
    } catch {
      setError(t("No se pudo registrar la firma."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm sm:px-5">
      <button
        type="button"
        onClick={() => setDialog({ type: "signatures", docId, shareId })}
        className="font-medium text-fg hover:text-accent"
      >
        {t("Firmas")}
      </button>
      <span className="text-muted">
        {signed > 0 ? t("{n} firmadas", { n: signed }) : t("Sin firmas")}
        {pending > 0 ? ` · ${t("{n} pendientes", { n: pending })}` : ""}
      </span>
      {mine ? (
        <>
          <span className="text-muted">{t("{0} te pidió firmar", { 0: mine.requestedByName })}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer("signed")}
            className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-60"
          >
            {t("Firmar")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer("declined")}
            className="h-8 rounded-md px-3 text-xs text-muted hover:bg-elevated hover:text-fg disabled:opacity-60"
          >
            {t("Rechazar")}
          </button>
        </>
      ) : null}
      {canRequest && !mine ? (
        <button
          type="button"
          onClick={() => setDialog({ type: "signatures", docId, shareId })}
          className="h-8 rounded-md px-2 text-xs text-muted hover:bg-elevated hover:text-fg"
        >
          {t("Pedir firmas…")}
        </button>
      ) : null}
      {error ? <span className="text-danger">{t(error)}</span> : null}
    </div>
  );
}

/** En la Carpeta Personal: documentos que te pidieron firmar. */
export function PendingSignatures({ onOpenNote }: { onOpenNote: (id: string) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof myPendingSignatures>>>([]);
  useEffect(() => {
    void myPendingSignatures()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  if (items.length === 0) return null;
  const open = async (item: (typeof items)[number]) => {
    if (!item.shareId) {
      onOpenNote(item.docId);
      return;
    }
    const tree = await fetchSharedTree(item.shareId).catch(() => null);
    if (tree) useSharedView.getState().openShared(tree, item.docId);
  };
  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{t("Firmas pendientes")}</h2>
      <ul className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
        {items.map((item) => (
          <li key={item.id} className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => void open(item)} className="flex min-h-12 w-full items-center gap-3 px-4 text-left hover:bg-elevated">
              <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
              <span className="shrink-0 text-xs text-faint">{t("{0} te pidió firmar", { 0: item.requester })}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function statusLabel(status: string, stale: boolean): string {
  if (status === "signed") return stale ? t("Firmada · el documento cambió después") : t("Firmada");
  if (status === "declined") return t("Rechazada");
  return t("Pendiente");
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
