import { Link2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { anchorAt, linkKey, locate, type TextAnchor } from "@/domain/vault/anchor";
import type { ManualLink } from "@/domain/vault/types";
import { t } from "@/app/i18n";

/**
 * Visor de PDF propio (PDF.js), en vez del del navegador: deja seleccionar una
 * palabra o frase y vincularla con una nota u otro archivo (`onLink`). Las
 * frases ya vinculadas se ven resaltadas y abren su destino (`onOpen`).
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
type Mark = { key: string; targetId: string; rects: Rect[] };
type Picked = { anchor: TextAnchor; x: number; y: number };

export function PdfView({
  url,
  title,
  links = [],
  targetTitle,
  onLink,
  onOpen,
  focus,
  onFocused,
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<{ lib: PdfJs; doc: PDFDocumentProxy; ratio: number } | null>(null);
  const [error, setError] = useState(false);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(false);
    void (async () => {
      try {
        const lib = await loadPdfJs();
        doc = await lib.getDocument({ url, useSystemFonts: true }).promise;
        const first = await doc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setPdf({ lib, doc, ratio: base.height / base.width });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url]);

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

  // Una frase seleccionada dentro de una página: el botón «Vincular» a su lado.
  useEffect(() => {
    if (!onLink) return;
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
  }, [onLink]);

  if (error) return <p className="text-sm text-danger">{t("No se pudo abrir el PDF.")}</p>;

  return (
    <div
      ref={scrollRef}
      data-ui="pdf"
      aria-label={title}
      className="relative h-full min-h-[60vh] overflow-auto rounded-md border border-line bg-inset p-4"
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
              targetTitle={targetTitle}
              onOpen={onOpen}
              focus={focus?.page === index + 1 ? focus : null}
              onFocused={onFocused}
            />
          ))}
        </div>
      )}
      {picked && onLink ? (
        <button
          type="button"
          // Antes de que el clic deshaga la selección.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onLink(picked.anchor);
            window.getSelection()?.removeAllRanges();
            setPicked(null);
          }}
          style={{ left: picked.x, top: picked.y }}
          className="absolute z-10 inline-flex h-8 -translate-x-full items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg shadow-lg"
        >
          <Link2 className="size-3.5" />
          {t("Vincular selección")}
        </button>
      ) : null}
    </div>
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

function PdfPage({
  lib,
  doc,
  number,
  width,
  ratio,
  links,
  targetTitle,
  onOpen,
  focus,
  onFocused,
}: {
  lib: PdfJs;
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  links: ManualLink[];
  targetTitle?: (id: string) => string | undefined;
  onOpen?: (targetId: string) => void;
  focus: TextAnchor | null;
  onFocused?: () => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState({ width, height: Math.round(width * ratio) });
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

  // Ir a una frase pedida: la página se dibuja aunque esté lejos.
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
      const viewport = page.getViewport({ scale });
      if (cancelled) return;
      setSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
      const canvas = canvasRef.current;
      const layer = textRef.current;
      if (!canvas || !layer) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const render = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      task = render;
      layer.replaceChildren();
      layer.style.setProperty("--total-scale-factor", String(scale));
      const text = new lib.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport });
      await Promise.all([render.promise.catch(() => undefined), text.render()]);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, lib, number, width]);

  // Las frases vinculadas de esta página, donde estén ahora en el texto.
  const place = useCallback(() => {
    const page = pageRef.current;
    const layer = textRef.current;
    if (!page || !layer) return;
    const text = layer.textContent ?? "";
    const frame = page.getBoundingClientRect();
    const next: Mark[] = [];
    for (const link of links) {
      if (!link.anchor) continue;
      const found = locate(text, link.anchor);
      const range = found ? rangeAt(layer, found.start, found.end) : null;
      if (!range) continue;
      const rects = [...range.getClientRects()].map((rect) => ({
        x: rect.left - frame.left,
        y: rect.top - frame.top,
        width: rect.width,
        height: rect.height,
      }));
      next.push({ key: linkKey(link), targetId: link.targetId, rects });
    }
    setMarks(next);
  }, [links]);

  useEffect(() => {
    if (ready) place();
  }, [ready, place]);

  useEffect(() => {
    if (!ready || !focus) return;
    const key = marks.find((mark) => links.some((link) => link.anchor && linkKey(link) === mark.key && link.anchor.exact === focus.exact))?.key;
    const mark = marks.find((item) => item.key === key);
    if (mark?.rects[0]) {
      const top = mark.rects[0].y;
      pageRef.current?.parentElement?.parentElement?.scrollBy({ top: top - 80, behavior: "smooth" });
      setFlash(mark.key);
      window.setTimeout(() => setFlash(null), 1600);
    }
    onFocused?.();
  }, [ready, focus, marks, links, onFocused]);

  const hit = (event: React.MouseEvent): Mark | null => {
    const frame = pageRef.current?.getBoundingClientRect();
    if (!frame) return null;
    const x = event.clientX - frame.left;
    const y = event.clientY - frame.top;
    return marks.find((mark) => mark.rects.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)) ?? null;
  };

  return (
    <div
      ref={pageRef}
      data-page={number}
      style={{ width: size.width, height: size.height }}
      title={hover ? (targetTitle?.(hover.targetId) ?? "") : undefined}
      className={`relative shrink-0 bg-white shadow-md ${hover ? "pdf-link-hover" : ""}`}
      onMouseMove={(event) => {
        const next = onOpen ? hit(event) : null;
        if (next?.key !== hover?.key) setHover(next);
      }}
      onMouseLeave={() => setHover(null)}
      onClick={(event) => {
        if (!onOpen || !window.getSelection()?.isCollapsed) return;
        const mark = hit(event);
        if (mark) onOpen(mark.targetId);
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <div aria-hidden className="absolute inset-0">
        {marks.flatMap((mark) =>
          mark.rects.map((rect, index) => (
            <span
              key={`${mark.key}-${index}`}
              data-ui="pdf-link"
              style={{ left: rect.x - 1, top: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }}
              className={`absolute rounded-sm transition-colors ${
                flash === mark.key ? "bg-accent/60" : hover?.key === mark.key ? "bg-accent/45" : "bg-accent/30"
              }`}
            />
          )),
        )}
      </div>
      <div ref={textRef} data-text-layer data-page={number} className="textLayer" />
    </div>
  );
}
