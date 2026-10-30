import { useEffect, useRef, useState } from "react";
import { fetchSharedTree } from "@/app/shared-open";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { answerSignature, placeSignature, removeSignature, signPdf, signaturePeople } from "@/server/signature.functions";
import { PdfView, type PdfSignBox, type PdfViewProps } from "./PdfView";
import { SignatureBar } from "./SignatureDialog";

type Box = { page: number; x: number; y: number; w: number; h: number };

/**
 * Firmas de un PDF abierto con sesión. El recuadro lo marca quien puede
 * editar. Cada persona sube su imagen una vez: se estampa y no se guarda.
 */
export function PdfSignatures({ notes, ...pdf }: PdfViewProps & { notes: { docId: string; shareId?: string } }) {
  const docId = notes.docId;
  const shareId = notes.shareId;
  const [version, setVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [boxes, setBoxes] = useState<PdfSignBox[]>([]);
  const [canPlace, setCanPlace] = useState(false);
  const [draft, setDraft] = useState<Box | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string; loginName: string; self?: boolean }[] | null>(null);
  const [picked, setPicked] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const signing = useRef<string | null>(null);
  const signedMark = useRef<{ docId: string; mark: string }>({ docId: "", mark: "" });
  const [certificate, setCertificate] = useState<{ id: string; data: string } | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!placing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  const refreshFile = async () => {
    setReloadKey(Date.now());
    if (!shareId) {
      const owner = useVault.getState().owner;
      if (owner) await syncVault(owner);
      return;
    }
    const tree = await fetchSharedTree(shareId, true).catch(() => null);
    const view = useSharedView.getState();
    if (tree && view.tree?.share.id === shareId && view.docId === docId) view.openShared(tree, docId);
  };

  const assign = async () => {
    if (!draft || !picked) {
      setError(t("Elige quién firma en este espacio"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await placeSignature({ data: { docId, shareId, userId: picked, box: draft } });
      if (!result.ok) {
        const who = "who" in result ? result.who : undefined;
        setError(who ? t(result.error, { 0: who }) : t(result.error));
        return;
      }
      setDraft(null);
      setPlacing(false);
      setPicked("");
      setVersion((value) => value + 1);
    } catch {
      setError(t("No se pudieron pedir las firmas."));
    } finally {
      setBusy(false);
    }
  };

  const signWith = async (payload: { id: string; image?: string; p12?: string; password?: string }) => {
    setError("");
    setBusy(true);
    try {
      const result = await signPdf({ data: payload });
      if (!result.ok) {
        setError(t(result.error));
        return;
      }
      setCertificate(null);
      setPassword("");
      setVersion((value) => value + 1);
      await refreshFile();
    } catch {
      setError(t("No se pudo estampar la firma en el PDF."));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    const id = signing.current;
    signing.current = null;
    if (!file || !id) return;
    setError("");
    try {
      const data = await fileToBase64(file);
      if (isCertificateFile(file)) {
        setPassword("");
        setCertificate({ id, data });
        return;
      }
      await signWith({ id, image: data });
    } catch {
      setError(t("No se pudo estampar la firma en el PDF."));
    }
  };

  const closeCertificate = () => {
    setCertificate(null);
    setPassword("");
    setError("");
  };

  const decline = async (id: string) => {
    setError("");
    const result = await answerSignature({ data: { id, status: "declined" } }).catch(() => null);
    if (!result?.ok) setError(t(result?.error ?? "No se pudo registrar la firma."));
    else setVersion((value) => value + 1);
  };

  const remove = async (id: string) => {
    setError("");
    const result = await removeSignature({ data: { docId, shareId, signatureId: id } }).catch(() => null);
    if (!result?.ok) setError(t(result?.error ?? "No se pudo registrar la firma."));
    else setVersion((value) => value + 1);
  };

  const needle = query.trim().toLowerCase();
  const shown = (people ?? []).filter(
    (person) => !needle || person.name.toLowerCase().includes(needle) || person.loginName.toLowerCase().includes(needle),
  );

  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <SignatureBar
        docId={docId}
        shareId={shareId}
        version={version}
        placing={placing}
        onPlace={() => setPlacing((value) => !value)}
        onState={(state) => {
          setCanPlace(state.canRequest);
          setBoxes(
            state.rows.flatMap((row) =>
              row.page != null && row.x != null && row.y != null && row.w != null && row.h != null
                ? [{ id: row.id, page: row.page, x: row.x, y: row.y, w: row.w, h: row.h, signerName: row.signerName, status: row.status, mine: row.mine, stale: row.stale }]
                : [],
            ),
          );
          const mark = state.rows
            .filter((row) => row.status === "signed")
            .map((row) => row.id)
            .sort()
            .join(",");
          const previous = signedMark.current;
          signedMark.current = { docId, mark };
          if (previous.docId === docId && previous.mark !== mark) void refreshFile();
        }}
      />
      {placing ? <p className="shrink-0 px-4 py-1.5 text-xs text-muted">{t("Dibuja el recuadro en la página. Luego elige a quién corresponde.")}</p> : null}
      {error ? <p className="shrink-0 px-4 py-1 text-xs text-danger">{error}</p> : null}
      <div className="min-h-0 flex-1">
        <PdfView
          {...pdf}
          notes={notes}
          reloadKey={reloadKey}
          signatures={{
            placing,
            canPlace,
            boxes,
            onDrawn: (box) => {
              setDraft(box);
              setPicked("");
              setQuery("");
              setError("");
              setPeople(null);
              void signaturePeople({ data: { docId, shareId } })
                .then(setPeople)
                .catch(() => setPeople([]));
            },
            onSign: (id) => {
              signing.current = id;
              fileRef.current?.click();
            },
            onDecline: (id) => void decline(id),
            onRemove: (id) => void remove(id),
          }}
        />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg,.p12,.pfx,application/x-pkcs12"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void onFile(file);
        }}
      />
      {draft ? (
        <Modal title={t("Elige quién firma en este espacio")} onClose={() => setDraft(null)}>
          <p className="text-sm text-muted">{t("Cada persona firma en su recuadro con una imagen o con un certificado .p12. El certificado dibuja un QR y el nombre. La imagen, el certificado y la contraseña se usan una sola vez y no se guardan.")}</p>
          <div className="mt-3">
            <SearchField value={query} onChange={setQuery} placeholder={t("Buscar persona")} />
            <ul className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line">
              {people === null ? <li className="px-3 py-3 text-sm text-muted">{t("Cargando…")}</li> : null}
              {people && people.length === 0 ? <li className="px-3 py-3 text-sm text-muted">{t("Nadie con acceso a este documento.")}</li> : null}
              {people && people.length > 0 && shown.length === 0 ? <li className="px-3 py-3 text-sm text-muted">{t("Ningún usuario coincide.")}</li> : null}
              {shown.map((person) => {
                const on = picked === person.id;
                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setPicked(person.id)}
                      className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-elevated"
                    >
                      <span className={`grid size-4 place-items-center rounded-full border ${on ? "border-accent bg-accent" : "border-line"}`} />
                      <span className="min-w-0 flex-1 truncate">{person.name}</span>
                      {person.self ? <span className="shrink-0 text-xs text-accent">{t("Tú")}</span> : null}
                      {person.loginName ? <span className="shrink-0 text-xs text-faint">{person.loginName}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(null)} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
              {t("Cancelar")}
            </button>
            <button
              type="button"
              disabled={busy || !picked}
              onClick={() => void assign()}
              className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
            >
              {busy ? t("Guardando…") : t("Asignar")}
            </button>
          </div>
        </Modal>
      ) : null}
      {certificate ? (
        <Modal title={t("Contraseña del certificado")} onClose={closeCertificate}>
          <p className="text-sm text-muted">
            {t("El certificado y su contraseña se usan una sola vez para firmar este PDF y no se guardan. Descarga el PDF para comprobar la firma en el lector.")}
          </p>
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void signWith({ id: certificate.id, p12: certificate.data, password });
            }}
          >
            <label className="mb-1 block text-xs text-muted" htmlFor="p12-password">
              {t("Contraseña")}
            </label>
            <input
              id="p12-password"
              type="password"
              autoFocus
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-11 w-full rounded-md border border-line bg-inset px-3 text-sm outline-none"
            />
            {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeCertificate} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
                {t("Cancelar")}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
              >
                {busy ? t("Guardando…") : t("Firmar")}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function isCertificateFile(file: File): boolean {
  return /\.(p12|pfx)$/i.test(file.name) || file.type === "application/x-pkcs12" || file.type === "application/pkcs12";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
