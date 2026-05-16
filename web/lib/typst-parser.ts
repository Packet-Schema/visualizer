// Minimal Typst parser for the dict-literal subset we use as on-disk packet
// definitions. It handles only what `data/presets.typ` needs:
//
//   - Top-level `#let NAME = EXPR` bindings, one or more.
//   - Dict literals `(key: value, ...)` — keys are identifiers (or strings).
//   - Array literals `(value, value, ...)`.
//   - Empty array `()` and empty dict `(:)`.
//   - String literals `"..."` with `\"`, `\\`, `\n`, `\t`, `\r` escapes.
//   - Numbers (integer and decimal, optional leading `-`).
//   - Booleans (`true` / `false`) and `none` -> null.
//   - Identifiers as references to previously bound `#let` names.
//   - Line comments starting with `//`.
//   - Trailing commas allowed in both dicts and arrays.
//
// The parser is intentionally lenient about Typst's full grammar — anything
// outside the subset throws a clear error. Callers receive a plain JS object
// graph (`JsValue`) keyed by the names defined via `#let`.

export type JsValue =
  | string
  | number
  | boolean
  | null
  | JsValue[]
  | { [key: string]: JsValue };

type Tok =
  | { kind: "ident"; value: string; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "number"; value: number; pos: number }
  | { kind: "bool"; value: boolean; pos: number }
  | { kind: "none"; pos: number }
  | { kind: "punct"; value: "(" | ")" | "," | ":" | "="; pos: number }
  | { kind: "hash"; pos: number }
  | { kind: "let"; pos: number }
  | { kind: "eof"; pos: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Line comments: `// ...`
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    // Single-char punctuation
    if (ch === "(" || ch === ")" || ch === "," || ch === ":" || ch === "=") {
      toks.push({ kind: "punct", value: ch, pos: i });
      i++;
      continue;
    }

    // `#let` keyword form
    if (ch === "#") {
      toks.push({ kind: "hash", pos: i });
      i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      const start = i;
      i++;
      let out = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const next = src[i + 1];
          if (next === undefined) {
            throw new Error(
              `typst-parser: unterminated escape at offset ${i}`,
            );
          }
          switch (next) {
            case "\\":
              out += "\\";
              break;
            case '"':
              out += '"';
              break;
            case "n":
              out += "\n";
              break;
            case "t":
              out += "\t";
              break;
            case "r":
              out += "\r";
              break;
            default:
              throw new Error(
                `typst-parser: unknown escape \\${next} at offset ${i}`,
              );
          }
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) {
        throw new Error(
          `typst-parser: unterminated string starting at offset ${start}`,
        );
      }
      i++; // closing quote
      toks.push({ kind: "string", value: out, pos: start });
      continue;
    }

    // Number literal (optional leading `-`, integer or decimal)
    if (
      (ch >= "0" && ch <= "9") ||
      (ch === "-" && src[i + 1] && src[i + 1] >= "0" && src[i + 1] <= "9")
    ) {
      const start = i;
      if (ch === "-") i++;
      while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && src[i] >= "0" && src[i] <= "9") i++;
      }
      const raw = src.slice(start, i);
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(
          `typst-parser: invalid number "${raw}" at offset ${start}`,
        );
      }
      toks.push({ kind: "number", value: n, pos: start });
      continue;
    }

    // Identifier / keyword. Typst identifiers allow `-` mid-word; we keep
    // it lenient and accept `[A-Za-z_][A-Za-z0-9_-]*`.
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_"
    ) {
      const start = i;
      while (
        i < src.length &&
        ((src[i] >= "a" && src[i] <= "z") ||
          (src[i] >= "A" && src[i] <= "Z") ||
          (src[i] >= "0" && src[i] <= "9") ||
          src[i] === "_" ||
          src[i] === "-")
      ) {
        i++;
      }
      const word = src.slice(start, i);
      if (word === "true" || word === "false") {
        toks.push({ kind: "bool", value: word === "true", pos: start });
      } else if (word === "none") {
        toks.push({ kind: "none", pos: start });
      } else if (word === "let") {
        toks.push({ kind: "let", pos: start });
      } else {
        toks.push({ kind: "ident", value: word, pos: start });
      }
      continue;
    }

    throw new Error(
      `typst-parser: unexpected character ${JSON.stringify(ch)} at offset ${i}`,
    );
  }
  toks.push({ kind: "eof", pos: src.length });
  return toks;
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly bindings: Record<string, JsValue>,
  ) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private advance(): Tok {
    return this.toks[this.i++];
  }
  private expectPunct(value: "(" | ")" | "," | ":" | "="): Tok {
    const t = this.advance();
    if (t.kind !== "punct" || t.value !== value) {
      throw new Error(
        `typst-parser: expected '${value}' at offset ${t.pos}, got ${describe(t)}`,
      );
    }
    return t;
  }

  parseProgram(): void {
    while (this.peek().kind !== "eof") {
      this.parseLet();
    }
  }

  private parseLet(): void {
    const hashTok = this.advance();
    if (hashTok.kind !== "hash") {
      throw new Error(
        `typst-parser: expected '#' at offset ${hashTok.pos}, got ${describe(hashTok)}`,
      );
    }
    const letTok = this.advance();
    if (letTok.kind !== "let") {
      throw new Error(
        `typst-parser: expected 'let' at offset ${letTok.pos}, got ${describe(letTok)}`,
      );
    }
    const nameTok = this.advance();
    if (nameTok.kind !== "ident") {
      throw new Error(
        `typst-parser: expected identifier after '#let' at offset ${nameTok.pos}, got ${describe(nameTok)}`,
      );
    }
    this.expectPunct("=");
    const value = this.parseExpr();
    this.bindings[nameTok.value] = value;
  }

  parseExpr(): JsValue {
    const t = this.peek();
    switch (t.kind) {
      case "string":
        this.advance();
        return t.value;
      case "number":
        this.advance();
        return t.value;
      case "bool":
        this.advance();
        return t.value;
      case "none":
        this.advance();
        return null;
      case "ident": {
        this.advance();
        if (!(t.value in this.bindings)) {
          throw new Error(
            `typst-parser: unknown identifier "${t.value}" at offset ${t.pos}`,
          );
        }
        return this.bindings[t.value];
      }
      case "punct":
        if (t.value === "(") return this.parseParenExpr();
        break;
      default:
        break;
    }
    throw new Error(
      `typst-parser: unexpected token ${describe(t)} at offset ${t.pos}`,
    );
  }

  // `(` already peeked. Determines dict vs array by lookahead:
  //   ()       -> empty array
  //   (:)      -> empty dict
  //   (ident:  -> dict
  //   else     -> array
  private parseParenExpr(): JsValue {
    this.expectPunct("(");

    // Empty array `()`
    if (this.peek().kind === "punct" && (this.peek() as Tok & { kind: "punct" }).value === ")") {
      this.advance();
      return [];
    }

    // Empty dict `(:)`
    if (this.peek().kind === "punct" && (this.peek() as Tok & { kind: "punct" }).value === ":") {
      this.advance();
      this.expectPunct(")");
      return {};
    }

    // Lookahead to decide between dict / array. A dict starts with
    // `ident :` or `string :`.
    const save = this.i;
    let isDict = false;
    const first = this.peek();
    if (first.kind === "ident" || first.kind === "string") {
      const next = this.toks[this.i + 1];
      if (next && next.kind === "punct" && next.value === ":") {
        isDict = true;
      }
    }
    this.i = save;

    if (isDict) {
      return this.parseDictBody();
    }
    return this.parseArrayBody();
  }

  private parseDictBody(): Record<string, JsValue> {
    const out: Record<string, JsValue> = {};
    while (true) {
      const keyTok = this.advance();
      let key: string;
      if (keyTok.kind === "ident" || keyTok.kind === "string") {
        key = keyTok.value;
      } else {
        throw new Error(
          `typst-parser: expected dict key at offset ${keyTok.pos}, got ${describe(keyTok)}`,
        );
      }
      this.expectPunct(":");
      const value = this.parseExpr();
      out[key] = value;
      const sep = this.peek();
      if (sep.kind === "punct" && sep.value === ",") {
        this.advance();
        // Trailing comma support.
        if (this.peek().kind === "punct" && (this.peek() as Tok & { kind: "punct" }).value === ")") {
          this.advance();
          return out;
        }
        continue;
      }
      if (sep.kind === "punct" && sep.value === ")") {
        this.advance();
        return out;
      }
      throw new Error(
        `typst-parser: expected ',' or ')' in dict at offset ${sep.pos}, got ${describe(sep)}`,
      );
    }
  }

  private parseArrayBody(): JsValue[] {
    const out: JsValue[] = [];
    while (true) {
      const value = this.parseExpr();
      out.push(value);
      const sep = this.peek();
      if (sep.kind === "punct" && sep.value === ",") {
        this.advance();
        if (this.peek().kind === "punct" && (this.peek() as Tok & { kind: "punct" }).value === ")") {
          this.advance();
          return out;
        }
        continue;
      }
      if (sep.kind === "punct" && sep.value === ")") {
        this.advance();
        return out;
      }
      throw new Error(
        `typst-parser: expected ',' or ')' in array at offset ${sep.pos}, got ${describe(sep)}`,
      );
    }
  }
}

function describe(t: Tok): string {
  switch (t.kind) {
    case "ident":
      return `ident '${t.value}'`;
    case "string":
      return `string`;
    case "number":
      return `number ${t.value}`;
    case "bool":
      return `bool ${t.value}`;
    case "none":
      return `none`;
    case "punct":
      return `'${t.value}'`;
    case "hash":
      return `'#'`;
    case "let":
      return `'let'`;
    case "eof":
      return `<eof>`;
  }
}

/**
 * Parse a Typst source string of `#let` bindings and return the resulting
 * environment as a plain object.
 */
export function parseTypst(src: string): Record<string, JsValue> {
  const tokens = tokenize(src);
  const env: Record<string, JsValue> = {};
  const parser = new Parser(tokens, env);
  parser.parseProgram();
  return env;
}
