import { useEffect, useState } from "react";
import { fetchSharedTree } from "@/app/shared-open";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { myPendingSignatures, signatureState } from "@/server/signature.functions";

/**
 * Quién tiene un recuadro en el PDF y si ya estampó su firma. La imagen no se
 * guarda. No es un certificado.
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
  page: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
};

export function SignatureDialog({ docId, shareId, onClose }: { docId: string; shareId?: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canRequest, setCanRequest] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void signatureState({ data: { docId, shareId } })
      .then((result) => {
        setRows(result.rows);
        setCanRequest(result.canRequest);
      })
      .catch(() => setError(t("No se pudieron leer las firmas.")));
  }, [docId, shareId]);

  return (
    <Modal title={t("Firmas")} onClose={onClose}>
      <p className="text-sm text-muted">{t("La imagen se usa una sola vez para estampar el PDF y no se guarda. No es un certificado.")}</p>
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
              {row.page ? ` · ${t("Página {n}", { n: row.page })}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {canRequest ? <p className="mt-3 text-sm text-muted">{t("Dibuja el recuadro en la página. Luego elige a quién corresponde.")}</p> : null}
      {error ? <p className="mt-3 text-sm text-danger">{t(error)}</p> : null}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg">
          {t("Cerrar")}
        </button>
      </div>
    </Modal>
  );
}

/** En el PDF: quién firmó y, si puedes editarlo, el botón para marcar un recuadro. */
export function SignatureBar({
  docId,
  shareId,
  version = 0,
  placing = false,
  onPlace,
  onState,
}: {
  docId: string;
  shareId?: string;
  version?: number;
  placing?: boolean;
  onPlace?: () => void;
  onState?: (state: { rows: Row[]; canRequest: boolean }) => void;
}) {
  const setDialog = useVault((state) => state.setDialog);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canRequest, setCanRequest] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void signatureState({ data: { docId, shareId } })
        .then((result) => {
          if (cancelled || !result.ok) return;
          setRows(result.rows);
          setCanRequest(result.canRequest);
          onState?.({ rows: result.rows, canRequest: result.canRequest });
        })
        .catch(() => undefined);
    };
    load();
    // Quien abre el PDF ve las firmas que otros acaban de estampar.
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `onState` es del padre y cambia en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shareId, version]);

  const mine = rows?.find((row) => row.mine && row.status === "pending");
  const signed = rows?.filter((row) => row.status === "signed").length ?? 0;
  const pending = rows?.filter((row) => row.status === "pending").length ?? 0;
  if (!rows || (rows.length === 0 && !canRequest)) return null;

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
      {mine ? <span className="text-muted">{t("Sube una imagen o un certificado .p12 en el recuadro.")}</span> : null}
      {canRequest && onPlace ? (
        <button
          type="button"
          onClick={onPlace}
          className={`h-8 rounded-md px-2 text-xs ${placing ? "bg-accent text-accent-fg" : "text-muted hover:bg-elevated hover:text-fg"}`}
        >
          {placing ? t("Cancelar espacio") : t("Añadir espacio de firma")}
        </button>
      ) : null}
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
