import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckSquare,
  Download,
  File,
  FileText,
  Folder,
  Hash,
  Link2,
  List,
  Plus,
  Search,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { syncVault } from "@/app/vault/sync";
import { Modal } from "@/components/ui/Modal";
import {
  compareKeys,
  FIELD_TYPES,
  guessType,
  parseCsv,
  sortKey,
  toCsv,
  type CellValue,
  type FieldType,
  type TableField,
  type TableRow,
  type VaultRef,
} from "@/domain/vault/table";
import {
  tableAddRows,
  tableChanges,
  tableDeleteField,
  tableDeleteRows,
  tableOpen,
  tableSaveField,
  tableUpdateCell,
} from "@/server/table.functions";
import { intl, t } from "@/app/i18n";

/**
 * Una tabla de datos (ver `domain/vault/table.ts`): columnas con tipo y filas,
 * editables celda a celda. Cada cambio se guarda al momento en el servidor y
 * cada 10 segundos llegan los de los demás. Las columnas de vínculo apuntan a
 * notas, archivos y portafolios de la misma bóveda (la propia, o la del
 * espacio de trabajo con `shareId`).
 */

const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const POLL_MS = 10_000;

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Texto",
  number: "Número",
  date: "Fecha",
  select: "Selección",
  checkbox: "Casilla",
  link: "Vínculo a la bóveda",
};

const TYPE_ICON: Record<FieldType, typeof Type> = {
  text: Type,
  number: Hash,
  date: CalendarDays,
  select: List,
  checkbox: CheckSquare,
  link: Link2,
};

const WIDTH: Record<FieldType, number> = { text: 220, number: 120, date: 140, select: 160, checkbox: 90, link: 260 };

type Target = { id: string; title: string; kind: "document" | "portfolio"; file: boolean; place: string };

/** Lo que se puede vincular y cómo abrirlo: la bóveda propia, o la del elemento compartido. */
function useTargets(shareId: string | undefined, selfId: string, onOpenNote?: (id: string) => void) {
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const tree = useSharedView((state) => (shareId && state.tree?.share.id === shareId ? state.tree : null));
  const targets = useMemo<Target[]>(() => {
    const folderName = (list: { id: string; name: string }[], id: string | null) => list.find((item) => item.id === id)?.name ?? "";
    if (shareId) {
      if (!tree) return [];
      return [
        ...tree.portfolios.map((portfolio) => ({ id: portfolio.id, title: portfolio.name, kind: "portfolio" as const, file: false, place: folderName(tree.portfolios, portfolio.parentId) })),
        ...tree.documents
          .filter((document) => document.id !== selfId)
          .map((document) => ({ id: document.id, title: document.title, kind: "document" as const, file: document.kind === "file", place: folderName(tree.portfolios, document.portfolioId) })),
      ];
    }
    return [
      ...portfolios.map((portfolio) => ({ id: portfolio.id, title: portfolio.name, kind: "portfolio" as const, file: false, place: folderName(portfolios, portfolio.parentId) })),
      ...documents
        .filter((document) => document.id !== selfId)
        .map((document) => ({ id: document.id, title: document.title, kind: "document" as const, file: document.kind === "file", place: folderName(portfolios, document.portfolioId) || t("Carpeta Personal") })),
    ];
  }, [shareId, tree, documents, portfolios, selfId]);
  const byKey = useMemo(() => new Map(targets.map((target) => [`${target.kind}:${target.id}`, target])), [targets]);
  const title = (ref: VaultRef) => byKey.get(`${ref.kind}:${ref.id}`)?.title ?? t("(ya no está)");
  const open = (ref: VaultRef) => {
    if (shareId) {
      if (!tree) return;
      if (ref.kind === "portfolio") useSharedView.getState().openSharedPortfolio(tree, ref.id);
      else useSharedView.getState().openShared(tree, ref.id);
      return;
    }
    if (ref.kind === "portfolio") useVault.getState().openPortfolio(ref.id);
    else if (onOpenNote) onOpenNote(ref.id);
    else useVault.getState().setActive(ref.id);
  };
  return { targets, title, open, byKey };
}

export function TableView({
  docId,
  title,
  shareId,
  canEdit: mayEdit,
  onOpenNote,
}: {
  docId: string;
  title: string;
  shareId?: string;
  canEdit: boolean;
  onOpenNote?: (id: string) => void;
}) {
  const where = { docId, ...(shareId ? { shareId } : {}) };
  const [fields, setFields] = useState<TableField[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const sinceRef = useRef(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ fieldId: string; dir: 1 | -1 } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [fieldMenu, setFieldMenu] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<null | { kind: "rows" } | { kind: "field"; id: string }>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const importRef = useRef<HTMLInputElement>(null);
  const { targets, title: refTitle, open: openRef } = useTargets(shareId, docId, onOpenNote);
  const editable = canEdit && mayEdit;

  // Cargar, y luego lo de los demás cada pocos segundos (si la pestaña se ve).
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void tableOpen({ data: where })
      .then((result) => {
        if (!alive) return;
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
        setFields(result.fields);
        setRows(result.rows);
        setCanEdit(result.canEdit);
        sinceRef.current = result.at;
        setLoaded(true);
      })
      .catch(() => alive && setMessage(t("No se pudo abrir la tabla.")));
    const timer = window.setInterval(() => {
      if (document.hidden || !sinceRef.current) return;
      void tableChanges({ data: { ...where, since: sinceRef.current - 2000 } })
        .then((result) => {
          if (!alive || !result.ok) return;
          sinceRef.current = result.at;
          setFields(result.fields);
          if (result.rows.length || result.deleted.length) {
            const gone = new Set(result.deleted);
            setRows((current) => {
              const changed = new Map(result.rows.map((row) => [row.id, row]));
              const kept = current.filter((row) => !gone.has(row.id)).map((row) => changed.get(row.id) ?? row);
              const known = new Set(kept.map((row) => row.id));
              return [...kept, ...result.rows.filter((row) => !known.has(row.id))].sort((a, b) => a.position - b.position);
            });
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shareId]);

  // Lo que se ve: búsqueda, filtros por columna y orden.
  const shown = useMemo(() => {
    const text = (field: TableField, value: CellValue) => String(sortKey(field.type, value, refTitle)).toLowerCase();
    const needle = search.trim().toLowerCase();
    const active = Object.entries(filters).filter(([, value]) => value.trim());
    let list = rows.filter((row) => {
      if (needle && !fields.some((field) => text(field, row.cells[field.id] ?? null).includes(needle))) return false;
      return active.every(([fieldId, value]) => {
        const field = fields.find((item) => item.id === fieldId);
        if (!field) return true;
        const cell = row.cells[fieldId] ?? null;
        if (field.type === "checkbox") return (value === "sí") === Boolean(cell);
        if (field.type === "select") return String(cell ?? "") === value;
        return text(field, cell).includes(value.trim().toLowerCase());
      });
    });
    if (sort) {
      const field = fields.find((item) => item.id === sort.fieldId);
      if (field) {
        list = [...list].sort((a, b) => {
          const order = compareKeys(sortKey(field.type, a.cells[field.id] ?? null, refTitle), sortKey(field.type, b.cells[field.id] ?? null, refTitle));
          // Las vacías siempre al final.
          const blankA = (a.cells[field.id] ?? null) === null;
          const blankB = (b.cells[field.id] ?? null) === null;
          return blankA !== blankB ? (blankA ? 1 : -1) : order * sort.dir;
        });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, fields, search, filters, sort, targets]);

  // Solo se dibujan las filas visibles (y unas cuantas más): miles de filas sin trabarse.
  const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN);
  const visible = shown.slice(first, last);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setScroll({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loaded]);

  const report = (error?: string) => setMessage(error ? t(error) : "");
  const linkChanged = (field: TableField) => {
    // Los vínculos de la tabla cambiaron en el servidor: que el grafo y las menciones los vean.
    if (field.type !== "link" || shareId) return;
    const owner = useVault.getState().owner;
    if (owner) void syncVault(owner);
  };

  const setCell = async (row: TableRow, field: TableField, value: CellValue) => {
    setRows((current) => current.map((item) => (item.id === row.id ? { ...item, cells: { ...item.cells, [field.id]: value } } : item)));
    const result = await tableUpdateCell({ data: { ...where, rowId: row.id, fieldId: field.id, value } }).catch(() => null);
    if (!result?.ok) {
      report(result?.error ?? "No se pudo guardar.");
      return;
    }
    setRows((current) => current.map((item) => (item.id === row.id ? result.row : item)));
    linkChanged(field);
  };

  const addRow = async () => {
    setBusy(true);
    const result = await tableAddRows({ data: { ...where, rows: [{ cells: {} }] } }).catch(() => null);
    setBusy(false);
    if (!result?.ok) return report(result?.error ?? "No se pudo añadir la fila.");
    setRows((current) => [...current, ...result.rows]);
    setSearch("");
    setFilters({});
    const created = result.rows[0];
    const firstField = fields[0];
    if (created && firstField && firstField.type !== "checkbox") setEditing({ rowId: created.id, fieldId: firstField.id });
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  };

  const saveField = async (field: TableField) => {
    setFields((current) => (current.some((item) => item.id === field.id) ? current.map((item) => (item.id === field.id ? field : item)) : [...current, field]));
    const result = await tableSaveField({
      data: { ...where, field: { id: field.id, name: field.name, type: field.type, choices: field.choices, position: field.position, width: field.width ?? null } },
    }).catch(() => null);
    if (!result?.ok) return report(result?.error ?? "No se pudo guardar la columna.");
    // Al cambiar de tipo, los valores se convierten en el servidor.
    const fresh = await tableOpen({ data: where }).catch(() => null);
    if (fresh?.ok) {
      setFields(fresh.fields);
      setRows(fresh.rows);
      sinceRef.current = fresh.at;
    }
    linkChanged(field);
  };

  const addField = () => {
    const position = Math.max(-1, ...fields.map((field) => field.position)) + 1;
    const field: TableField = { id: crypto.randomUUID(), name: t("Columna {n}", { n: fields.length + 1 }), type: "text", position };
    void saveField(field);
    setFieldMenu(field.id);
  };

  const removeField = async (id: string) => {
    const field = fields.find((item) => item.id === id);
    setFields((current) => current.filter((item) => item.id !== id));
    const result = await tableDeleteField({ data: { ...where, fieldId: id } }).catch(() => null);
    if (!result?.ok) report(result?.error ?? "No se pudo borrar la columna.");
    else if (field) linkChanged(field);
  };

  const removeRows = async () => {
    const ids = [...picked];
    setRows((current) => current.filter((row) => !picked.has(row.id)));
    setPicked(new Set());
    for (let index = 0; index < ids.length; index += 1000) {
      const result = await tableDeleteRows({ data: { ...where, rowIds: ids.slice(index, index + 1000) } }).catch(() => null);
      if (!result?.ok) return report(result?.error ?? "No se pudieron borrar las filas.");
    }
    if (fields.some((field) => field.type === "link")) linkChanged(fields.find((field) => field.type === "link")!);
  };

  const display = (field: TableField, value: CellValue): string => {
    if (value === null || value === undefined) return "";
    if (field.type === "number" && typeof value === "number") return new Intl.NumberFormat(intl()).format(value);
    if (field.type === "date" && typeof value === "string") {
      const date = new Date(`${value}T00:00:00`);
      return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", year: "numeric" }).format(date);
    }
    if (field.type === "checkbox") return value ? t("Sí") : "";
    if (field.type === "link" && Array.isArray(value)) return value.map(refTitle).join(", ");
    return String(value);
  };

  const exportCsv = () => {
    const header = fields.map((field) => field.name);
    const body = shown.map((row) =>
      fields.map((field) => {
        const value = row.cells[field.id] ?? null;
        if (field.type === "checkbox") return value ? "sí" : "no";
        if (field.type === "number" || field.type === "date") return value === null ? "" : String(value);
        return display(field, value);
      }),
    );
    const blob = new Blob([toCsv([header, ...body])], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/\.tabla$/i, "") || t("Tabla")}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importCsv = async (file: File) => {
    const lines = parseCsv(await file.text());
    const [header, ...data] = lines;
    if (!header || data.length === 0) return report("El archivo no tiene filas.");
    setBusy(true);
    setMessage(t("Importando {n} filas…", { n: data.length }));
    // Columnas por nombre; las que no existen se crean (con el tipo que parezcan tener).
    const empty = rows.length === 0 && fields.length === 1 && fields[0]!.name === "Nombre";
    let known = [...fields];
    let position = Math.max(-1, ...known.map((field) => field.position)) + 1;
    const columnIds: string[] = [];
    for (const [index, rawName] of header.entries()) {
      const name = rawName.trim() || t("Columna {n}", { n: index + 1 });
      const values = data.map((line) => line[index] ?? "");
      let field = known.find((item) => item.name.trim().toLowerCase() === name.toLowerCase());
      if (!field && empty && index === 0) {
        field = { ...known[0]!, name, type: guessType(values) };
        await tableSaveField({ data: { ...where, field: { id: field.id, name, type: field.type } } }).catch(() => null);
        known = [field];
      }
      if (!field) {
        field = { id: crypto.randomUUID(), name, type: guessType(values), position: position++ };
        const saved = await tableSaveField({ data: { ...where, field: { id: field.id, name, type: field.type, position: field.position } } }).catch(() => null);
        if (!saved?.ok) {
          setBusy(false);
          return report(saved?.error ?? "No se pudo crear la columna.");
        }
        known.push(field);
      }
      columnIds.push(field.id);
    }
    for (let index = 0; index < data.length; index += 500) {
      const batch = data.slice(index, index + 500).map((line) => ({
        cells: Object.fromEntries(columnIds.map((fieldId, column) => [fieldId, line[column] ?? ""])),
      }));
      const result = await tableAddRows({ data: { ...where, rows: batch } }).catch(() => null);
      if (!result?.ok) {
        setBusy(false);
        return report(result?.error ?? "No se pudo importar.");
      }
    }
    const fresh = await tableOpen({ data: where }).catch(() => null);
    setBusy(false);
    if (fresh?.ok) {
      setFields(fresh.fields);
      setRows(fresh.rows);
      sinceRef.current = fresh.at;
    }
    setMessage(t("Importadas {n} filas.", { n: data.length }));
  };

  if (!loaded) {
    return <p className="grid flex-1 place-items-center px-6 text-sm text-muted">{message || t("Cargando…")}</p>;
  }

  const widthOf = (field: TableField) => field.width ?? WIDTH[field.type];
  const totalWidth = 44 + fields.reduce((sum, field) => sum + widthOf(field), 0) + (editable ? 44 : 0);
  const allPicked = shown.length > 0 && shown.every((row) => picked.has(row.id));

  return (
    <div data-ui="table-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
        <label className="flex h-9 min-w-40 flex-1 items-center gap-2 rounded-md border border-line bg-inset px-2.5 text-sm sm:max-w-xs">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Buscar en la tabla")}
            aria-label={t("Buscar en la tabla")}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
        <span className="text-xs text-faint">
          {shown.length === rows.length
            ? rows.length === 1
              ? t("1 fila")
              : t("{n} filas", { n: rows.length })
            : t("{n} de {m} filas", { n: shown.length, m: rows.length })}
        </span>
        {Object.values(filters).some((value) => value.trim()) ? (
          <button type="button" onClick={() => setFilters({})} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-accent hover:bg-elevated">
            <X className="size-3.5" />
            {t("Quitar filtros")}
          </button>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {editable && picked.size > 0 ? (
            <button
              type="button"
              onClick={() => setConfirmDelete({ kind: "rows" })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-danger/40 px-3 text-sm text-danger hover:bg-danger/10"
            >
              <Trash2 className="size-4" />
              {(picked.size === 1 ? t("Borrar 1 fila") : t("Borrar {n} filas", { n: picked.size }))}
            </button>
          ) : null}
          {editable ? (
            <>
              <ToolButton icon={<Upload className="size-4" />} label={t("Importar CSV")} onClick={() => importRef.current?.click()} disabled={busy} />
              <input
                ref={importRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importCsv(file);
                }}
              />
            </>
          ) : null}
          <ToolButton icon={<Download className="size-4" />} label={t("Exportar CSV")} onClick={exportCsv} />
          {editable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void addRow()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              <Plus className="size-4" />
              {t("Nueva fila")}
            </button>
          ) : null}
        </span>
        {message ? <p className="w-full text-xs text-muted">{message}</p> : null}
      </div>

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        <table className="border-separate border-spacing-0 text-sm" style={{ width: totalWidth, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 44 }} />
            {fields.map((field) => (
              <col key={field.id} style={{ width: widthOf(field) }} />
            ))}
            {editable ? <col style={{ width: 44 }} /> : null}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th className="h-9 border-b border-line px-2">
                {editable ? (
                  <input
                    type="checkbox"
                    aria-label={t("Elegir todas")}
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((row) => row.id)))}
                  />
                ) : null}
              </th>
              {fields.map((field) => {
                const Icon = TYPE_ICON[field.type];
                const sorted = sort?.fieldId === field.id ? sort.dir : 0;
                return (
                  <th key={field.id} className="relative h-9 border-b border-l border-line p-0 text-left font-medium">
                    <button
                      type="button"
                      onClick={() => setFieldMenu(fieldMenu === field.id ? null : field.id)}
                      className="flex h-9 w-full items-center gap-1.5 px-2 text-left text-xs text-muted hover:bg-elevated hover:text-fg"
                    >
                      <Icon className="size-3.5 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate">{field.name}</span>
                      {filters[field.id]?.trim() ? <Search className="size-3 shrink-0 text-accent" /> : null}
                      {sorted === 1 ? <ArrowUp className="size-3 shrink-0 text-accent" /> : sorted === -1 ? <ArrowDown className="size-3 shrink-0 text-accent" /> : null}
                    </button>
                    {fieldMenu === field.id ? (
                      <FieldMenu
                        field={field}
                        editable={editable}
                        filter={filters[field.id] ?? ""}
                        sort={sorted}
                        onSort={(dir) => setSort(dir ? { fieldId: field.id, dir } : null)}
                        onFilter={(value) => setFilters((current) => ({ ...current, [field.id]: value }))}
                        onSave={(next) => void saveField(next)}
                        onDelete={() => setConfirmDelete({ kind: "field", id: field.id })}
                        onClose={() => setFieldMenu(null)}
                      />
                    ) : null}
                  </th>
                );
              })}
              {editable ? (
                <th className="h-9 border-b border-l border-line p-0">
                  <button
                    type="button"
                    aria-label={t("Nueva columna")}
                    title={t("Nueva columna")}
                    onClick={addField}
                    className="grid h-9 w-full place-items-center text-muted hover:bg-elevated hover:text-fg"
                  >
                    <Plus className="size-4" />
                  </button>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {first > 0 ? (
              <tr aria-hidden style={{ height: first * ROW_HEIGHT }}>
                <td colSpan={fields.length + 2} />
              </tr>
            ) : null}
            {visible.map((row) => (
              <tr key={row.id} className={picked.has(row.id) ? "bg-accent/10" : "hover:bg-elevated/60"} style={{ height: ROW_HEIGHT }}>
                <td className="border-b border-line px-2 text-center">
                  {editable ? (
                    <input
                      type="checkbox"
                      aria-label={t("Elegir fila")}
                      checked={picked.has(row.id)}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })
                      }
                    />
                  ) : null}
                </td>
                {fields.map((field, column) => (
                  <Cell
                    key={field.id}
                    field={field}
                    value={row.cells[field.id] ?? null}
                    text={display(field, row.cells[field.id] ?? null)}
                    editable={editable}
                    editing={editing?.rowId === row.id && editing.fieldId === field.id}
                    targets={targets}
                    refTitle={refTitle}
                    onOpenRef={openRef}
                    onEdit={() => setEditing({ rowId: row.id, fieldId: field.id })}
                    onCommit={(value, move) => {
                      setEditing(null);
                      const current = row.cells[field.id] ?? null;
                      if (JSON.stringify(current) !== JSON.stringify(value)) void setCell(row, field, value);
                      if (!move) return;
                      // Enter baja a la fila siguiente; Tab pasa a la columna siguiente.
                      const index = shown.findIndex((item) => item.id === row.id);
                      const next =
                        move === "down"
                          ? { row: shown[index + 1], field }
                          : { row, field: fields[column + 1] ?? undefined };
                      if (next.row && next.field && next.field.type !== "checkbox") setEditing({ rowId: next.row.id, fieldId: next.field.id });
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ))}
                {editable ? <td className="border-b border-l border-line" /> : null}
              </tr>
            ))}
            {last < shown.length ? (
              <tr aria-hidden style={{ height: (shown.length - last) * ROW_HEIGHT }}>
                <td colSpan={fields.length + 2} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted">
            {editable ? t("La tabla está vacía. Añade una fila o importa un CSV.") : t("La tabla está vacía.")}
          </p>
        ) : null}
      </div>

      {confirmDelete ? (
        <Modal
          title={confirmDelete.kind === "rows" ? (picked.size === 1 ? t("Borrar 1 fila") : t("Borrar {n} filas", { n: picked.size })) : t("Borrar la columna")}
          onClose={() => setConfirmDelete(null)}
        >
          <p className="text-sm text-muted">
            {confirmDelete.kind === "rows"
              ? t("Las filas elegidas se borrarán. No se puede deshacer.")
              : t("«{0}» y sus valores en todas las filas se borrarán. No se puede deshacer.", {
                  0: fields.find((field) => confirmDelete.kind === "field" && field.id === confirmDelete.id)?.name ?? "",
                })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="h-11 rounded-md px-3 text-sm text-muted hover:bg-elevated">
              {t("Cancelar")}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                setFieldMenu(null);
                if (target.kind === "rows") void removeRows();
                else void removeField(target.id);
              }}
              className="h-11 rounded-md bg-danger px-4 text-sm font-medium text-accent-fg"
            >
              {t("Borrar")}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function ToolButton({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-fg hover:bg-elevated disabled:opacity-50"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** Menú de una columna: ordenar, filtrar y (con permiso) nombre, tipo, opciones y borrar. */
function FieldMenu({
  field,
  editable,
  filter,
  sort,
  onSort,
  onFilter,
  onSave,
  onDelete,
  onClose,
}: {
  field: TableField;
  editable: boolean;
  filter: string;
  sort: 0 | 1 | -1;
  onSort: (dir: 0 | 1 | -1) => void;
  onFilter: (value: string) => void;
  onSave: (field: TableField) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(field.name);
  const [choices, setChoices] = useState((field.choices ?? []).join(", "));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      // La cabecera de la columna lo abre y lo cierra ella misma.
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const commitName = () => {
    if (name.trim() && name.trim() !== field.name) onSave({ ...field, name: name.trim() });
  };
  const commitChoices = () => {
    const list = choices.split(",").map((choice) => choice.trim()).filter(Boolean);
    if (list.join(",") !== (field.choices ?? []).join(",")) onSave({ ...field, choices: list });
  };
  return (
    <div
      ref={ref}
      data-ui="popover"
      className="absolute top-full left-0 z-20 mt-1 w-64 space-y-3 rounded-lg border border-line bg-surface p-3 text-left text-sm font-normal shadow-2xl"
    >
      {editable ? (
        <>
          <label className="block">
            <span className="text-xs text-faint">{t("Nombre")}</span>
            <input
              autoFocus
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitName();
                  onClose();
                }
              }}
              className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2 outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs text-faint">{t("Tipo")}</span>
            <select
              value={field.type}
              onChange={(event) => onSave({ ...field, name: name.trim() || field.name, type: event.target.value as FieldType })}
              className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2"
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(TYPE_LABEL[type])}
                </option>
              ))}
            </select>
          </label>
          {field.type === "select" ? (
            <label className="block">
              <span className="text-xs text-faint">{t("Opciones, separadas por comas")}</span>
              <input
                value={choices}
                onChange={(event) => setChoices(event.target.value)}
                onBlur={commitChoices}
                onKeyDown={(event) => event.key === "Enter" && commitChoices()}
                className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2 outline-none"
              />
            </label>
          ) : null}
        </>
      ) : null}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => onSort(sort === 1 ? 0 : 1)}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs ${sort === 1 ? "border-accent text-accent" : "border-line text-muted hover:text-fg"}`}
        >
          <ArrowUp className="size-3.5" />
          {t("Ascendente")}
        </button>
        <button
          type="button"
          onClick={() => onSort(sort === -1 ? 0 : -1)}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs ${sort === -1 ? "border-accent text-accent" : "border-line text-muted hover:text-fg"}`}
        >
          <ArrowDown className="size-3.5" />
          {t("Descendente")}
        </button>
      </div>
      <label className="block">
        <span className="text-xs text-faint">{t("Filtrar")}</span>
        {field.type === "checkbox" ? (
          <select value={filter} onChange={(event) => onFilter(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2">
            <option value="">{t("Todas")}</option>
            <option value="sí">{t("Marcadas")}</option>
            <option value="no">{t("Sin marcar")}</option>
          </select>
        ) : field.type === "select" ? (
          <select value={filter} onChange={(event) => onFilter(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2">
            <option value="">{t("Todas")}</option>
            {(field.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder={t("Contiene…")}
            className="mt-1 h-9 w-full rounded-md border border-line bg-inset px-2 outline-none"
          />
        )}
      </label>
      {editable ? (
        <button type="button" onClick={onDelete} className="inline-flex h-8 items-center gap-1.5 text-xs text-danger">
          <Trash2 className="size-3.5" />
          {t("Borrar la columna")}
        </button>
      ) : null}
    </div>
  );
}

/** Una celda: se ve su valor y, al pulsarla (con permiso), se edita según su tipo. */
function Cell({
  field,
  value,
  text,
  editable,
  editing,
  targets,
  refTitle,
  onOpenRef,
  onEdit,
  onCommit,
  onCancel,
}: {
  field: TableField;
  value: CellValue;
  text: string;
  editable: boolean;
  editing: boolean;
  targets: Target[];
  refTitle: (ref: VaultRef) => string;
  onOpenRef: (ref: VaultRef) => void;
  onEdit: () => void;
  onCommit: (value: CellValue, move?: "down" | "right") => void;
  onCancel: () => void;
}) {
  const base = "border-b border-l border-line px-2";
  if (field.type === "checkbox") {
    return (
      <td className={`${base} text-center`}>
        <input
          type="checkbox"
          aria-label={field.name}
          checked={Boolean(value)}
          disabled={!editable}
          onChange={() => onCommit(value ? null : true)}
        />
      </td>
    );
  }
  if (field.type === "link") {
    const refs = Array.isArray(value) ? value : [];
    return (
      <td className={`${base} relative`}>
        <div className="flex h-9 items-center gap-1 overflow-hidden" onClick={editable && !editing ? onEdit : undefined}>
          {refs.map((ref) => (
            <button
              key={`${ref.kind}:${ref.id}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenRef(ref);
              }}
              className="inline-flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs text-fg hover:border-accent"
            >
              {ref.kind === "portfolio" ? <Folder className="size-3 shrink-0 text-faint" /> : <FileText className="size-3 shrink-0 text-faint" />}
              <span className="truncate">{refTitle(ref)}</span>
            </button>
          ))}
          {editable && refs.length === 0 ? <span className="text-xs text-faint">{t("Vincular…")}</span> : null}
        </div>
        {editing ? <LinkPicker refs={refs} targets={targets} refTitle={refTitle} onCommit={onCommit} onCancel={onCancel} /> : null}
      </td>
    );
  }
  if (!editing) {
    return (
      <td
        className={`${base} truncate ${field.type === "number" ? "text-right tabular-nums" : ""} ${editable ? "cursor-text" : ""}`}
        title={text}
        onClick={editable ? onEdit : undefined}
      >
        {field.type === "select" && text ? (
          <span className="inline-flex h-6 max-w-full items-center rounded-full bg-accent/15 px-2 text-xs text-fg">
            <span className="truncate">{text}</span>
          </span>
        ) : (
          text
        )}
      </td>
    );
  }
  return (
    <td className={`${base} p-0`}>
      <CellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
    </td>
  );
}

function CellEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: TableField;
  value: CellValue;
  onCommit: (value: CellValue, move?: "down" | "right") => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const done = useRef(false);
  const commit = (move?: "down" | "right") => {
    if (done.current) return;
    done.current = true;
    onCommit(draft === "" ? null : field.type === "number" ? Number(draft) : draft, move);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit("down");
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit("right");
    } else if (event.key === "Escape") {
      done.current = true;
      onCancel();
    }
  };
  const className = "h-9 w-full bg-inset px-2 text-sm outline-none ring-1 ring-accent ring-inset";
  if (field.type === "select") {
    return (
      <select
        autoFocus
        value={draft}
        onChange={(event) => {
          done.current = true;
          onCommit(event.target.value || null);
        }}
        onBlur={() => commit()}
        onKeyDown={keys}
        className={className}
      >
        <option value="">—</option>
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
        {draft && !(field.choices ?? []).includes(draft) ? <option value={draft}>{draft}</option> : null}
      </select>
    );
  }
  return (
    <input
      autoFocus
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      step="any"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit()}
      onKeyDown={keys}
      className={`${className} ${field.type === "number" ? "text-right" : ""}`}
    />
  );
}

/** Elegir notas, archivos o portafolios de la bóveda para una celda de vínculo. */
function LinkPicker({
  refs,
  targets,
  refTitle,
  onCommit,
  onCancel,
}: {
  refs: VaultRef[];
  targets: Target[];
  refTitle: (ref: VaultRef) => string;
  onCommit: (value: CellValue) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<VaultRef[]>(refs);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(chosen);
  latest.current = chosen;
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCommit(latest.current.length ? latest.current : null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onCommit]);
  const needle = query.trim().toLowerCase();
  const has = (target: Target) => chosen.some((item) => item.id === target.id && item.kind === target.kind);
  const options = targets.filter((target) => !has(target) && (!needle || target.title.toLowerCase().includes(needle))).slice(0, 40);
  return (
    <div
      ref={ref}
      data-ui="popover"
      className="absolute top-full left-0 z-20 mt-1 w-80 rounded-lg border border-line bg-surface p-2 text-sm shadow-2xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      {chosen.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {chosen.map((item) => (
            <span key={`${item.kind}:${item.id}`} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-line pr-1 pl-2 text-xs">
              <span className="truncate">{refTitle(item)}</span>
              <button
                type="button"
                aria-label={t("Quitar")}
                onClick={() => setChosen((current) => current.filter((other) => !(other.id === item.id && other.kind === item.kind)))}
                className="grid size-5 place-items-center rounded-full text-faint hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit(chosen.length ? chosen : null);
        }}
        placeholder={t("Buscar notas, archivos o portafolios")}
        className="h-9 w-full rounded-md border border-line bg-inset px-2 outline-none"
      />
      <ul className="mt-1 max-h-64 overflow-y-auto">
        {options.map((target) => {
          const Icon = target.kind === "portfolio" ? Folder : target.file ? File : FileText;
          return (
            <li key={`${target.kind}:${target.id}`}>
              <button
                type="button"
                onClick={() => setChosen((current) => [...current, { id: target.id, kind: target.kind }])}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-elevated"
              >
                <Icon className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate">{target.title}</span>
                <span className="max-w-[40%] shrink-0 truncate text-xs text-faint">{target.place}</span>
              </button>
            </li>
          );
        })}
        {options.length === 0 ? <li className="px-2 py-2 text-xs text-faint">{t("Nada coincide.")}</li> : null}
      </ul>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => onCommit(chosen.length ? chosen : null)}
          className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg"
        >
          {t("Listo")}
        </button>
      </div>
    </div>
  );
}
