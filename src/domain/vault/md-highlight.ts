/**
 * Colores de sintaxis para el editor de notas (como un editor de código):
 * parte el Markdown en tramos con su tipo, línea a línea. Solo da color, no
 * cambia el texto: la suma de los tramos es siempre el texto original, para
 * que la capa coloreada quede alineada con el cuadro de texto encima.
 */

export type MdToken =
  | "text"
  | "heading"
  | "mark"
  | "quote"
  | "callout"
  | "list"
  | "task"
  | "hr"
  | "fence"
  | "code"
  | "inline-code"
  | "strong"
  | "em"
  | "strike"
  | "highlight"
  | "wiki"
  | "link"
  | "url"
  | "tag"
  | "pipe";

export type MdSpan = { text: string; token: MdToken };

const INLINE: Array<[RegExp, MdToken]> = [
  [/`[^`\n]+`/y, "inline-code"],
  [/\[\[[^\]\n]+\]\]/y, "wiki"],
  [/!?\[[^\]\n]*\]\([^)\n]*\)/y, "link"],
  [/https?:\/\/[^\s<>)\]]+/y, "url"],
  [/\*\*[^*\n]+\*\*|__[^_\n]+__/y, "strong"],
  [/~~[^~\n]+~~/y, "strike"],
  [/==[^=\n]+==/y, "highlight"],
  [/\*[^*\s\n][^*\n]*\*/y, "em"],
];

/** Tramos de un texto sin estructura de bloque (dentro de una línea). */
function inline(text: string, out: MdSpan[]): void {
  let plain = "";
  let at = 0;
  const flush = () => {
    if (plain) out.push({ text: plain, token: "text" });
    plain = "";
  };
  while (at < text.length) {
    let matched = false;
    for (const [pattern, token] of INLINE) {
      pattern.lastIndex = at;
      const hit = pattern.exec(text);
      if (hit) {
        flush();
        out.push({ text: hit[0], token });
        at += hit[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // `_énfasis_` solo entre espacios: no en nombres_con_guiones.
    if (text[at] === "_" && (at === 0 || /\s/.test(text[at - 1]!))) {
      const hit = /_[^_\s\n][^_\n]*_(?![\p{L}\d])/uy;
      hit.lastIndex = at;
      const found = hit.exec(text);
      if (found) {
        flush();
        out.push({ text: found[0], token: "em" });
        at += found[0].length;
        continue;
      }
    }
    // #etiqueta al empezar una palabra.
    if (text[at] === "#" && (at === 0 || /\s/.test(text[at - 1]!))) {
      const hit = /#[\p{L}\d_-]+/uy;
      hit.lastIndex = at;
      const found = hit.exec(text);
      if (found) {
        flush();
        out.push({ text: found[0], token: "tag" });
        at += found[0].length;
        continue;
      }
    }
    if (text[at] === "|") {
      flush();
      out.push({ text: "|", token: "pipe" });
      at += 1;
      continue;
    }
    plain += text[at];
    at += 1;
  }
  flush();
}

/** Los tramos de cada línea del texto. */
export function highlightMarkdown(source: string): MdSpan[][] {
  const lines: MdSpan[][] = [];
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    const spans: MdSpan[] = [];
    const opener = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener && opener[2]!.startsWith(fence)) {
        fence = null;
        spans.push({ text: line, token: "fence" });
      } else if (line) spans.push({ text: line, token: "code" });
      lines.push(spans);
      continue;
    }
    if (opener) {
      fence = opener[2]![0]!.repeat(3);
      spans.push({ text: line, token: "fence" });
      lines.push(spans);
      continue;
    }
    const heading = /^(#{1,6})(\s.*)?$/.exec(line);
    if (heading) {
      spans.push({ text: heading[1]!, token: "mark" });
      if (heading[2]) spans.push({ text: heading[2], token: "heading" });
      lines.push(spans);
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      lines.push([{ text: line, token: "hr" }]);
      continue;
    }
    let rest = line;
    const quote = /^(\s*>\s?)+/.exec(rest);
    if (quote) {
      spans.push({ text: quote[0], token: "quote" });
      rest = rest.slice(quote[0].length);
      const callout = /^\[![\w-]+\][+-]?/.exec(rest);
      if (callout) {
        spans.push({ text: callout[0], token: "callout" });
        rest = rest.slice(callout[0].length);
      }
    }
    const list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(rest);
    if (list) {
      if (list[1]) spans.push({ text: list[1], token: "text" });
      spans.push({ text: list[2]!, token: "list" });
      spans.push({ text: list[3]!, token: "text" });
      rest = rest.slice(list[0].length);
      const task = /^\[[ xX]\]/.exec(rest);
      if (task) {
        spans.push({ text: task[0], token: "task" });
        rest = rest.slice(task[0].length);
      }
    }
    inline(rest, spans);
    lines.push(spans);
  }
  return lines;
}
