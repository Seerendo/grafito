import { Download, Play, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/app/i18n";
import { usePluginEnabled } from "@/app/plugins";
import { compileLatexDoc, readLatex, saveLatex } from "@/server/latex.functions";
import { PdfView } from "./PdfView";

/**
 * LaTeX document: the source on the left, the compiled PDF on the right. Ctrl+S saves a new
 * version and compiles; «Compilar» compiles what is on screen without saving.
 */
export function LatexView({
  docId,
  shareId,
  canEdit,
  title,
  onSaved,
}: {
  docId: string;
  shareId?: string;
  canEdit: boolean;
  title: string;
  onSaved?: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ error: string; log: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const urlRef = useRef<string | null>(null);
  // Off or its service down: the source still opens and saves; compiling waits.
  const latexOn = usePluginEnabled("latex");
  const latexOnRef = useRef(latexOn);
  latexOnRef.current = latexOn;
  const scope = shareId ? { shareId } : {};

  const showPdf = (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    // The preview reads the bytes; the object URL only serves «Descargar PDF».
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setPdfBytes(bytes);
    setPdfUrl(url);
  };

  const compile = useCallback(
    async (text: string) => {
      setCompiling(true);
      try {
        const result = await compileLatexDoc({ data: { docId, source: text, ...scope } });
        if (result.ok) {
          setProblem(null);
          showPdf(result.pdf);
        } else setProblem({ error: result.error, log: result.log });
      } catch {
        setProblem({ error: "El compilador de LaTeX no está disponible.", log: "" });
      } finally {
        setCompiling(false);
      }
    },
    // scope is derived from shareId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId, shareId],
  );

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setLoadError("");
    void readLatex({ data: { docId, ...scope } })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setLoadError(result.error);
          return;
        }
        setSource(result.content);
        setSaved(result.content);
        if (latexOnRef.current) void compile(result.content);
      })
      .catch(() => {
        if (!cancelled) setLoadError("No se pudo abrir el documento.");
      });
    return () => {
      cancelled = true;
    };
    // scope is derived from shareId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shareId, compile]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const save = async () => {
    if (source === null || !canEdit) return;
    setSaving(true);
    try {
      const result = await saveLatex({ data: { docId, content: source, ...scope } });
      if (!result.ok) setProblem({ error: result.error, log: "" });
      else {
        setSaved(source);
        onSaved?.();
      }
    } finally {
      setSaving(false);
    }
    if (latexOn) void compile(source);
  };

  if (loadError) return <p className="p-6 text-sm text-danger">{t(loadError)}</p>;
  if (source === null) return <p className="p-6 text-sm text-faint">{t("Cargando…")}</p>;
  const dirty = source !== saved;

  return (
    <div data-ui="latex" className="flex min-h-[70vh] flex-col gap-3 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            <Save className="size-4" />
            {saving ? t("Guardando…") : t("Guardar")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void compile(source)}
          disabled={compiling || !latexOn}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-elevated disabled:opacity-50"
        >
          <Play className="size-4" />
          {compiling ? t("Compilando…") : t("Compilar")}
        </button>
        {pdfUrl ? (
          <a
            href={pdfUrl}
            download={`${title || "documento"}.pdf`}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-elevated"
          >
            <Download className="size-4" />
            {t("Descargar PDF")}
          </a>
        ) : null}
        {dirty ? <span className="text-xs text-faint">{t("Cambios sin guardar")}</span> : null}
      </div>
      {problem ? (
        <div data-ui="latex-error" className="rounded-md border border-danger/40 p-3 text-sm">
          <p className="text-danger">{t(problem.error)}</p>
          {problem.log ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">{t("Ver registro de LaTeX")}</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-faint">
                {problem.log.slice(-6000)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <textarea
          aria-label={t("Código LaTeX")}
          value={source}
          readOnly={!canEdit}
          spellCheck={false}
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
          className="min-h-[50vh] w-full resize-none rounded-md border border-line bg-inset p-3 font-mono text-sm text-fg lg:min-h-0"
        />
        <div className="min-h-[50vh] overflow-auto rounded-md border border-line lg:min-h-0">
          {pdfUrl && pdfBytes ? (
            <PdfView key={pdfUrl} url={pdfUrl} data={pdfBytes} title={title} />
          ) : (
            <p className="p-6 text-sm text-faint">
              {compiling
                ? t("Compilando…")
                : latexOn
                  ? t("Sin PDF todavía.")
                  : t("La extensión LaTeX está en pausa.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
