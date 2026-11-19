/**
 * LaTeX documents are .tex files in the vault: they are shared, versioned and linked like other
 * files. LatexView edits the source and shows the PDF compiled by the latex service.
 */

export const LATEX_EXTENSION = ".tex";
export const LATEX_MIME = "application/x-tex";
/** Largest source the compiler accepts (docker/latex/server.py). */
export const LATEX_MAX_BYTES = 2 * 1024 * 1024;

export function isLatexName(name: string): boolean {
  return /\.tex$/i.test(name);
}

/** Starting document: an article in Spanish with the packages most documents need. */
export function latexTemplate(title: string): string {
  const safe = title.replace(/[\\{}$&#^_%~]/g, "").trim() || "Documento";
  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[spanish]{babel}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{${safe}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introducción}
Escribe aquí. Las fórmulas van entre \\verb|$...$|, por ejemplo $E = mc^2$, o en bloque:
\\[
  \\int_0^1 x^2\\,dx = \\frac{1}{3}
\\]

\\end{document}
`;
}
