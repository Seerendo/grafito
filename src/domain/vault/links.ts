import type { Document } from "./types";

const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;

export function extractWikiLinks(content: string): string[] {
  const stripped = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(WIKI)) {
    const title = match[1]?.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

export function extractTags(content: string): string[] {
  const stripped = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const tags: string[] = [];
  const seen = new Set<string>();
  const re = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;
  for (const match of stripped.matchAll(re)) {
    const tag = match[2];
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function extractHeadings(content: string): { level: number; text: string; id: string }[] {
  const headings: { level: number; text: string; id: string }[] = [];
  let inCode = false;
  let index = 0;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    headings.push({ level: match[1].length, text: match[2].trim(), id: `h-${index}` });
    index += 1;
  }
  return headings;
}

export function findByTitle(documents: Document[], title: string): Document | undefined {
  const key = title.trim().toLowerCase();
  return documents.find((document) => document.title.toLowerCase() === key);
}

export function replaceWikiTitle(content: string, from: string, to: string): string {
  if (from === to) return content;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`\\[\\[${esc}(\\s*(?:#[^\\]|]*)?(?:\\|[^\\]]*)?)\\]\\]`, "gi"),
    (_match, rest: string) => `[[${to}${rest}]]`,
  );
}

export function unclosedWiki(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const slice = before.slice(open + 2);
  if (slice.includes("]]") || slice.includes("\n") || slice.includes("|")) return null;
  return { query: slice, start: open };
}

export function wordCount(content: string): number {
  const text = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]|]/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function readingLabel(words: number): string {
  if (words < 40) return "menos de 1 min";
  const minutes = Math.max(1, Math.round(words / 200));
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

export function backlinkLine(content: string, title: string): string {
  const key = title.toLowerCase();
  const line = content.split("\n").find((row) =>
    extractWikiLinks(row).some((item) => item.toLowerCase() === key),
  );
  return (line ?? "").replace(/^>\s?/, "").trim();
}
