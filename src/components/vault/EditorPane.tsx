import {
  Bold,
  BookOpen,
  Code,
  Columns2,
  Copy,
  Download,
  Heading2,
  Highlighter,
  History,
  Italic,
  Lightbulb,
  Link,
  Link2,
  Share2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  MoreHorizontal,
  PenLine,
  Pin,
  Plus,
  Quote,
  Strikethrough,
  Table,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readingLabel, unclosedWiki, wordCount } from "@/domain/vault/links";
import { useActiveDocument, useVault } from "@/app/vault/store";
import { usePermissions } from "@/app/permissions";
import { PERMISSION, deletePermission, exportPermission } from "@/domain/permissions";
import { syncVault } from "@/app/vault/sync";
import { FileView } from "./FileView";
import { HistoryDialog } from "./HistoryDialog";
import { HomeBoard } from "./HomeBoard";
import { VisibilityMark } from "./visibility";
import { MarkdownView } from "./MarkdownView";
import { requestNotePdf } from "./NotePdf";

function wrapSelection(value: string, start: number, end: number, before: string, after: string) {
  const selected = value.slice(start, end) || "texto";
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const from = start + before.length;
  const to = from + selected.length;
  return { next, start: from, end: to };
}

function blockInsert(value: string, start: number, end: number, snippet: string, cursorAt: number) {
  const lead = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const next = value.slice(0, start) + lead + snippet + value.slice(end);
  const cursor = start + lead.length + cursorAt;
  return { next, start: cursor, end: cursor };
}

function prefixLines(value: string, start: number, end: number, prefix: string) {
  const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const newline = value.indexOf("\n", Math.max(end, start));
  const to = newline === -1 ? value.length : newline;
  const block = value.slice(from, to);
  const lines = (block.length === 0 ? [""] : block.split("\n")).map((line) =>
    line.startsWith(prefix) ? line : `${prefix}${line}`,
  );
  const nextBlock = lines.join("\n");
  const next = value.slice(0, from) + nextBlock + value.slice(to);
  const cursor = from + nextBlock.length;
  return { next, start: cursor, end: cursor };
}

const TABLE = "| Columna | Columna |\n| --- | --- |\n|  |  |\n";
const TABLE_AT = "| Columna | Columna |\n| --- | --- |\n| ".length;

export function EditorPane({
  mobile,
  onOpenNote,
  onFilter,
  onClose,
}: {
  mobile: boolean;
  onOpenNote: (id: string) => void;
  onFilter: () => void;
  onClose: () => void;
}) {
  const document = useActiveDocument();
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const mode = useVault((state) => state.mode);
  const setMode = useVault((state) => state.setMode);
  const updateContent = useVault((state) => state.updateContent);
  const rename = useVault((state) => state.rename);
  const togglePin = useVault((state) => state.togglePin);
  const toggleTask = useVault((state) => state.toggleTask);
  const openTitle = useVault((state) => state.openTitle);
  const setTag = useVault((state) => state.setTag);
  const duplicate = useVault((state) => state.duplicate);
  const setDialog = useVault((state) => state.setDialog);
  const createDocument = useVault((state) => state.createDocument);
  const can = usePermissions();
  const canEdit = can(PERMISSION.notesEdit);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const insertRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState("");
  const [menu, setMenu] = useState(false);
  const [history, setHistory] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setTitle(document?.title ?? "");
    setTitleError("");
    setMenu(false);
    setHistory(false);
    setInsertOpen(false);
  }, [document?.id, document?.title]);

  useEffect(() => {
    if (!menu && !insertOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu && !menuRef.current?.contains(target)) setMenu(false);
      if (insertOpen && !insertRef.current?.contains(target)) setInsertOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!menu && !insertOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
      setInsertOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu, insertOpen]);

  if (!document) {
    return (
      <HomeBoard
        onCreate={can(PERMISSION.notesCreate) ? () => createDocument() : undefined}
      />
    );
  }

  const portfolioName = portfolios.find((item) => item.id === document.portfolioId)?.name ?? "Raíz";
  const isFile = document.kind === "file";
  // Sin permiso de edición la nota siempre se lee, aunque se guardara otro modo.
  const viewMode = canEdit ? mode : "read";
  const showEditor = !isFile && (viewMode === "edit" || (viewMode === "split" && !mobile));
  const showPreview = isFile || viewMode === "read" || viewMode === "split" || (mobile && viewMode !== "edit");
  const wiki = showEditor ? unclosedWiki(document.content, cursor) : null;
  const suggestions = wiki
    ? documents
        .filter(
          (item) =>
            item.id !== document.id && item.title.toLowerCase().includes(wiki.query.trim().toLowerCase()),
        )
        .slice(0, 6)
    : [];
  const words = wordCount(document.content);
  const edited = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(document.updatedAt);

  const commitTitle = () => {
    const ok = rename(document.id, title);
    if (!ok) {
      setTitleError("Ya hay un documento con ese nombre.");
      setTitle(document.title);
      return;
    }
    setTitleError("");
  };

  const focusEdit = (next: string, start: number, end: number) => {
    setInsertOpen(false);
    updateContent(document.id, next);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(start, end);
      setCursor(start);
    });
  };

  const applyWrap = (before: string, after: string) => {
    const area = areaRef.current;
    if (!area || isFile) return;
    const edit = wrapSelection(document.content, area.selectionStart, area.selectionEnd, before, after);
    focusEdit(edit.next, edit.start, edit.end);
  };

  const applyBlock = (snippet: string, cursorAt: number) => {
    const area = areaRef.current;
    if (!area || isFile) return;
    const edit = blockInsert(document.content, area.selectionStart, area.selectionEnd, snippet, cursorAt);
    focusEdit(edit.next, edit.start, edit.end);
    setInsertOpen(false);
  };

  const applyPrefix = (prefix: string) => {
    const area = areaRef.current;
    if (!area || isFile) return;
    const edit = prefixLines(document.content, area.selectionStart, area.selectionEnd, prefix);
    focusEdit(edit.next, edit.start, edit.end);
    setInsertOpen(false);
  };

  const applyFence = () => {
    const area = areaRef.current;
    if (!area || isFile) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const selected = document.content.slice(start, end) || "código";
    const lead = start > 0 && document.content[start - 1] !== "\n" ? "\n" : "";
    const snippet = `\`\`\`\n${selected}\n\`\`\`\n`;
    const next = document.content.slice(0, start) + lead + snippet + document.content.slice(end);
    const inner = start + lead.length + 4;
    focusEdit(next, inner, inner + selected.length);
    setInsertOpen(false);
  };

  const applyLink = () => {
    const area = areaRef.current;
    if (!area || isFile) return;
    const { selectionStart: start, selectionEnd: end } = area;
    const selected = document.content.slice(start, end) || "texto";
    const snippet = `[${selected}](https://)`;
    const next = document.content.slice(0, start) + snippet + document.content.slice(end);
    const urlAt = start + selected.length + 3;
    focusEdit(next, urlAt, urlAt + "https://".length);
    setInsertOpen(false);
  };

  const acceptWiki = (picked: string) => {
    const area = areaRef.current;
    if (!area || !wiki || isFile) return;
    const clean = picked.trim();
    if (!clean) return;
    const next = document.content.slice(0, wiki.start) + `[[${clean}]]` + document.content.slice(area.selectionStart);
    const nextCursor = wiki.start + clean.length + 4;
    updateContent(document.id, next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(nextCursor, nextCursor);
      setCursor(nextCursor);
    });
  };

  const exportNote = () => {
    if (isFile && document.file) {
      const link = window.document.createElement("a");
      link.href = document.file.dataUrl;
      link.download = document.file.name;
      link.click();
      setMenu(false);
      return;
    }
    const blob = new Blob([document.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${document.title}.md`;
    link.click();
    URL.revokeObjectURL(url);
    setMenu(false);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {history ? (
        <HistoryDialog
          docId={document.id}
          canRestore={canEdit}
          onRestored={() => {
            const owner = useVault.getState().owner;
            if (owner) void syncVault(owner);
          }}
          onClose={() => setHistory(false)}
        />
      ) : null}
      <div className="flex items-start gap-2 border-b border-line px-4 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-faint">{portfolioName}</p>
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleError("");
            }}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            aria-label="Título del documento"
            readOnly={!canEdit}
            className="w-full bg-transparent font-serif text-2xl font-semibold tracking-tight text-fg outline-none"
          />
          {titleError ? <p className="text-xs text-danger">{titleError}</p> : null}
        </div>
        <div className="flex shrink-0 items-center">
          <VisibilityMark id={document.id} className="px-2" />
          <button
            type="button"
            aria-label="Cerrar documento"
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-md text-muted hover:text-fg"
          >
            <X className="size-4" />
          </button>
          <button
            type="button"
            aria-label={document.pinned ? "Quitar fijada" : "Fijar documento"}
            onClick={() => togglePin(document.id)}
            className={`grid h-11 w-11 place-items-center rounded-md ${document.pinned ? "text-accent" : "text-muted hover:text-fg"}`}
          >
            <Pin className="size-4" />
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-label="Más acciones"
              aria-expanded={menu}
              onClick={() => setMenu((open) => !open)}
              className="grid h-11 w-11 place-items-center rounded-md text-muted hover:text-fg"
            >
              <MoreHorizontal className="size-4" />
            </button>
            {menu ? (
              <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-line bg-surface p-1 shadow-2xl">
                {can(PERMISSION.notesShare) ? (
                  <MenuButton
                    icon={<Share2 className="size-4" />}
                    label="Compartir…"
                    onClick={() => {
                      setMenu(false);
                      setDialog({ type: "share", kind: "document", id: document.id });
                    }}
                  />
                ) : null}
                {can(PERMISSION.linksManage) ? (
                  <MenuButton
                    icon={<Link2 className="size-4" />}
                    label="Vincular"
                    onClick={() => {
                      setMenu(false);
                      setDialog({ type: "link", sourceId: document.id });
                    }}
                  />
                ) : null}
                {!isFile ? (
                  <MenuButton
                    icon={<History className="size-4" />}
                    label="Historial"
                    onClick={() => {
                      setMenu(false);
                      // Primero se sube lo último escrito, para que esté en el historial.
                      const owner = useVault.getState().owner;
                      void (owner ? syncVault(owner) : Promise.resolve()).finally(() => setHistory(true));
                    }}
                  />
                ) : null}
                {!isFile && can(PERMISSION.notesCreate) ? (
                  <MenuButton
                    icon={<Copy className="size-4" />}
                    label="Duplicar"
                    onClick={() => {
                      duplicate(document.id);
                      setMenu(false);
                    }}
                  />
                ) : null}
                {can(exportPermission(document.kind)) ? (
                  <MenuButton
                    icon={<Download className="size-4" />}
                    label={isFile ? "Descargar archivo" : "Exportar .md"}
                    onClick={exportNote}
                  />
                ) : null}
                {!isFile && can(PERMISSION.notesExport) ? (
                  <MenuButton
                    icon={<Download className="size-4" />}
                    label="Descargar PDF"
                    onClick={() => {
                      setMenu(false);
                      requestNotePdf({ title: document.title, content: document.content });
                    }}
                  />
                ) : null}
                {can(deletePermission(document.kind)) ? (
                  <MenuButton
                    icon={<Trash2 className="size-4" />}
                    label="Eliminar"
                    danger
                    onClick={() => {
                      setMenu(false);
                      setDialog({ type: "delete-document", id: document.id });
                    }}
                  />
                ) : null}
                <p className="hidden px-3 py-2 text-xs text-faint only:block">Sin acciones para tu rol.</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isFile ? null : (
        <div className="flex items-center gap-1 border-b border-line px-3 py-1">
          <ModeButton active={viewMode === "edit"} label="Editar" disabled={!canEdit} onClick={() => setMode("edit")}>
            <PenLine className="size-4" />
          </ModeButton>
          <ModeButton
            active={viewMode === "split"}
            label="Dividir"
            className="hidden md:inline-flex"
            disabled={!canEdit}
            onClick={() => setMode("split")}
          >
            <Columns2 className="size-4" />
          </ModeButton>
          <ModeButton active={viewMode === "read" || (mobile && viewMode === "split")} label="Leer" onClick={() => setMode("read")}>
            <BookOpen className="size-4" />
          </ModeButton>
          {showEditor ? (
            <div className="ml-auto flex min-w-0 items-center">
              <ToolButton label="Negrita" onClick={() => applyWrap("**", "**")}>
                <Bold className="size-4" />
              </ToolButton>
              <ToolButton label="Cursiva" onClick={() => applyWrap("*", "*")}>
                <Italic className="size-4" />
              </ToolButton>
              <ToolButton label="Código en línea" onClick={() => applyWrap("`", "`")}>
                <Code className="size-4" />
              </ToolButton>
              <ToolButton label="Enlace interno" onClick={() => applyWrap("[[", "]]")}>
                <Link2 className="size-4" />
              </ToolButton>
              <div ref={insertRef} className="relative">
                <ToolButton label="Insertar Markdown" onClick={() => setInsertOpen((open) => !open)}>
                  <Plus className="size-4" />
                </ToolButton>
                {insertOpen ? (
                  <div className="absolute right-0 z-20 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-2xl">
                    <MenuButton icon={<Table className="size-4" />} label="Tabla" onClick={() => applyBlock(TABLE, TABLE_AT)} />
                    <MenuButton icon={<Code className="size-4" />} label="Bloque de código" onClick={applyFence} />
                    <MenuButton icon={<Heading2 className="size-4" />} label="Encabezado" onClick={() => applyPrefix("## ")} />
                    <MenuButton icon={<List className="size-4" />} label="Lista" onClick={() => applyPrefix("- ")} />
                    <MenuButton icon={<ListOrdered className="size-4" />} label="Lista numerada" onClick={() => applyPrefix("1. ")} />
                    <MenuButton icon={<ListChecks className="size-4" />} label="Tareas" onClick={() => applyPrefix("- [ ] ")} />
                    <MenuButton icon={<Quote className="size-4" />} label="Cita" onClick={() => applyPrefix("> ")} />
                    <MenuButton
                      icon={<Lightbulb className="size-4" />}
                      label="Llamado"
                      onClick={() => applyBlock("> [!idea] Idea\n> ", "> [!idea] Idea\n> ".length)}
                    />
                    <MenuButton icon={<Link className="size-4" />} label="Enlace" onClick={applyLink} />
                    <MenuButton icon={<Minus className="size-4" />} label="Regla" onClick={() => applyBlock("---\n", 4)} />
                    <MenuButton icon={<Strikethrough className="size-4" />} label="Tachado" onClick={() => applyWrap("~~", "~~")} />
                    <MenuButton icon={<Highlighter className="size-4" />} label="Resaltado" onClick={() => applyWrap("==", "==")} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="ml-auto pr-2 text-xs text-faint">
              {words} palabras · {readingLabel(words)} · {document.updatedBy} · {edited}
            </p>
          )}
        </div>
      )}

      <div className={`grid min-h-0 flex-1 ${showEditor && showPreview && !isFile ? "md:grid-cols-2" : "grid-cols-1"}`}>
        {showEditor ? (
          <div className="flex min-h-0 min-w-0 flex-col border-line pt-1.5 md:border-r md:pr-1">
            {/* El margen de arriba y la derecha no es editable: un clic sobre la línea divisoria no cae en el editor. */}
            <textarea
              ref={areaRef}
              value={document.content}
              onChange={(event) => {
                updateContent(document.id, event.target.value);
                setCursor(event.target.selectionStart);
              }}
              onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
              onClick={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                const meta = event.metaKey || event.ctrlKey;
                if (meta && event.key.toLowerCase() === "b") {
                  event.preventDefault();
                  applyWrap("**", "**");
                } else if (meta && event.key.toLowerCase() === "i") {
                  event.preventDefault();
                  applyWrap("*", "*");
                } else if (meta && event.key.toLowerCase() === "e" && event.shiftKey) {
                  event.preventDefault();
                  applyFence();
                } else if (wiki && event.key === "Enter" && (suggestions[0] || wiki.query.trim())) {
                  event.preventDefault();
                  acceptWiki(suggestions[0]?.title ?? wiki.query);
                }
              }}
              spellCheck
              aria-label="Contenido de la nota"
              className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 pt-1.5 pb-3 font-sans text-sm leading-normal text-fg outline-none sm:px-5"
            />
            {wiki ? (
              <div className="border-t border-line bg-surface p-2">
                <ul>
                  {suggestions.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => acceptWiki(item.title)}
                        className="flex h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-elevated"
                      >
                        {item.title}
                        <span className="ml-auto text-xs text-faint">
                          {portfolios.find((portfolio) => portfolio.id === item.portfolioId)?.name ?? "Raíz"}
                        </span>
                      </button>
                    </li>
                  ))}
                  {suggestions.length === 0 && wiki.query.trim() ? (
                    <li>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => acceptWiki(wiki.query.trim())}
                        className="flex h-11 w-full items-center rounded-md px-2 text-left text-sm text-accent hover:bg-elevated"
                      >
                        Usar [[{wiki.query.trim()}]]
                      </button>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {showPreview && isFile && document.file ? <FileView title={document.title} file={document.file} /> : null}
        {showPreview && !isFile ? (
          <div className="min-h-0 overflow-y-auto">
            <MarkdownView
              source={document.content}
              title={document.title}
              noteExists={(name) => documents.some((item) => item.title.toLowerCase() === name.toLowerCase())}
              onWiki={(name) => {
                openTitle(name);
                onOpenNote(useVault.getState().activeId ?? "");
              }}
              onTag={(next) => {
                setTag(next);
                onFilter();
              }}
              onToggleTask={canEdit ? (line) => toggleTask(document.id, line) : undefined}
            />
          </div>
        ) : null}
      </div>
      {showEditor ? (
        <footer className="flex h-10 shrink-0 items-center gap-3 border-t border-line px-4 text-xs text-faint">
          <span>
            {words} palabras · {readingLabel(words)}
          </span>
          <span className="ml-auto">
            {document.updatedBy} · {edited}
          </span>
        </footer>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
  children,
  className = "",
  disabled = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Tu rol no permite editar" : undefined}
      className={`inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${className} ${
        active ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"
      }`}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-10 w-10 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
    >
      {children}
    </button>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-elevated ${
        danger ? "text-danger" : "text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
