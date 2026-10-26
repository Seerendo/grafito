import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { diffLines, diffStats, type DiffLine } from "@/domain/diff";
import { docHistory, docVersion, restoreDocVersion } from "@/server/history.functions";
import { intl, t } from "@/app/i18n";

type Version = Extract<Awaited<ReturnType<typeof docHistory>>, { ok: true }>["versions"][number];
type Restored = Extract<Awaited<ReturnType<typeof restoreDocVersion>>, { ok: true }>;

/** Líneas sin cambios que se muestran alrededor de cada cambio. */
const CONTEXT = 2;

/**
 * Historial de una nota: quién la cambió y cuándo, qué cambió en cada versión
 * respecto a la anterior, y restaurar cualquiera. Sirve para notas propias y,
 * con `shareId`, para notas compartidas conmigo con permiso de edición.
 */
export function HistoryDialog({
  docId,
  shareId,
  canRestore,
  onRestored,
  onClose,
}: {
  docId: string;
  shareId?: string;
  canRestore: boolean;
  onRestored: (result: Restored) => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    void docHistory({ data: { docId, shareId } })
      .then((result) => {
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setVersions(result.versions);
        setSelected(result.versions[0]?.id ?? null);
      })
      .catch(() => setError(t("No se pudo leer el historial.")));
  }, [docId, shareId]);

  const index = versions?.findIndex((version) => version.id === selected) ?? -1;
  const current = index >= 0 ? versions![index]! : null;
  const previous = index >= 0 ? (versions![index + 1] ?? null) : null;

  useEffect(() => {
    for (const version of [current, previous]) {
      if (!version || version.file || requested.current.has(version.id)) continue;
      requested.current.add(version.id);
      void docVersion({ data: { docId, shareId, versionId: version.id } }).then((result) => {
        if (result.ok) setContents((known) => ({ ...known, [version.id]: result.version.content }));
      });
    }
  }, [current, previous, docId, shareId]);

  const lines = useMemo(() => {
    if (!current || current.file || contents[current.id] === undefined) return null;
    const before = previous ? contents[previous.id] : "";
    if (before === undefined) return null;
    return diffLines(before, contents[current.id]!);
  }, [current, previous, contents]);

  const restore = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const result = await restoreDocVersion({ data: { docId, shareId, versionId: current.id } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onRestored(result);
      onClose();
    } catch {
      setError(t("No se pudo restaurar."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("Historial")} onClose={onClose} wide>
      {error ? <p className="mb-3 text-sm text-danger">{t(error)}</p> : null}
      {!versions && !error ? <p className="text-sm text-muted">{t("Cargando…")}</p> : null}
      {versions && versions.length === 0 ? <p className="text-sm text-muted">{t("Sin versiones.")}</p> : null}
      {versions && versions.length > 0 ? (
        <div className="flex max-h-[70vh] min-h-0 flex-col gap-3 md:flex-row">
          <ul className="max-h-48 shrink-0 overflow-y-auto rounded-md border border-line md:max-h-none md:w-60">
            {versions.map((version, position) => (
              <li key={version.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setSelected(version.id)}
                  aria-current={version.id === selected ? "true" : undefined}
                  className={`w-full px-3 py-2 text-left text-sm ${
                    version.id === selected ? "bg-inset text-fg" : "text-muted hover:bg-elevated hover:text-fg"
                  }`}
                >
                  <span className="block truncate">{formatWhen(version.createdAt)}</span>
                  <span className="block truncate text-xs text-faint">
                    {version.author || t("Alguien")}
                    {position === 0 ? t(" · actual") : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {current ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-fg">{current.title}</span>
                  {lines ? <Stats lines={lines} /> : null}
                </span>
                {canRestore && index > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restore()}
                    className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-60"
                  >
                    {busy ? t("Restaurando…") : t("Restaurar esta versión")}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="min-h-40 flex-1 overflow-auto rounded-md border border-line bg-inset font-mono text-xs leading-5">
              {current?.file ? (
                <p className="p-3 text-muted">
                  {current.title} · {formatSize(current.size)}
                </p>
              ) : lines ? (
                <DiffView lines={lines} />
              ) : (
                <p className="p-3 text-muted">{t("Cargando…")}</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg">
          {t("Cerrar")}
        </button>
      </div>
    </Modal>
  );
}

function Stats({ lines }: { lines: DiffLine[] }) {
  const { added, removed } = diffStats(lines);
  return (
    <span className="ml-2">
      <span className="text-accent">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

/** Cambios con unas líneas de contexto; los tramos largos sin cambios se pliegan. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  const keep = new Set<number>();
  lines.forEach((line, position) => {
    if (line.kind === "same") return;
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) keep.add(position + offset);
  });
  if (keep.size === 0) return <p className="p-3 text-muted">{t("Sin cambios de texto.")}</p>;
  const rows: ({ type: "line"; line: DiffLine; key: number } | { type: "gap"; count: number; key: number })[] = [];
  let gap = 0;
  lines.forEach((line, position) => {
    if (keep.has(position)) {
      if (gap > 0) rows.push({ type: "gap", count: gap, key: -position });
      gap = 0;
      rows.push({ type: "line", line, key: position });
    } else {
      gap += 1;
    }
  });
  if (gap > 0) rows.push({ type: "gap", count: gap, key: -lines.length - 1 });
  return (
    <div className="min-w-max py-1">
      {rows.map((row) =>
        row.type === "gap" ? (
          <p key={row.key} className="px-3 py-0.5 text-faint">
            ··· {row.count} {row.count === 1 ? t("línea") : t("líneas")}{" "}{t("sin cambios")}
          </p>
        ) : (
          <p
            key={row.key}
            className={`px-3 whitespace-pre ${
              row.line.kind === "added"
                ? "bg-accent/15 text-fg"
                : row.line.kind === "removed"
                  ? "bg-danger/15 text-muted line-through"
                  : "text-muted"
            }`}
          >
            <span className="inline-block w-4 select-none text-faint">
              {row.line.kind === "added" ? "+" : row.line.kind === "removed" ? "−" : " "}
            </span>
            {row.line.text || " "}
          </p>
        ),
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    new Date(ms),
  );
}
