import { Link2, MessageSquare, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { anchorAt, linkKey, locate, type TextAnchor } from "@/domain/vault/anchor";
import type { ManualLink } from "@/domain/vault/types";
import {
  commentKey,
  deleteComment,
  loadComments,
  sendComment,
  useComments,
  type DocComment,
  type PdfNote,
} from "@/app/comments";
import { intl, t } from "@/app/i18n";

/**
 * Visor de PDF propio (PDF.js), en vez del del navegador: deja seleccionar una
 * palabra o frase y vincularla con una nota u otro archivo (`onLink`) o dejarle
 * una nota (`notes`: un comentario con ancla, sin tocar el archivo). Las frases
 * vinculadas y las notas se ven resaltadas; al pulsarlas se abre su destino o
 * se leen. Las notas que ya traía el PDF (de otro lector) se muestran también.
 * Cada página se dibuja al acercarse a la vista. Ver `domain/vault/anchor.ts`.
 */

type PdfJs = typeof import("pdfjs-dist");

let loader: Promise<PdfJs> | null = null;

/** PDF.js y su worker, cargados solo cuando se abre un PDF. */
function loadPdfJs(): Promise<PdfJs> {
  // Solo en el navegador (ver `DrawingView`): fuera del build del servidor.
  if (import.meta.env.SSR) return Promise.reject(new Error("PDF.js solo en el navegador"));
  loader ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return loader;
}

type Rect = { x: number; y: number; width: number; height: number };
/** Una frase resaltada: un vínculo (`targetId`) o las notas sobre ella (`noteIds`). */
type Mark = { key: string; exact: string; targetId?: string; noteIds?: string[]; rects: Rect[] };
type Picked = { anchor: TextAnchor; x: number; y: number };
/** Lo que se lee en el globo: notas de Grafito o una nota del propio PDF. */
type Bubble = { x: number; y: number; noteIds?: string[]; pdfNote?: PdfNote };
/** Adónde ir: una frase (`exact`) o solo la página. */
type Focus = { page: number; exact?: string };
/** Nota del propio PDF con su rectángulo (coordenadas del PDF). */
type EmbeddedNote = PdfNote & { rect: number[] };

/** Tipos de anotación que no son notas de nadie (enlaces, campos de formulario). */
const NOT_NOTES = new Set(["Link", "Widget", "Popup"]);
const NO_COMMENTS: DocComment[] = [];

export function PdfView({
  url,
  title,
  links = [],
  targetTitle,
  onLink,
  onOpen,
  focus,
  onFocused,
  notes,
}: {
  url: string;
  title: string;
  /** Vínculos del archivo; solo los que tienen `anchor` se resaltan. */
  links?: ManualLink[];
  targetTitle?: (id: string) => string | undefined;
  /** Sin él, no se ofrece vincular (lo compartido, un rol sin permiso). */
  onLink?: (anchor: TextAnchor) => void;
  onOpen?: (targetId: string) => void;
  /** Frase a la que ir al abrir (desde Menciones). */
  focus?: TextAnchor | null;
  onFocused?: () => void;
  /** El documento cuyos comentarios son las notas (en lo compartido, con `shareId`). */
  notes?: { docId: string; shareId?: string };
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<{ lib: PdfJs; doc: PDFDocumentProxy; ratio: number } | null>(null);
  const [error, setError] = useState(false);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [composing, setComposing] = useState<Picked | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedNote[]>([]);
  const docId = notes?.docId ?? "";
  const shareId = notes?.shareId;
  const entry = useComments((state) => (notes ? state.docs[commentKey(docId, shareId)] : undefined));
  const comments = entry?.comments ?? NO_COMMENTS;
  const storeFocus = useComments((state) => (notes && state.focus?.docId === docId ? state.focus : null));
  const setPdfNotes = useComments((state) => state.setPdfNotes);

  // Las notas se leen con el panel de Comentarios; si aún no, aquí.
  const hasNotes = Boolean(notes);
  const canPick = Boolean(onLink) || hasNotes;
  useEffect(() => {
    if (hasNotes && !useComments.getState().docs[commentKey(docId, shareId)]) void loadComments(docId, shareId);
  }, [hasNotes, docId, shareId]);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(false);
    setEmbedded([]);
    void (async () => {
      try {
        const lib = await loadPdfJs();
        doc = await lib.getDocument({ url, useSystemFonts: true }).promise;
        const first = await doc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setPdf({ lib, doc, ratio: base.height / base.width });
        // Las notas que ya trae el archivo, de todas las páginas.
        const found: EmbeddedNote[] = [];
        for (let number = 1; number <= doc.numPages && !cancelled; number += 1) {
          const page = await doc.getPage(number);
          const annotations = (await page.getAnnotations({ intent: "display" })) as Array<{
            id: string;
            subtype: string;
            rect: number[];
            contentsObj?: { str?: string };
            titleObj?: { str?: string };
            modificationDate?: string | null;
          }>;
          for (const item of annotations) {
            const body = item.contentsObj?.str?.trim();
            if (!body || NOT_NOTES.has(item.subtype)) continue;
            const date = item.modificationDate ? lib.PDFDateString.toDateObject(item.modificationDate) : null;
            found.push({
              id: `${number}-${item.id}`,
              page: number,
              author: item.titleObj?.str?.trim() ?? "",
              body,
              at: date ? date.getTime() : null,
              rect: item.rect,
            });
          }
        }
        if (!cancelled) setEmbedded(found);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url]);

  // El panel de Comentarios las lista (sin el rectángulo).
  useEffect(() => {
    if (hasNotes) setPdfNotes(docId, embedded.map(({ rect: _rect, ...note }) => note));
  }, [embedded, hasNotes, docId, setPdfNotes]);

  // Ancho disponible: las páginas se dibujan a ese ancho (y se rehacen si cambia).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let timer = 0;
    const measure = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(Math.max(240, Math.floor(element.clientWidth - 32))), 120);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // Una frase seleccionada dentro de una página: los botones «Vincular» y «Nota» a su lado.
  useEffect(() => {
    if (!canPick) return;
    let timer = 0;
    const read = () => {
      const scroller = scrollRef.current;
      const selection = window.getSelection();
      if (!scroller || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPicked(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const layer = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>("[data-text-layer]");
      const endLayer = (range.endContainer.parentElement ?? null)?.closest<HTMLElement>("[data-text-layer]");
      if (!layer || layer !== endLayer || !scroller.contains(layer)) {
        setPicked(null);
        return;
      }
      const before = document.createRange();
      before.setStart(layer, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const anchor = anchorAt(layer.textContent ?? "", Number(layer.dataset.page), start, start + range.toString().length);
      const box = range.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      setPicked(
        anchor
          ? { anchor, x: box.right - frame.left + scroller.scrollLeft, y: box.bottom - frame.top + scroller.scrollTop + 6 }
          : null,
      );
    };
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 200);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.clearTimeout(timer);
    };
  }, [canPick]);

  /** Un punto de la pantalla, en coordenadas del contenido que se desplaza. */
  const toScroller = useCallback((clientX: number, clientY: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return { x: 0, y: 0 };
    const frame = scroller.getBoundingClientRect();
    return { x: clientX - frame.left + scroller.scrollLeft, y: clientY - frame.top + scroller.scrollTop + 8 };
  }, []);

  const active: Focus | null = storeFocus ?? focus ?? null;
  const focused = useCallback(() => {
    if (useComments.getState().focus) useComments.setState({ focus: null });
    onFocused?.();
  }, [onFocused]);

  const anchored = useMemo(() => comments.filter((comment) => comment.anchor), [comments]);

  if (error) return <p className="text-sm text-danger">{t("No se pudo abrir el PDF.")}</p>;

  const bubbleNotes = bubble?.noteIds ? comments.filter((comment) => bubble.noteIds!.includes(comment.id)) : [];
  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

  return (
    <div
      ref={scrollRef}
      data-ui="pdf"
      aria-label={title}
      className="relative h-full min-h-[60vh] overflow-auto rounded-md border border-line bg-inset p-4"
      onMouseDown={(event) => {
        if (bubble && !(event.target as HTMLElement).closest("[data-ui='pdf-bubble']")) setBubble(null);
      }}
    >
      {!pdf || width === 0 ? (
        <p className="text-sm text-faint">{t("Cargando…")}</p>
      ) : (
        <div className="mx-auto flex flex-col items-center gap-4" style={{ width }}>
          {Array.from({ length: pdf.doc.numPages }, (_, index) => (
            <PdfPage
              key={`${index + 1}-${width}`}
              lib={pdf.lib}
              doc={pdf.doc}
              number={index + 1}
              width={width}
              ratio={pdf.ratio}
              links={links.filter((link) => link.anchor?.page === index + 1)}
              notes={anchored.filter((comment) => comment.anchor!.page === index + 1)}
              embedded={embedded.filter((note) => note.page === index + 1)}
              targetTitle={targetTitle}
              onOpen={onOpen}
              onBubble={(next, clientX, clientY) => setBubble({ ...next, ...toScroller(clientX, clientY) })}
              focus={active?.page === index + 1 ? active : null}
              onFocused={focused}
            />
          ))}
        </div>
      )}
      {picked && !composing ? (
        <div
          style={{ left: picked.x, top: picked.y }}
          className="absolute z-10 flex -translate-x-full gap-1.5"
          // Antes de que el clic deshaga la selección.
          onMouseDown={(event) => event.preventDefault()}
        >
          {onLink ? (
            <button
              type="button"
              onClick={() => {
                onLink(picked.anchor);
                window.getSelection()?.removeAllRanges();
                setPicked(null);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg shadow-lg"
            >
              <Link2 className="size-3.5" />
              {t("Vincular selección")}
            </button>
          ) : null}
          {notes ? (
            <button
              type="button"
              onClick={() => {
                setComposing(picked);
                setPicked(null);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg shadow-lg"
            >
              <MessageSquarePlus className="size-3.5" />
              {t("Nota")}
            </button>
          ) : null}
        </div>
      ) : null}
      {composing && notes ? (
        <NoteComposer
          at={composing}
          onCancel={() => setComposing(null)}
          onSave={async (body) => {
            const failed = await sendComment(notes.docId, notes.shareId, body, composing.anchor);
            if (!failed) {
              window.getSelection()?.removeAllRanges();
              setComposing(null);
            }
            return failed;
          }}
        />
      ) : null}
      {bubble ? (
        <div
          data-ui="pdf-bubble"
          style={{ left: bubble.x, top: bubble.y }}
          className="absolute z-20 w-72 max-w-[calc(100%-2rem)] -translate-x-1/2 space-y-2 rounded-lg border border-line bg-surface p-2.5 shadow-2xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setBubble(null);
            }
          }}
        >
          {bubble.pdfNote ? (
            <div>
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{bubble.pdfNote.author || t("Sin autor")}</span>
                {bubble.pdfNote.at ? <span className="shrink-0 text-faint">{when(bubble.pdfNote.at)}</span> : null}
              </div>
              <p className="mt-1 max-h-60 overflow-y-auto text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                {bubble.pdfNote.body}
              </p>
              <p className="mt-1.5 text-xs text-faint">{t("Nota que trae el PDF")}</p>
            </div>
          ) : (
            bubbleNotes.map((comment) => (
              <div key={comment.id} className="group">
                <div className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{comment.author}</span>
                  <span className="shrink-0 text-faint">{when(comment.at)}</span>
                  {notes && (comment.mine || entry?.isOwner) ? (
                    <button
                      type="button"
                      aria-label={t("Borrar nota")}
                      title={t("Borrar nota")}
                      onClick={() => {
                        void deleteComment(notes.docId, notes.shareId, comment.id);
                        if (bubbleNotes.length === 1) setBubble(null);
                      }}
                      className="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-danger"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 max-h-60 overflow-y-auto text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                  {comment.body}
                </p>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function NoteComposer({
  at,
  onCancel,
  onSave,
}: {
  at: Picked;
  onCancel: () => void;
  onSave: (body: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setError("");
    const failed = await onSave(body);
    if (failed) {
      setError(failed);
      setSaving(false);
    }
  };
  return (
    <form
      data-ui="pdf-note"
      style={{ left: at.x, top: at.y }}
      className="absolute z-20 w-72 max-w-[calc(100%-2rem)] -translate-x-full space-y-2 rounded-lg border border-line bg-surface p-2.5 shadow-2xl"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="line-clamp-2 border-l-2 border-yellow-400 pl-2 text-xs text-muted">{at.anchor.exact}</p>
      <textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Solo cierra la nota, no la vista ni el modal.
            event.stopPropagation();
            onCancel();
          }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
        rows={3}
        maxLength={4000}
        aria-label={t("Escribe una nota")}
        placeholder={t("Escribe una nota…")}
        className="w-full resize-y rounded-md border border-line bg-inset px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint"
      />
      {error ? <p className="text-xs text-danger">{t(error)}</p> : null}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-2.5 text-xs text-muted hover:bg-elevated hover:text-fg">
          {t("Cancelar")}
        </button>
        <button
          type="submit"
          disabled={!draft.trim() || saving}
          className="h-8 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg disabled:opacity-40"
        >
          {t("Guardar nota")}
        </button>
      </div>
    </form>
  );
}

/** El tramo `[start, end)` del texto de una capa como `Range`. */
function rangeAt(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/** Clave de la frase de una nota: las notas sobre la misma frase se juntan. */
function anchorKey(anchor: TextAnchor): string {
  return `note#${anchor.page}:${anchor.prefix}\u0000${anchor.exact}\u0000${anchor.suffix}`;
}

function PdfPage({
  lib,
  doc,
  number,
  width,
  ratio,
  links,
  notes,
  embedded,
  targetTitle,
  onOpen,
  onBubble,
  focus,
  onFocused,
}: {
  lib: PdfJs;
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  links: ManualLink[];
  notes: DocComment[];
  embedded: EmbeddedNote[];
  targetTitle?: (id: string) => string | undefined;
  onOpen?: (targetId: string) => void;
  onBubble: (bubble: Omit<Bubble, "x" | "y">, clientX: number, clientY: number) => void;
  focus: Focus | null;
  onFocused?: () => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState({ width, height: Math.round(width * ratio) });
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [ready, setReady] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [hover, setHover] = useState<Mark | null>(null);

  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Ir a una frase o una página pedida: la página se dibuja aunque esté lejos.
  useEffect(() => {
    if (focus) {
      setVisible(true);
      pageRef.current?.scrollIntoView({ block: "start" });
    }
  }, [focus]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      const scale = width / page.getViewport({ scale: 1 }).width;
      const next = page.getViewport({ scale });
      if (cancelled) return;
      setSize({ width: Math.floor(next.width), height: Math.floor(next.height) });
      setViewport(next);
      const canvas = canvasRef.current;
      const layer = textRef.current;
      if (!canvas || !layer) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(next.width * dpr);
      canvas.height = Math.floor(next.height * dpr);
      const render = page.render({ canvas, viewport: next, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      task = render;
      layer.replaceChildren();
      layer.style.setProperty("--total-scale-factor", String(scale));
      const text = new lib.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport: next });
      await Promise.all([render.promise.catch(() => undefined), text.render()]);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, lib, number, width]);

  // Las frases vinculadas y las notas de esta página, donde estén ahora en el texto.
  const place = useCallback(() => {
    const page = pageRef.current;
    const layer = textRef.current;
    if (!page || !layer) return;
    const text = layer.textContent ?? "";
    const frame = page.getBoundingClientRect();
    const rectsOf = (anchor: TextAnchor): Rect[] | null => {
      const found = locate(text, anchor);
      const range = found ? rangeAt(layer, found.start, found.end) : null;
      if (!range) return null;
      return [...range.getClientRects()].map((rect) => ({
        x: rect.left - frame.left,
        y: rect.top - frame.top,
        width: rect.width,
        height: rect.height,
      }));
    };
    const next: Mark[] = [];
    for (const link of links) {
      if (!link.anchor) continue;
      const rects = rectsOf(link.anchor);
      if (rects) next.push({ key: linkKey(link), exact: link.anchor.exact, targetId: link.targetId, rects });
    }
    const byAnchor = new Map<string, Mark>();
    for (const note of notes) {
      const key = anchorKey(note.anchor!);
      const known = byAnchor.get(key);
      if (known) {
        known.noteIds!.push(note.id);
        continue;
      }
      const rects = rectsOf(note.anchor!);
      if (!rects) continue;
      const mark: Mark = { key, exact: note.anchor!.exact, noteIds: [note.id], rects };
      byAnchor.set(key, mark);
      next.push(mark);
    }
    setMarks(next);
  }, [links, notes]);

  useEffect(() => {
    if (ready) place();
  }, [ready, place]);

  useEffect(() => {
    if (!ready || !focus) return;
    const mark = focus.exact ? marks.find((item) => item.exact === focus.exact) : undefined;
    if (mark?.rects[0]) {
      const top = mark.rects[0].y;
      pageRef.current?.parentElement?.parentElement?.scrollBy({ top: top - 80, behavior: "smooth" });
      setFlash(mark.key);
      window.setTimeout(() => setFlash(null), 1600);
    }
    onFocused?.();
  }, [ready, focus, marks, onFocused]);

  const hit = (event: React.MouseEvent): Mark | null => {
    const frame = pageRef.current?.getBoundingClientRect();
    if (!frame) return null;
    const x = event.clientX - frame.left;
    const y = event.clientY - frame.top;
    const found = marks.filter((mark) =>
      mark.rects.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height),
    );
    // Un vínculo solo responde si se pueden abrir los destinos.
    return found.find((mark) => mark.noteIds) ?? (onOpen ? (found.find((mark) => mark.targetId) ?? null) : null);
  };

  /** Las notas del propio PDF, sobre su rectángulo en la página. */
  const badges = viewport
    ? embedded.map((note) => {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(note.rect as [number, number, number, number]);
        return { note, left: Math.min(x1!, x2!), top: Math.min(y1!, y2!) };
      })
    : [];

  return (
    <div
      ref={pageRef}
      data-page={number}
      style={{ width: size.width, height: size.height }}
      title={hover ? (hover.targetId ? (targetTitle?.(hover.targetId) ?? "") : t("Ver nota")) : undefined}
      className={`relative shrink-0 bg-white shadow-md ${hover ? "pdf-link-hover" : ""}`}
      onMouseMove={(event) => {
        const next = hit(event);
        if (next?.key !== hover?.key) setHover(next);
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(event) => {
        if (!window.getSelection()?.isCollapsed) return;
        const mark = hit(event);
        if (mark?.noteIds) onBubble({ noteIds: mark.noteIds }, event.clientX, event.clientY);
        else if (mark?.targetId && onOpen) onOpen(mark.targetId);
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <div aria-hidden className="absolute inset-0">
        {marks.flatMap((mark) =>
          mark.rects.map((rect, index) => (
            <span
              key={`${mark.key}-${index}`}
              data-ui={mark.noteIds ? "pdf-note-mark" : "pdf-link"}
              style={{ left: rect.x - 1, top: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }}
              className={`absolute rounded-sm transition-colors ${
                mark.noteIds
                  ? flash === mark.key
                    ? "bg-yellow-400/70"
                    : hover?.key === mark.key
                      ? "bg-yellow-300/60"
                      : "bg-yellow-300/40"
                  : flash === mark.key
                    ? "bg-accent/60"
                    : hover?.key === mark.key
                      ? "bg-accent/45"
                      : "bg-accent/30"
              }`}
            />
          )),
        )}
      </div>
      <div ref={textRef} data-text-layer data-page={number} className="textLayer" />
      {badges.map(({ note, left, top }) => (
        <button
          key={note.id}
          type="button"
          data-ui="pdf-embedded-note"
          aria-label={t("Nota de {name}", { name: note.author || t("Sin autor") })}
          onClick={(event) => {
            event.stopPropagation();
            onBubble({ pdfNote: note }, event.clientX, event.clientY);
          }}
          style={{ left: Math.max(0, left - 10), top: Math.max(0, top - 10) }}
          className="absolute z-10 grid size-5 place-items-center rounded-full bg-yellow-300 text-yellow-950 shadow ring-1 ring-yellow-600/40"
        >
          <MessageSquare className="size-3" />
        </button>
      ))}
    </div>
  );
}
