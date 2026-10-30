/**
 * Fórmulas de una fila (fase 3). Solo leen otras columnas de la misma fila.
 * No es JavaScript: un puñado de operaciones y funciones, para que el servidor
 * pueda calcularlas sin `eval`. Sin `@/` en los imports: se prueba con
 * `node --test`.
 *
 *   {Precio} * {Cantidad}
 *   si({Hecho}, "sí", "pendiente")
 *   redondear({Precio} * 1.21, 2)
 *   dias({Inicio}, hoy())
 */

import type { CellValue, TableField } from "./table.ts";

export const MAX_FORMULA = 500;

export type FormulaValue = string | number | boolean | null;

export type FormulaRun = {
  values: Record<string, FormulaValue>;
  errors: Record<string, string>;
};

type Val = { t: "n"; n: number } | { t: "s"; s: string } | { t: "b"; b: boolean } | { t: "z" };

type Expr =
  | { k: "num"; n: number }
  | { k: "str"; s: string }
  | { k: "col"; name: string }
  | { k: "un"; op: "-" | "no"; a: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "call"; name: string; args: Expr[] };

type Tok =
  | { k: "num"; n: number }
  | { k: "str"; s: string }
  | { k: "id"; s: string }
  | { k: "col"; s: string }
  | { k: "op"; s: string }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "comma" }
  | { k: "end" };

const FUNCS = new Set(["si", "redondear", "vacio", "hoy", "dias", "largo", "contiene"]);

function fail(code: string): never {
  throw new Error(code);
}

function tokenize(input: string): Tok[] {
  const tokens: Tok[] = [];
  const source = input.trim();
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\n" || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "{") {
      const end = source.indexOf("}", index + 1);
      if (end < 0) fail("syntax");
      const name = source.slice(index + 1, end).trim();
      if (!name || name.length > 120) fail("syntax");
      tokens.push({ k: "col", s: name });
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      let text = "";
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === "\\" && cursor + 1 < source.length) {
          text += source[cursor + 1];
          cursor += 2;
          continue;
        }
        text += source[cursor];
        cursor += 1;
      }
      if (source[cursor] !== '"') fail("syntax");
      tokens.push({ k: "str", s: text.slice(0, 2000) });
      index = cursor + 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ k: "lp" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ k: "rp" });
      index += 1;
      continue;
    }
    if (char === ",") {
      tokens.push({ k: "comma" });
      index += 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === "!=" || pair === "<>" || pair === "<=" || pair === ">=") {
      tokens.push({ k: "op", s: pair === "<>" ? "!=" : pair });
      index += 2;
      continue;
    }
    if ("+-*/&=<>".includes(char)) {
      tokens.push({ k: "op", s: char });
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[0-9.]/.test(source[cursor]!)) cursor += 1;
      const number = Number(source.slice(index, cursor));
      if (!Number.isFinite(number)) fail("syntax");
      tokens.push({ k: "num", n: number });
      index = cursor;
      continue;
    }
    if (/\p{L}/u.test(char) || char === "_") {
      let cursor = index + 1;
      while (cursor < source.length && /[\p{L}\p{N}_]/u.test(source[cursor]!)) cursor += 1;
      tokens.push({ k: "id", s: source.slice(index, cursor).toLowerCase() });
      index = cursor;
      continue;
    }
    fail("syntax");
  }
  tokens.push({ k: "end" });
  if (tokens.length > 200) fail("limit");
  return tokens;
}

function parse(input: string): Expr {
  const tokens = tokenize(input);
  let index = 0;
  const peek = () => tokens[index] ?? { k: "end" as const };
  const take = () => tokens[index++] ?? { k: "end" as const };

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (peek().k === "id" && peek().k === "id" && (peek() as { s: string }).s === "o") {
      take();
      left = { k: "bin", op: "o", a: left, b: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Expr => {
    let left = parseCmp();
    while (peek().k === "id" && (peek() as { s: string }).s === "y") {
      take();
      left = { k: "bin", op: "y", a: left, b: parseCmp() };
    }
    return left;
  };
  const parseCmp = (): Expr => {
    const left = parseAdd();
    const token = peek();
    if (token.k === "op" && ["=", "!=", "<", ">", "<=", ">="].includes(token.s)) {
      take();
      return { k: "bin", op: token.s, a: left, b: parseAdd() };
    }
    return left;
  };
  const parseAdd = (): Expr => {
    let left = parseMul();
    while (peek().k === "op" && (peek() as { s: string }).s && "+-&".includes((peek() as { s: string }).s) && (peek() as { s: string }).s !== "") {
      const op = (take() as { s: string }).s;
      if (!"+-&".includes(op)) break;
      left = { k: "bin", op, a: left, b: parseMul() };
    }
    return left;
  };
  const parseMul = (): Expr => {
    let left = parseUnary();
    while (peek().k === "op" && "*/".includes((peek() as { s: string }).s)) {
      const op = (take() as { s: string }).s;
      left = { k: "bin", op, a: left, b: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Expr => {
    if (peek().k === "op" && (peek() as { s: string }).s === "-") {
      take();
      return { k: "un", op: "-", a: parseUnary() };
    }
    if (peek().k === "id" && (peek() as { s: string }).s === "no") {
      take();
      return { k: "un", op: "no", a: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): Expr => {
    const token = take();
    if (token.k === "num") return { k: "num", n: token.n };
    if (token.k === "str") return { k: "str", s: token.s };
    if (token.k === "col") return { k: "col", name: token.s };
    if (token.k === "lp") {
      const inner = parseOr();
      if (take().k !== "rp") fail("syntax");
      return inner;
    }
    if (token.k === "id") {
      if (!FUNCS.has(token.s) || peek().k !== "lp") fail("syntax");
      take();
      const args: Expr[] = [];
      if (peek().k !== "rp") {
        args.push(parseOr());
        while (peek().k === "comma") {
          take();
          args.push(parseOr());
        }
      }
      if (take().k !== "rp") fail("syntax");
      if (args.length > 8) fail("arity");
      return { k: "call", name: token.s, args };
    }
    fail("syntax");
  };

  const expr = parseOr();
  if (peek().k !== "end") fail("syntax");
  return expr;
}

function fromCell(value: CellValue | undefined): Val {
  if (value === null || value === undefined || Array.isArray(value)) return { t: "z" };
  if (typeof value === "number") return Number.isFinite(value) ? { t: "n", n: value } : { t: "z" };
  if (typeof value === "boolean") return { t: "b", b: value };
  return { t: "s", s: value };
}

function asString(value: Val): string {
  if (value.t === "s") return value.s;
  if (value.t === "n") return String(value.n);
  if (value.t === "b") return value.b ? "sí" : "";
  return "";
}

function asNumber(value: Val): number {
  if (value.t === "n") return value.n;
  if (value.t === "b") return value.b ? 1 : 0;
  if (value.t === "z") return 0;
  const number = Number(value.s.trim().replace(",", "."));
  if (!Number.isFinite(number)) fail("nan");
  return number;
}

function truthy(value: Val): boolean {
  if (value.t === "b") return value.b;
  if (value.t === "n") return value.n !== 0;
  if (value.t === "s") return value.s.trim() !== "";
  return false;
}

function numericLike(value: Val): boolean {
  if (value.t === "n" || value.t === "b" || value.t === "z") return true;
  const text = value.s.trim();
  return text !== "" && Number.isFinite(Number(text.replace(",", ".")));
}

function compare(a: Val, b: Val): number {
  if (numericLike(a) && numericLike(b)) return asNumber(a) - asNumber(b);
  return asString(a).localeCompare(asString(b), "es", { numeric: true, sensitivity: "base" });
}

function dayNumber(value: Val): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(asString(value).trim());
  if (!match) fail("nan");
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(utc)) fail("nan");
  return utc;
}

function toFormula(value: Val): FormulaValue {
  if (value.t === "n") return value.n;
  if (value.t === "s") return value.s === "" ? null : value.s;
  if (value.t === "b") return value.b;
  return null;
}

function explain(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "empty") return "La fórmula está vacía.";
  if (code === "cycle") return "Esa fórmula se llama a sí misma.";
  if (code === "div0") return "No se puede dividir por cero.";
  if (code === "arity") return "A esa función le faltan datos o le sobran.";
  if (code === "limit") return "La fórmula es demasiado larga.";
  if (code === "nan") return "Eso no es un número.";
  if (code.startsWith("col:")) return `No existe la columna «${code.slice(4)}».`;
  return "La fórmula no se entiende.";
}

/**
 * Calcula las columnas fórmula de una fila. `today` es `YYYY-MM-DD` (para
 * `hoy()`); si no se pasa, es la fecha UTC de este momento.
 */
export function computeFormulas(fields: TableField[], cells: Record<string, CellValue>, today?: string): FormulaRun {
  const values: Record<string, FormulaValue> = {};
  const errors: Record<string, string> = {};
  if (!fields.some((field) => field.type === "formula")) return { values, errors };
  const day = today ?? new Date().toISOString().slice(0, 10);
  const memo = new Map<string, Val>();
  const stack = new Set<string>();
  let steps = 0;

  const evalAst = (expr: Expr): Val => {
    if (++steps > 400) fail("limit");
    switch (expr.k) {
      case "num":
        return { t: "n", n: expr.n };
      case "str":
        return { t: "s", s: expr.s };
      case "col":
        return column(expr.name);
      case "un": {
        const inner = evalAst(expr.a);
        if (expr.op === "no") return { t: "b", b: !truthy(inner) };
        return { t: "n", n: -asNumber(inner) };
      }
      case "bin": {
        if (expr.op === "y") return { t: "b", b: truthy(evalAst(expr.a)) && truthy(evalAst(expr.b)) };
        if (expr.op === "o") return { t: "b", b: truthy(evalAst(expr.a)) || truthy(evalAst(expr.b)) };
        const left = evalAst(expr.a);
        const right = evalAst(expr.b);
        if (expr.op === "&" || (expr.op === "+" && (left.t === "s" || right.t === "s"))) return { t: "s", s: asString(left) + asString(right) };
        if (expr.op === "+") return { t: "n", n: asNumber(left) + asNumber(right) };
        if (expr.op === "-") return { t: "n", n: asNumber(left) - asNumber(right) };
        if (expr.op === "*") return { t: "n", n: asNumber(left) * asNumber(right) };
        if (expr.op === "/") {
          const divisor = asNumber(right);
          if (divisor === 0) fail("div0");
          return { t: "n", n: asNumber(left) / divisor };
        }
        const order = compare(left, right);
        const ok =
          expr.op === "=" ? order === 0 : expr.op === "!=" ? order !== 0 : expr.op === "<" ? order < 0 : expr.op === ">" ? order > 0 : expr.op === "<=" ? order <= 0 : order >= 0;
        return { t: "b", b: ok };
      }
      case "call":
        return call(expr.name, expr.args);
    }
  };

  const column = (name: string): Val => {
    const field = fields.find((item) => item.id === name || item.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!field) fail(`col:${name}`);
    return valueOf(field);
  };

  const call = (name: string, args: Expr[]): Val => {
    if (name === "si") {
      if (args.length !== 3) fail("arity");
      return truthy(evalAst(args[0]!)) ? evalAst(args[1]!) : evalAst(args[2]!);
    }
    if (name === "hoy") {
      if (args.length !== 0) fail("arity");
      return { t: "s", s: day };
    }
    if (name === "vacio") {
      if (args.length !== 1) fail("arity");
      const value = evalAst(args[0]!);
      return { t: "b", b: value.t === "z" || (value.t === "s" && value.s.trim() === "") };
    }
    if (name === "redondear") {
      if (args.length < 1 || args.length > 2) fail("arity");
      const places = args[1] ? Math.max(0, Math.min(8, Math.trunc(asNumber(evalAst(args[1]))))) : 0;
      const factor = 10 ** places;
      return { t: "n", n: Math.round(asNumber(evalAst(args[0]!)) * factor) / factor };
    }
    if (name === "dias") {
      if (args.length !== 2) fail("arity");
      return { t: "n", n: Math.round((dayNumber(evalAst(args[1]!)) - dayNumber(evalAst(args[0]!))) / 86_400_000) };
    }
    if (name === "largo") {
      if (args.length !== 1) fail("arity");
      return { t: "n", n: asString(evalAst(args[0]!)).length };
    }
    if (name === "contiene") {
      if (args.length !== 2) fail("arity");
      return { t: "b", b: asString(evalAst(args[0]!)).toLowerCase().includes(asString(evalAst(args[1]!)).toLowerCase()) };
    }
    fail("syntax");
  };

  const valueOf = (field: TableField): Val => {
    const cached = memo.get(field.id);
    if (cached) return cached;
    if (field.type !== "formula") {
      const value = fromCell(cells[field.id]);
      memo.set(field.id, value);
      return value;
    }
    if (stack.has(field.id)) fail("cycle");
    const source = field.formula?.trim() ?? "";
    if (!source) fail("empty");
    if (source.length > MAX_FORMULA) fail("limit");
    stack.add(field.id);
    try {
      const value = evalAst(parse(source));
      memo.set(field.id, value);
      return value;
    } finally {
      stack.delete(field.id);
    }
  };

  for (const field of fields) {
    if (field.type !== "formula") continue;
    try {
      values[field.id] = toFormula(valueOf(field));
    } catch (error) {
      errors[field.id] = explain(error);
      values[field.id] = null;
      memo.set(field.id, { t: "z" });
    }
  }
  return { values, errors };
}
