import { Info, Lightbulb, Quote, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { MermaidDiagram } from "./MermaidDiagram";
import { usePluginEnabled } from "@/app/plugins";
import { t } from "@/app/i18n";

type InlineCtx = {
  onWiki: (title: string) => void;
  onTag: (tag: string) => void;
  noteExists: (title: string) => boolean;
};

type ListItem = { text: string; line: number; task?: boolean; checked?: boolean };

type Block =
  | { type: "fm"; lines: string[] }
  | { type: "h"; level: number; text: string; id: string }
  | { type: "p"; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; lines: string[]; callout?: { kind: string; title?: string } }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "ul"; items: ListItem[] }
  | { type: "ol"; items: ListItem[] };

function splitRow(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  let headingIndex = 0;
  if (lines[0]?.trim() === "---") {
    const matter: string[] = [];
    let cursor = 1;
    while (cursor < lines.length && lines[cursor]?.trim() !== "---") {
      matter.push(lines[cursor] ?? "");
      cursor += 1;
    }
    if (cursor < lines.length) {
      blocks.push({ type: "fm", lines: matter });
      index = cursor + 1;
    }
  }
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        buf.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({
        type: "h",
        level: heading[1].length,
        text: heading[2].trim(),
        id: `h-${headingIndex}`,
      });
      headingIndex += 1;
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      const call = /^\[!([a-zA-Z]+)\]\s*(.*)$/.exec(quoteLines[0] ?? "");
      if (call?.[1]) {
        blocks.push({
          type: "quote",
          callout: { kind: call[1].toLowerCase(), title: call[2]?.trim() || undefined },
          lines: quoteLines.slice(1),
        });
      } else {
        blocks.push({ type: "quote", lines: quoteLines });
      }
      continue;
    }
    if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[index + 1] ?? "")) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
        rows.push(splitRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        const raw = (lines[index] ?? "").replace(/^\s*[-*]\s+/, "");
        const task = /^\[( |x|X)\]\s*(.*)$/.exec(raw);
        if (task) {
          items.push({
            text: task[2] ?? "",
            task: true,
            checked: task[1]?.toLowerCase() === "x",
            line: index,
          });
        } else {
          items.push({ text: raw, line: index });
        }
        index += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push({ text: (lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""), line: index });
        index += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const para = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (
        next.trim() === "" ||
        next.startsWith("```") ||
        next.startsWith(">") ||
        /^(#{1,3})\s+/.test(next) ||
        /^(-{3,}|\*{3,})$/.test(next.trim()) ||
        /^\s*[-*]\s+/.test(next) ||
        /^\s*\d+\.\s+/.test(next) ||
        /^\s*\|/.test(next)
      ) {
        break;
      }
      para.push(next);
      index += 1;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

function renderInline(text: string, ctx: InlineCtx, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let index = 0;
  let serial = 0;
  const flush = () => {
    if (!buf) return;
    out.push(buf);
    buf = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };
  while (index < text.length) {
    const rest = text.slice(index);
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        push(
          <code key={`${key}-c${serial++}`} className="rounded-sm bg-inset px-1.5 py-0.5 font-mono text-sm text-accent">
            {text.slice(index + 1, end)}
          </code>,
        );
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", index + 2);
      if (end !== -1) {
        push(
          <strong key={`${key}-b${serial++}`} className="font-semibold">
            {renderInline(text.slice(index + 2, end), ctx, `${key}b${serial}`)}
          </strong>,
        );
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const end = text.indexOf("~~", index + 2);
      if (end !== -1) {
        push(
          <del key={`${key}-d${serial++}`} className="text-muted">
            {renderInline(text.slice(index + 2, end), ctx, `${key}d${serial}`)}
          </del>,
        );
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith("==")) {
      const end = text.indexOf("==", index + 2);
      if (end !== -1) {
        push(
          <mark key={`${key}-m${serial++}`} className="rounded-sm bg-accent/25 px-1 text-fg">
            {renderInline(text.slice(index + 2, end), ctx, `${key}m${serial}`)}
          </mark>,
        );
        index = end + 2;
        continue;
      }
    }
    if (rest.startsWith("*") && !rest.startsWith("**")) {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        push(<em key={`${key}-i${serial++}`}>{renderInline(text.slice(index + 1, end), ctx, `${key}i${serial}`)}</em>);
        index = end + 1;
        continue;
      }
    }
    if (rest.startsWith("[[")) {
      const end = text.indexOf("]]", index + 2);
      if (end !== -1) {
        const inner = text.slice(index + 2, end);
        const pipe = inner.indexOf("|");
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).split("#")[0]?.trim() ?? "";
        const label = (pipe === -1 ? target : inner.slice(pipe + 1).trim()) || target;
        if (target) {
          const exists = ctx.noteExists(target);
          push(
            <button
              key={`${key}-w${serial++}`}
              type="button"
              onClick={() => ctx.onWiki(target)}
              className={
                exists
                  ? "font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
                  : "text-muted underline decoration-dashed underline-offset-4 hover:text-fg"
              }
            >
              {label}
            </button>,
          );
          index = end + 2;
          continue;
        }
      }
    }
    if (rest.startsWith("[")) {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/.exec(rest);
      if (link?.[1] && link[2]) {
        push(
          <a
            key={`${key}-a${serial++}`}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-4"
          >
            {link[1]}
          </a>,
        );
        index += link[0].length;
        continue;
      }
    }
    const prev = index === 0 ? "" : text[index - 1];
    if (rest.startsWith("#") && (index === 0 || /[\s([{"']/.test(prev ?? ""))) {
      const tag = /^#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/u.exec(rest);
      if (tag?.[1]) {
        const name = tag[1];
        push(
          <button key={`${key}-g${serial++}`} type="button" onClick={() => ctx.onTag(name)} className="text-accent hover:text-fg">
            #{name}
          </button>,
        );
        index += tag[0].length;
        continue;
      }
    }
    buf += text[index];
    index += 1;
  }
  flush();
  return out;
}

function CalloutIcon({ kind }: { kind: string }) {
  const className = "size-4 shrink-0 text-accent";
  if (kind === "idea") return <Lightbulb className={className} />;
  if (kind === "warning") return <TriangleAlert className="size-4 shrink-0 text-danger" />;
  if (kind === "quote") return <Quote className={className} />;
  return <Info className={className} />;
}

const headingClass: Record<number, string> = {
  1: "mt-4 font-serif text-xl font-semibold tracking-tight",
  2: "mt-4 font-serif text-lg font-semibold tracking-tight",
  3: "mt-3 font-serif text-base font-semibold",
};

export function MarkdownView({
  source,
  title,
  onWiki,
  onTag,
  noteExists,
  onToggleTask,
  variant = "app",
}: {
  source: string;
  title: string;
  onWiki: (title: string) => void;
  onTag: (tag: string) => void;
  noteExists: (title: string) => boolean;
  /** Sin él, las casillas se muestran pero no se pueden marcar. */
  onToggleTask?: (line: number) => void;
  variant?: "app" | "print";
}) {
  const mermaidOn = usePluginEnabled("mermaid");
  const ctx: InlineCtx = { onWiki, onTag, noteExists };
  const blocks = parseBlocks(source);
  let hidTitle = false;
  return (
    <article id="note-top" className="mx-auto max-w-2xl px-4 py-3 font-serif text-sm leading-normal text-fg sm:px-5">
      {blocks.map((block, index) => {
        if (block.type === "fm") {
          const pairs = block.lines
            .map((line) => {
              const split = line.indexOf(":");
              if (split < 1) return null;
              return { key: line.slice(0, split).trim(), value: line.slice(split + 1).trim() };
            })
            .filter((pair): pair is { key: string; value: string } => Boolean(pair?.key));
          if (pairs.length === 0) return null;
          return (
            <div key={`fm-${index}`} className="mb-3 flex flex-wrap gap-2 font-sans">
              {pairs.map((pair) => (
                <span key={pair.key} className="rounded-full bg-elevated px-3 py-1 text-xs text-muted">
                  <span className="text-faint">{pair.key}</span> {pair.value}
                </span>
              ))}
            </div>
          );
        }
        if (block.type === "h") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          if (!hidTitle && block.level === 1 && block.text.toLowerCase() === title.trim().toLowerCase()) {
            hidTitle = true;
            return <span key={block.id} id={block.id} className="block h-0 overflow-hidden" />;
          }
          return (
            <Tag key={block.id} id={block.id} className={headingClass[block.level] ?? headingClass[3]}>
              {renderInline(block.text, ctx, block.id)}
            </Tag>
          );
        }
        if (block.type === "p") {
          return (
            <p key={`p-${index}`} className="mt-2">
              {renderInline(block.text, ctx, `p${index}`)}
            </p>
          );
        }
        if (block.type === "hr") return <hr key={`hr-${index}`} className="my-4 border-line" />;
        if (block.type === "code") {
          if (block.lang.toLowerCase() === "mermaid" && (mermaidOn || variant === "print")) {
            return <MermaidDiagram key={`code-${index}`} chart={block.text} variant={variant} />;
          }
          return (
            <figure key={`code-${index}`} className="mt-3 overflow-hidden rounded-lg bg-inset font-sans">
              {block.lang ? <figcaption className="border-b border-line px-3 py-1.5 text-xs text-faint">{block.lang}</figcaption> : null}
              <pre className="overflow-x-auto p-3 font-mono text-xs leading-normal">
                <code>{block.text}</code>
              </pre>
            </figure>
          );
        }
        if (block.type === "quote") {
          if (block.callout) {
            const tone = block.callout.kind === "warning" ? "border-danger" : "border-accent";
            return (
              <aside key={`q-${index}`} className={`mt-3 rounded-lg border border-line border-l-4 ${tone} bg-elevated px-3 py-2 font-sans`}>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalloutIcon kind={block.callout.kind} />
                  <span>{block.callout.title || block.callout.kind}</span>
                </div>
                {block.lines.length > 0 ? (
                  <div className="mt-1 font-serif text-sm leading-normal text-muted">
                    {block.lines.map((line, lineIndex) => (
                      <p key={lineIndex} className={lineIndex > 0 ? "mt-2" : undefined}>
                        {renderInline(line, ctx, `q${index}-${lineIndex}`)}
                      </p>
                    ))}
                  </div>
                ) : null}
              </aside>
            );
          }
          return (
            <blockquote key={`q-${index}`} className="mt-3 border-l-2 border-line pl-3 text-muted italic">
              {block.lines.map((line, lineIndex) => (
                <p key={lineIndex} className={lineIndex > 0 ? "mt-2" : undefined}>
                  {renderInline(line, ctx, `bq${index}-${lineIndex}`)}
                </p>
              ))}
            </blockquote>
          );
        }
        if (block.type === "table") {
          return (
            <div key={`t-${index}`} className="mt-3 overflow-x-auto font-sans">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex} className="border-b border-line px-2 py-1.5 font-medium text-muted">
                        {renderInline(cell, ctx, `th${index}-${cellIndex}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="border-b border-line px-2 py-1.5 align-top">
                          {renderInline(cell, ctx, `td${index}-${rowIndex}-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={`ol-${index}`} className="mt-2 list-decimal space-y-1 pl-5">
              {block.items.map((item) => (
                <li key={item.line} className="pl-1">
                  {renderInline(item.text, ctx, `ol${item.line}`)}
                </li>
              ))}
            </ol>
          );
        }
        return (
          <ul key={`ul-${index}`} className="mt-2 space-y-0.5 font-sans">
            {block.items.map((item) =>
              item.task ? (
                <li key={item.line} className="flex items-start gap-1">
                  <button
                    type="button"
                    aria-label={item.checked ? t("Marcar como pendiente") : t("Marcar como hecha")}
                    disabled={!onToggleTask}
                    onClick={() => onToggleTask?.(item.line)}
                    className="grid h-11 w-11 shrink-0 place-items-center disabled:cursor-default"
                  >
                    <span
                      className={`grid size-5 place-items-center rounded-sm border ${item.checked ? "border-accent bg-accent text-accent-fg" : "border-line"}`}
                    >
                      {item.checked ? (
                        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 8.5 6.2 12 13 4" />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                  <span className={`pt-2.5 ${item.checked ? "text-muted line-through" : ""}`}>
                    {renderInline(item.text, ctx, `task${item.line}`)}
                  </span>
                </li>
              ) : (
                <li key={item.line} className="flex gap-2 py-0.5">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-faint" />
                  <span>{renderInline(item.text, ctx, `li${item.line}`)}</span>
                </li>
              ),
            )}
          </ul>
        );
      })}
    </article>
  );
}
