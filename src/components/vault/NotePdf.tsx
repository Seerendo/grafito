import { useEffect, useRef, useState } from "react";
import { useVault } from "@/app/vault/store";
import { MarkdownView } from "./MarkdownView";

type PdfJob = { title: string; content: string };

type Handler = (job: PdfJob) => void;

let handler: Handler | null = null;

export function requestNotePdf(job: PdfJob) {
  handler?.(job);
}

function bindNotePdf(next: Handler) {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

function fileName(title: string) {
  const clean = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "nota";
  return `${clean}.pdf`;
}

const BAKED = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textDecorationLine",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderRadius",
  "display",
  "width",
  "maxWidth",
  "whiteSpace",
] as const;

function bakeStyles(root: HTMLElement) {
  const nodes = [root, ...root.querySelectorAll<HTMLElement>("*")];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    for (const prop of BAKED) {
      const value = style[prop];
      if (!value) continue;
      node.style[prop] = value;
    }
  }
}
  function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("svg"));
    image.src = src;
  });
}

async function rasterizeSvgs(root: HTMLElement) {
  const svgs = [...root.querySelectorAll("svg")];
  for (const svg of svgs) {
    try {
      const box = svg.getBoundingClientRect();
      const width = Math.max(1, Math.round(box.width));
      const height = Math.max(1, Math.round(box.height));
      if (width < 2 || height < 2) continue;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(width));
      clone.setAttribute("height", String(height));
      const xml = new XMLSerializer().serializeToString(clone);
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = document.createElement("img");
      png.alt = "";
      png.src = canvas.toDataURL("image/png");
      png.width = width;
      png.height = height;
      png.style.width = `${width}px`;
      png.style.height = `${height}px`;
      svg.replaceWith(png);
    } catch {
      // Si el SVG no se puede rasterizar, html2canvas intenta el original.
    }
  }
}

async function canvasToPdf(canvas: HTMLCanvasElement, title: string) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 28;
  const usable = pageWidth - margin * 2;
  const imgHeight = (canvas.height * usable) / canvas.width;
  const img = canvas.toDataURL("image/png");
  let heightLeft = imgHeight;
  let position = margin;
  pdf.addImage(img, "PNG", margin, position, usable, imgHeight);
  heightLeft -= pageHeight - margin * 2;
  while (heightLeft > 8) {
    position = margin - (imgHeight - heightLeft);
    pdf.addPage();
    pdf.addImage(img, "PNG", margin, position, usable, imgHeight);
    heightLeft -= pageHeight - margin * 2;
  }
  pdf.save(fileName(title));
}

export function NotePdfHost() {
  const documents = useVault((state) => state.documents);
  const [job, setJob] = useState<(PdfJob & { id: number }) | null>(null);
  const [notice, setNotice] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);
  const jobId = job?.id ?? 0;

  useEffect(() => bindNotePdf((next) => setJob({ ...next, id: Date.now() })), []);

  useEffect(() => {
    if (!job) return;
    let cancel = false;
    setNotice("Preparando PDF…");
    const run = async () => {
      const root = sheetRef.current;
      if (!root) return;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (cancel) return;
        if (!root.querySelector("[data-mermaid-status='pending']")) break;
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      if (cancel || !sheetRef.current) return;
      try {
        if (document.fonts?.ready) await document.fonts.ready;
        await rasterizeSvgs(sheetRef.current);
        bakeStyles(sheetRef.current);
        const html2canvas = (await import("html2canvas")).default;
        const canvas = await html2canvas(sheetRef.current, {
          backgroundColor: "#ffffff",
          scale: 2,
          windowWidth: 760,
          logging: false,
        });
        if (cancel) return;
        await canvasToPdf(canvas, job.title);
        if (!cancel) setNotice("");
      } catch {
        if (!cancel) setNotice("No se pudo crear el PDF.");
      } finally {
        if (!cancel) setJob(null);
      }
    };
    void run();
    return () => {
      cancel = true;
    };
  }, [jobId, job]);

  useEffect(() => {
    if (!notice || notice === "Preparando PDF…") return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <>
      {notice ? (
        <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-surface px-4 py-2 text-sm text-fg shadow-2xl">
          {notice}
        </p>
      ) : null}
      {job ? (
        <div className="pdf-host" aria-hidden>
          <div ref={sheetRef} className="pdf-sheet">
            <h1 className="pdf-title">{job.title}</h1>
            <MarkdownView
              source={job.content}
              title={job.title}
              variant="print"
              noteExists={(name) => documents.some((item) => item.title.toLowerCase() === name.toLowerCase())}
              onWiki={() => undefined}
              onTag={() => undefined}
              onToggleTask={() => undefined}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
