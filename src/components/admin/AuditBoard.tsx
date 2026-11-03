import { useEffect, useState } from "react";
import { t } from "@/app/i18n";
import { auditExport, auditPage, saveAuditRetention } from "@/server/audit.functions";

/** Administración → Monitorización → Auditoría. */

type Row = {
  at: string;
  actor: string;
  action: string;
  outcome: string;
  area: string;
  target: string;
  detail: string;
  ip: string;
};

type Filter = {
  action: string;
  outcome: "" | "ok" | "denied" | "error";
  actor: string;
  from: string;
  to: string;
};

const EMPTY: Filter = { action: "", outcome: "", actor: "", from: "", to: "" };

const ACTIONS: Record<string, string> = {
  sign_in: "Ingreso",
  admin: "Administración",
  upload: "Subida",
  virus: "Antivirus",
  webdav: "WebDAV",
};

const field = "h-11 min-w-0 rounded-md border border-line bg-inset px-3 text-sm";

function outcomeLabel(value: string): string {
  if (value === "ok") return t("Correcto");
  if (value === "denied") return t("Denegado");
  if (value === "error") return t("Error");
  return value;
}

function when(value: string): string {
  return value.replace("T", " ").slice(0, 19);
}

export function AuditBoard() {
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const [rows, setRows] = useState<Row[]>([]);
  const [days, setDays] = useState("365");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (next: Filter) => {
    setBusy(true);
    setError("");
    setNotice("");
    void auditPage({ data: next })
      .then((result) => {
        if (!result.ok) setError(t("Sin permiso."));
        else {
          setRows(result.rows);
          setDays(String(result.retention));
        }
      })
      .catch(() => setError(t("No se pudo leer la auditoría.")))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let alive = true;
    void auditPage({ data: EMPTY })
      .then((result) => {
        if (!alive) return;
        if (!result.ok) setError(t("Sin permiso."));
        else {
          setRows(result.rows);
          setDays(String(result.retention));
        }
      })
      .catch(() => {
        if (alive) setError(t("No se pudo leer la auditoría."));
      });
    return () => {
      alive = false;
    };
  }, []);

  const patch = (part: Partial<Filter>) => setFilter((current) => ({ ...current, ...part }));

  const download = (format: "csv" | "json") => {
    setError("");
    void auditExport({ data: { ...filter, format } })
      .then((result) => {
        if (!result.ok) {
          setError(t(result.error));
          return;
        }
        const blob = new Blob([result.body], { type: result.type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = result.filename;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setError(t("No se pudo exportar.")));
  };

  const saveDays = () => {
    setError("");
    setNotice("");
    const value = Number(days);
    void saveAuditRetention({ data: { days: value } })
      .then((result) => {
        if (!result.ok) setError(t(result.error));
        else {
          setDays(String(result.days));
          setNotice(t("Guardado"));
        }
      })
      .catch(() => setError(t("No se pudo guardar la retención.")));
  };

  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply(filter);
        }}
      >
        <label className="block text-xs text-muted">
          {t("Acción")}
          <select
            className={`${field} mt-1 w-full`}
            value={filter.action}
            onChange={(event) => patch({ action: event.target.value })}
          >
            <option value="">{t("Todas")}</option>
            <option value="sign_in">{t("Ingreso")}</option>
            <option value="admin">{t("Administración")}</option>
            <option value="upload">{t("Subida")}</option>
            <option value="virus">{t("Antivirus")}</option>
            <option value="webdav">WebDAV</option>
          </select>
        </label>
        <label className="block text-xs text-muted">
          {t("Resultado")}
          <select
            className={`${field} mt-1 w-full`}
            value={filter.outcome}
            onChange={(event) => patch({ outcome: event.target.value as Filter["outcome"] })}
          >
            <option value="">{t("Todas")}</option>
            <option value="ok">{t("Correcto")}</option>
            <option value="denied">{t("Denegado")}</option>
            <option value="error">{t("Error")}</option>
          </select>
        </label>
        <label className="block text-xs text-muted">
          {t("Actor")}
          <input
            className={`${field} mt-1 w-full`}
            value={filter.actor}
            onChange={(event) => patch({ actor: event.target.value })}
          />
        </label>
        <label className="block text-xs text-muted">
          {t("Desde")}
          <input
            className={`${field} mt-1 w-full`}
            type="datetime-local"
            value={filter.from}
            onChange={(event) => patch({ from: event.target.value })}
          />
        </label>
        <label className="block text-xs text-muted">
          {t("Hasta")}
          <input
            className={`${field} mt-1 w-full`}
            type="datetime-local"
            value={filter.to}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy}
            className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated disabled:opacity-60"
          >
            {t("Filtrar")}
          </button>
        </div>
      </form>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-muted">
          {t("Retención (días)")}
          <input
            className={`${field} mt-1 w-36`}
            type="number"
            min={7}
            max={3650}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={saveDays}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          {t("Conservar")}
        </button>
        <button
          type="button"
          onClick={() => download("csv")}
          className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated"
        >
          CSV
        </button>
        <button
          type="button"
          onClick={() => download("json")}
          className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated"
        >
          JSON
        </button>
        {notice ? <p className="pb-3 text-xs text-muted">{notice}</p> : null}
      </div>
      <p className="text-xs text-muted">{t("Entre 7 y 3650 días. Lo más viejo se borra solo.")}</p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {rows.length === 0 && !error ? (
        <p className="text-sm text-muted">{t("Todavía no hay eventos.")}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((row, index) => (
            <li
              key={`${row.at}-${index}`}
              className="border-b border-line px-4 py-3 last:border-b-0"
            >
              <p className="text-sm">{t(row.detail || ACTIONS[row.action] || row.action)}</p>
              <p className="mt-1 text-xs text-muted">
                {t(ACTIONS[row.action] || row.action)} · {outcomeLabel(row.outcome)} · {t(row.area)}{" "}
                · {row.actor || t("sistema")}
                {row.target ? ` · ${row.target}` : ""} · {when(row.at)}
                {row.ip ? ` · ${row.ip}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
