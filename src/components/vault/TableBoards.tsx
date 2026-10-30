import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { intl, t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import type { TableField, TableRow } from "@/domain/vault/table";
import { tableRowHistory } from "@/server/table.functions";

type Where = { docId: string; shareId?: string };

/**
 * Tablero, galería y calendario de una tabla (fase 3). La cuadrícula sigue
 * en `TableView`. Arrastrar una tarjeta de tablero cambia la selección.
 */
export function TableBoards({
  mode,
  fields,
  rows,
  kanbanFieldId,
  calendarFieldId,
  editable,
  textOf,
  onKanbanField,
  onCalendarField,
  onMove,
}: {
  mode: "kanban" | "gallery" | "calendar";
  fields: TableField[];
  rows: TableRow[];
  kanbanFieldId: string | null;
  calendarFieldId: string | null;
  editable: boolean;
  textOf: (row: TableRow, field: TableField) => string;
  onKanbanField: (id: string) => void;
  onCalendarField: (id: string) => void;
  onMove: (row: TableRow, field: TableField, value: string | null) => void;
}) {
  const selects = fields.filter((field) => field.type === "select");
  const dates = fields.filter((field) => field.type === "date");
  const group = selects.find((field) => field.id === kanbanFieldId) ?? selects[0] ?? null;
  const dateField = dates.find((field) => field.id === calendarFieldId) ?? dates[0] ?? null;
  const titleOf = (row: TableRow) => {
    const field = fields.find((item) => (item.type === "text" || item.type === "select") && item.id !== group?.id) ?? fields.find((item) => item.id !== group?.id);
    const text = field ? textOf(row, field) : "";
    return text || t("(sin nombre)");
  };

  if (mode === "kanban") {
    if (!group) return <p className="grid flex-1 place-items-center px-6 text-sm text-muted">{t("El tablero necesita una columna de selección.")}</p>;
    const lanes = [...(group.choices ?? []).map((choice) => ({ key: choice, label: choice })), { key: "", label: t("Sin grupo") }];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {selects.length > 1 ? (
          <div className="border-b border-line px-3 py-2">
            <FieldPicker label={t("Agrupar por")} value={group.id} options={selects} onChange={onKanbanField} />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {lanes.map((lane) => {
            const cards = rows.filter((row) => {
              const value = row.cells[group.id];
              const text = typeof value === "string" ? value : "";
              return lane.key ? text === lane.key : !lane.key && !(group.choices ?? []).includes(text);
            });
            return (
              <section
                key={lane.key || "empty"}
                className="flex w-64 shrink-0 flex-col rounded-lg border border-line bg-inset/40"
                onDragOver={(event) => {
                  if (editable) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!editable) return;
                  const id = event.dataTransfer.getData("text/plain");
                  const row = rows.find((item) => item.id === id);
                  if (row) onMove(row, group, lane.key || null);
                }}
              >
                <header className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted">
                  <span className="min-w-0 flex-1 truncate">{lane.label}</span>
                  <span className="text-faint">{cards.length}</span>
                </header>
                <div className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {cards.map((row) => (
                    <article
                      key={row.id}
                      draggable={editable}
                      onDragStart={(event) => event.dataTransfer.setData("text/plain", row.id)}
                      className={`rounded-md border border-line bg-surface p-2.5 text-sm ${editable ? "cursor-grab active:cursor-grabbing" : ""}`}
                    >
                      <p className="truncate font-medium">{titleOf(row)}</p>
                      <CardFacts row={row} fields={fields} skip={new Set([group.id, fields.find((item) => item.type === "text")?.id ?? ""])} textOf={textOf} />
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  if (mode === "gallery") {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {rows.length === 0 ? <p className="py-16 text-center text-sm text-muted">{t("La tabla está vacía.")}</p> : null}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {rows.map((row) => (
            <article key={row.id} className="rounded-lg border border-line bg-surface p-3">
              <p className="truncate font-medium">{titleOf(row)}</p>
              <CardFacts row={row} fields={fields} skip={new Set()} textOf={textOf} />
            </article>
          ))}
        </div>
      </div>
    );
  }

  if (!dateField) return <p className="grid flex-1 place-items-center px-6 text-sm text-muted">{t("El calendario necesita una columna de fecha.")}</p>;
  return (
    <CalendarBoard
      field={dateField}
      dates={dates}
      rows={rows}
      titleOf={titleOf}
      onField={onCalendarField}
    />
  );
}

function FieldPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: TableField[];
  onChange: (id: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
      <span className="mr-1">{label}</span>
      {options.map((field) => (
        <button
          key={field.id}
          type="button"
          aria-pressed={field.id === value}
          onClick={() => onChange(field.id)}
          className={`h-8 max-w-40 truncate rounded-md border px-2 ${field.id === value ? "border-accent bg-accent/15 text-fg" : "border-line bg-inset hover:text-fg"}`}
        >
          {field.name}
        </button>
      ))}
    </div>
  );
}

function CardFacts({
  row,
  fields,
  skip,
  textOf,
}: {
  row: TableRow;
  fields: TableField[];
  skip: Set<string>;
  textOf: (row: TableRow, field: TableField) => string;
}) {
  const facts = fields.filter((field) => !skip.has(field.id)).slice(0, 4);
  return (
    <dl className="mt-2 space-y-1">
      {facts.map((field) => {
        const text = textOf(row, field);
        if (!text) return null;
        return (
          <div key={field.id} className="flex gap-2 text-xs">
            <dt className="w-16 shrink-0 truncate text-faint">{field.name}</dt>
            <dd className="min-w-0 flex-1 truncate text-muted">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function CalendarBoard({
  field,
  dates,
  rows,
  titleOf,
  onField,
}: {
  field: TableField;
  dates: TableField[];
  rows: TableRow[];
  titleOf: (row: TableRow) => string;
  onField: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  // Solo la primera letra en mayúscula («Octubre de 2026», no «Octubre De 2026»).
  const monthName = new Intl.DateTimeFormat(intl(), { month: "long", year: "numeric" }).format(cursor);
  const label = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const first = new Date(year, month, 1);
  const start = new Date(first);
  const weekday = (first.getDay() + 6) % 7;
  start.setDate(1 - weekday);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  const byDay = new Map<string, TableRow[]>();
  for (const row of rows) {
    const value = row.cells[field.id];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) continue;
    const key = value.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  const names = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2026, 0, 5 + index);
    return new Intl.DateTimeFormat(intl(), { weekday: "narrow" }).format(date);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" aria-label={t("Mes anterior")} onClick={() => setCursor(new Date(year, month - 1, 1))} className="grid size-8 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg">
          <ChevronLeft className="size-4" />
        </button>
        <p className="min-w-36 text-center text-sm">{label}</p>
        <button type="button" aria-label={t("Mes siguiente")} onClick={() => setCursor(new Date(year, month + 1, 1))} className="grid size-8 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg">
          <ChevronRight className="size-4" />
        </button>
        <button type="button" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))} className="h-8 rounded-md px-2 text-xs text-accent hover:bg-elevated">
          {t("Hoy")}
        </button>
        <FieldPicker label={t("Fecha")} value={field.id} options={dates} onChange={onField} />
      </div>
      <div className="grid grid-cols-7 border-b border-line text-center text-xs text-faint">
        {names.map((name) => (
          <div key={name} className="py-1.5">
            {name}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((date) => {
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
          const items = byDay.get(key) ?? [];
          const inMonth = date.getMonth() === month;
          return (
            <div key={key} className={`min-w-0 border-b border-l border-line p-1 ${inMonth ? "" : "bg-inset/50 text-faint"}`}>
              <p className="px-0.5 text-xs">{date.getDate()}</p>
              <ul className="space-y-0.5">
                {items.slice(0, 3).map((row) => (
                  <li key={row.id} className="truncate rounded bg-accent/15 px-1 text-xs text-fg" title={titleOf(row)}>
                    {titleOf(row)}
                  </li>
                ))}
                {items.length > 3 ? <li className="px-1 text-xs text-faint">{t("{n} más", { n: items.length - 3 })}</li> : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type HistoryItem = {
  id: string;
  at: number;
  actor: string;
  kind: "create" | "update" | "delete";
  changes: { field: string; from: string; to: string }[];
};

/** Quién cambió la fila, y el valor anterior y el nuevo. */
export function RowHistoryDialog({ where, rowId, onClose }: { where: Where; rowId: string; onClose: () => void }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState("");
  const docId = where.docId;
  const shareId = where.shareId;
  useEffect(() => {
    let alive = true;
    void tableRowHistory({ data: { docId, ...(shareId ? { shareId } : {}), rowId } })
      .then((result) => {
        if (!alive) return;
        if (!result.ok) setError(t(result.error));
        else setItems(result.history);
      })
      .catch(() => alive && setError(t("No se pudo leer el historial.")));
    return () => {
      alive = false;
    };
  }, [docId, shareId, rowId]);
  const when = (at: number) => new Intl.DateTimeFormat(intl(), { dateStyle: "medium", timeStyle: "short" }).format(at);
  return (
    <Modal title={t("Historial")} onClose={onClose}>
      {error ? <p className="text-sm text-muted">{error}</p> : null}
      {items && items.length === 0 ? <p className="text-sm text-muted">{t("Esta fila no tiene cambios.")}</p> : null}
      {items === null && !error ? <p className="text-sm text-muted">{t("Cargando…")}</p> : null}
      <ol className="max-h-96 space-y-4 overflow-y-auto">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <p className="text-xs text-faint">
              {item.actor || t("(sin nombre)")} · {when(item.at)}
              {item.kind === "create" ? ` · ${t("Creada")}` : item.kind === "delete" ? ` · ${t("Borrada")}` : ""}
            </p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {item.changes.map((change, index) => (
                <li key={`${change.field}:${index}`} className="truncate">
                  <span className="text-muted">{change.field}: </span>
                  <span className="text-faint">{change.from || "—"}</span>
                  <span className="text-faint"> → </span>
                  <span>{change.to || "—"}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
