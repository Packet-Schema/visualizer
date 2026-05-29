// PSDL 0.3 — schema validator for the on-disk Container tree.
//
// `renderer-helpers.ts` carries the equivalent `validatePacket` for the
// renderer's UI shape (subfield bit sums, TLV catalog non-empty, etc.).
// This module is the schema-side counterpart: it walks the PSDL Container
// tree before normalize/layout and enforces invariants that the new 0.3
// primitives bring in (Varint encoding allow-list, Encrypted plaintext
// shape), as well as the basics shared with every PSDL packet.

import type {
  Container,
  Encrypted,
  Expr,
  Field,
  Group,
  Packet,
  Repeat,
  Struct,
  Switch,
  Type,
} from "./types";
import { VARINT_ENCODINGS } from "./types";
import { isField } from "./utils";

/**
 * Shape-check an Expr — purely structural (no env evaluation). Catches typos
 * like a missing operand or an unknown operator slipping past TypeScript when
 * the schema comes in from JSON.
 */
export function isValidExpr(expr: unknown): expr is Expr {
  if (typeof expr !== "object" || expr === null) return false;
  const e = expr as { kind?: unknown };
  switch (e.kind) {
    case "lit": {
      const v = (expr as { value?: unknown }).value;
      return typeof v === "number" && Number.isFinite(v);
    }
    case "ref":
      return typeof (expr as { field?: unknown }).field === "string";
    case "op": {
      const o = expr as { op?: unknown; a?: unknown; b?: unknown };
      const ops = ["+", "-", "*", "/", "%", "<<", ">>"];
      return (
        typeof o.op === "string" &&
        ops.includes(o.op) &&
        isValidExpr(o.a) &&
        isValidExpr(o.b)
      );
    }
    case "cond": {
      const c = expr as { test?: unknown; t?: unknown; f?: unknown };
      return isValidExpr(c.test) && isValidExpr(c.t) && isValidExpr(c.f);
    }
    case "peek": {
      // PSDL 0.4 — bits 1..64, optional offset must validate when present.
      const p = expr as { bits?: unknown; offset?: unknown };
      if (
        typeof p.bits !== "number" ||
        !Number.isInteger(p.bits) ||
        p.bits < 1 ||
        p.bits > 64
      ) {
        return false;
      }
      if (p.offset !== undefined && !isValidExpr(p.offset)) return false;
      return true;
    }
    default:
      return false;
  }
}

function validateType(type: Type, ctx: string): void {
  switch (type.kind) {
    case "int":
      if (!Number.isInteger(type.bits) || type.bits <= 0) {
        throw new Error(
          `${ctx}: int type must have positive integer bits, got ${type.bits}.`,
        );
      }
      return;
    case "bits":
      if (!Number.isInteger(type.n) || type.n <= 0) {
        throw new Error(
          `${ctx}: bits type must have positive integer n, got ${type.n}.`,
        );
      }
      return;
    case "bytes":
      if (!isValidExpr(type.n)) {
        throw new Error(`${ctx}: bytes type has malformed length expression.`);
      }
      return;
    case "enum":
      if (!Number.isInteger(type.bits) || type.bits <= 0) {
        throw new Error(
          `${ctx}: enum type must have positive integer bits, got ${type.bits}.`,
        );
      }
      return;
    case "varint": {
      const enc = (type as { encoding: unknown }).encoding;
      if (
        typeof enc !== "string" ||
        !(VARINT_ENCODINGS as readonly string[]).includes(enc)
      ) {
        throw new Error(
          `${ctx}: varint encoding must be one of ${VARINT_ENCODINGS.join(", ")}, got ${String(enc)}.`,
        );
      }
      return;
    }
    case "berLength":
      return;
    default: {
      const bad = (type as { kind: string }).kind;
      throw new Error(`${ctx}: unknown type kind "${bad}".`);
    }
  }
}

/**
 * Reserved-id suffixes that `applyTlvInstances` mints. A user-authored
 * Field with one of these in its id would collide with synthetic TLV
 * instance / remaining cells and corrupt `parseTlvCellId` routing —
 * clicks on the real field would dispatch to non-existent TLV state.
 * Catch it at validation time so a malformed preset / share URL fails
 * fast rather than crashing inside OverridePanel later (sub-agent
 * Round 7 CRITICAL).
 */
const RESERVED_ID_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /__inst_\d+(?:__|$)/,
    reason: "reserved `__inst_<N>` TLV-instance suffix",
  },
  { re: /__remaining$/, reason: "reserved `__remaining` TLV-remaining suffix" },
  // The renderer composes parent / sub-cell ids as `${parent}:${sub}` and
  // the diagram dispatches clicks via that shape. A field id containing
  // a literal `:` would collide with the separator and prevent
  // selection-resolver / parseTlvCellId from disambiguating clicks
  // (Codex P2 × 2). Reject the character up front so a hand-authored
  // preset can't break the click-routing.
  { re: /:/, reason: "reserved `:` separator (used in sub-cell ids)" },
  // Repeat expansion decorates cell ids with a `#<index>` tag (e.g.
  // `flagsBits#0`), and `resolveSelection` unconditionally strips a
  // trailing `#\d+(_\d+)*` to recover the base field. A real id
  // containing `#` would be silently truncated and fail lookup, so
  // forbid the character outright (Codex P2).
  { re: /#/, reason: "reserved `#` separator (used in repeat-index tags)" },
];

// Applies to every clickable id — Field, Group, and Repeat all surface
// as diagram cells whose ids feed `parseTlvCellId` / `resolveSelection`,
// so a reserved token in any of them mis-routes clicks (Codex P2).
function ensureUnreservedId(id: string, ctx: string): void {
  for (const { re, reason } of RESERVED_ID_PATTERNS) {
    if (re.test(id)) {
      throw new Error(`${ctx}: id "${id}" uses ${reason}.`);
    }
  }
}

// Reject duplicate ids among the *Group* siblings in one container list.
// `normalize.walkGroup` derives each Group's container path as
// `${path}/${g.id}`, and `layout.groupConsecutiveByContainer` merges
// consecutive cells sharing `groupId` + container path into one collapsed
// cell. Two sibling Groups with the same id therefore produce identical
// paths and get wrongly fused — cell width / subCells / selection target
// all drift from the schema. Enforcing sibling-Group id uniqueness closes
// that at validation time (Codex P2).
function ensureUniqueSiblingGroupIds(
  containers: Container[],
  ctx: string,
): void {
  const seen = new Set<string>();
  for (const c of containers) {
    if (isField(c) || c.kind !== "group") continue;
    if (typeof c.id !== "string") continue;
    if (seen.has(c.id)) {
      throw new Error(
        `${ctx}: duplicate sibling group id "${c.id}" — group ids must be unique among siblings (collapsed-cell boundary relies on it).`,
      );
    }
    seen.add(c.id);
  }
}

function validateField(field: Field, ctx: string): void {
  if (typeof field.id !== "string" || field.id.length === 0) {
    throw new Error(`${ctx}: field is missing an id.`);
  }
  ensureUnreservedId(field.id, ctx);
  // A plain Field id ending in `_chain` collides with the IPv6-style
  // chain Repeat id convention (`${baseId}_chain`). `rendererToPsdl`
  // emits both a base Field and the chain Repeat when a chain catalog
  // sits on a `bits > 0` field, and a base Field named `foo_chain` would
  // make `chainFieldToRepeat` regenerate the same id → duplicate id in
  // one PSDL body. The chain *Repeat* legitimately ends in `_chain`, so
  // this restriction is Field-only (Codex P2).
  if (/_chain$/.test(field.id)) {
    throw new Error(
      `${ctx}: field id "${field.id}" ends in the reserved \`_chain\` suffix (used for chain Repeat ids).`,
    );
  }
  if (typeof field.name !== "string") {
    throw new Error(`${ctx}: field "${field.id}" is missing a name.`);
  }
  if (!field.type) {
    throw new Error(`${ctx}: field "${field.id}" is missing a type.`);
  }
  validateType(field.type, `${ctx}/${field.id}`);
  if (
    field.byteOrder !== undefined &&
    field.byteOrder !== "BE" &&
    field.byteOrder !== "LE"
  ) {
    throw new Error(
      `${ctx}/${field.id}: byteOrder must be 'BE' or 'LE', got "${String(field.byteOrder)}".`,
    );
  }
}

function validateGroup(g: Group, ctx: string): void {
  if (typeof g.id === "string") ensureUnreservedId(g.id, ctx);
  if (!Array.isArray(g.children)) {
    throw new Error(`${ctx}: group "${g.id}" must have a children array.`);
  }
  const sub = `${ctx}/${g.id}`;
  ensureUniqueSiblingGroupIds(g.children, sub);
  for (const child of g.children) validateContainer(child, sub);
}

function validateRepeat(r: Repeat, ctx: string): void {
  if (typeof r.id === "string") ensureUnreservedId(r.id, ctx);
  const sub = `${ctx}/${r.id}`;
  if (!r.element || typeof r.element !== "object") {
    throw new Error(`${sub}: repeat is missing element struct.`);
  }
  validateStruct(r.element, sub);
  // PSDL 0.4 — `instances` is the persisted TLV-record list. Without
  // shape-checking it before `repeatToTlvField` reads `r.instances.map(...)`,
  // a hostile or corrupted share URL with `instances: "oops"` or
  // `instances: [null]` would crash the renderer instead of failing fast
  // here (Codex P1 / sub-agent HIGH).
  if (r.instances !== undefined) {
    if (!Array.isArray(r.instances)) {
      throw new Error(`${sub}: repeat 'instances' must be an array.`);
    }
    r.instances.forEach((inst, i) => {
      if (!inst || typeof inst !== "object") {
        throw new Error(`${sub}: instances[${i}] must be an object.`);
      }
      const kind = (inst as { kind?: unknown }).kind;
      if (typeof kind !== "number" || !Number.isInteger(kind)) {
        throw new Error(
          `${sub}: instances[${i}].kind must be an integer, got ${String(kind)}.`,
        );
      }
      const extras = (inst as { extras?: unknown }).extras;
      if (extras !== undefined) {
        if (typeof extras !== "object" || extras === null) {
          throw new Error(`${sub}: instances[${i}].extras must be an object.`);
        }
        for (const [k, v] of Object.entries(
          extras as Record<string, unknown>,
        )) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error(
              `${sub}: instances[${i}].extras[${k}] must be a finite number.`,
            );
          }
        }
      }
    });
  }
  // Mirror invariant for IPv6-style chain Repeats (proto + per-instance
  // payload fields). The shape diverges from TLV instances (`proto` rather
  // than `kind`, `extras` keys map to leaf field ids), so use a separate
  // key on the PSDL side and validate independently.
  if (r.chainFinalProto !== undefined) {
    if (
      typeof r.chainFinalProto !== "number" ||
      !Number.isInteger(r.chainFinalProto)
    ) {
      throw new Error(
        `${sub}: repeat 'chainFinalProto' must be an integer, got ${String(r.chainFinalProto)}.`,
      );
    }
  }
  if (r.chainInstances !== undefined) {
    if (!Array.isArray(r.chainInstances)) {
      throw new Error(`${sub}: repeat 'chainInstances' must be an array.`);
    }
    r.chainInstances.forEach((inst, i) => {
      if (!inst || typeof inst !== "object") {
        throw new Error(`${sub}: chainInstances[${i}] must be an object.`);
      }
      const proto = (inst as { proto?: unknown }).proto;
      if (typeof proto !== "number" || !Number.isInteger(proto)) {
        throw new Error(
          `${sub}: chainInstances[${i}].proto must be an integer, got ${String(proto)}.`,
        );
      }
      const extras = (inst as { extras?: unknown }).extras;
      if (extras !== undefined) {
        if (typeof extras !== "object" || extras === null) {
          throw new Error(
            `${sub}: chainInstances[${i}].extras must be an object.`,
          );
        }
        for (const [k, v] of Object.entries(
          extras as Record<string, unknown>,
        )) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error(
              `${sub}: chainInstances[${i}].extras[${k}] must be a finite number.`,
            );
          }
        }
      }
    });
  }
  if (r.count === "eos") return;
  if (typeof r.count === "object" && r.count !== null && "until" in r.count) {
    if (!isValidExpr(r.count.until)) {
      throw new Error(`${sub}: repeat 'until' predicate is malformed.`);
    }
    return;
  }
  if (!isValidExpr(r.count)) {
    throw new Error(`${sub}: repeat count is malformed.`);
  }
}

function validateSwitch(s: Switch, ctx: string): void {
  const sub = `${ctx}/${s.id}`;
  if (!isValidExpr(s.on)) {
    throw new Error(`${sub}: switch 'on' expression is malformed.`);
  }
  if (!s.cases || typeof s.cases !== "object") {
    throw new Error(`${sub}: switch is missing 'cases' map.`);
  }
  for (const [k, v] of Object.entries(s.cases)) {
    validateStruct(v, `${sub}[${k}]`);
  }
  if (s.default) validateStruct(s.default, `${sub}[default]`);
}

function validateStruct(s: Struct, ctx: string): void {
  if (typeof s.id !== "string" || s.id.length === 0) {
    throw new Error(`${ctx}: struct is missing an id.`);
  }
  if (!Array.isArray(s.fields)) {
    throw new Error(`${ctx}: struct "${s.id}" must have a fields array.`);
  }
  ensureUniqueSiblingGroupIds(s.fields, `${ctx}/${s.id}`);
  for (const child of s.fields) validateContainer(child, `${ctx}/${s.id}`);
}

/**
 * Recursively collect every Field id reachable inside a Struct, descending
 * through Group / Repeat / Switch / Encrypted so `headerProtected` references
 * can resolve fields that live behind compound primitives.
 */
function collectFieldIds(struct: Struct, into: Set<string>): void {
  for (const child of struct.fields) collectIdsFromContainer(child, into);
}

function collectIdsFromContainer(c: Container, into: Set<string>): void {
  if (isField(c)) {
    into.add(c.id);
    return;
  }
  switch (c.kind) {
    case "group":
      for (const child of c.children) collectIdsFromContainer(child, into);
      return;
    case "repeat":
      collectFieldIds(c.element, into);
      return;
    case "switch":
      for (const v of Object.values(c.cases)) collectFieldIds(v, into);
      if (c.default) collectFieldIds(c.default, into);
      return;
    case "encrypted":
      collectFieldIds(c.plaintext, into);
      return;
    case "optional":
      into.add(c.field.id);
      return;
  }
}

function validateEncrypted(e: Encrypted, ctx: string): void {
  const sub = `${ctx}/${e.id}`;
  if (typeof e.contextNote !== "string" || e.contextNote.length === 0) {
    throw new Error(
      `${sub}: encrypted container must have a non-empty contextNote.`,
    );
  }
  if (!e.plaintext || typeof e.plaintext !== "object") {
    throw new Error(`${sub}: encrypted container is missing plaintext struct.`);
  }
  if (!Array.isArray(e.plaintext.fields) || e.plaintext.fields.length === 0) {
    throw new Error(
      `${sub}: encrypted plaintext must be a Struct with at least one field.`,
    );
  }
  validateStruct(e.plaintext, sub);
  if (e.wireBits !== undefined && !isValidExpr(e.wireBits)) {
    throw new Error(`${sub}: encrypted wireBits is malformed.`);
  }
  if (e.headerProtected !== undefined) {
    if (!Array.isArray(e.headerProtected)) {
      throw new Error(`${sub}: encrypted headerProtected must be an array.`);
    }
    const ids = new Set<string>();
    collectFieldIds(e.plaintext, ids);
    for (const id of e.headerProtected) {
      if (typeof id !== "string") {
        throw new Error(
          `${sub}: encrypted headerProtected ids must be strings.`,
        );
      }
      if (!ids.has(id)) {
        throw new Error(
          `${sub}: encrypted headerProtected id "${id}" does not name a field inside plaintext.`,
        );
      }
    }
  }
}

function validateContainer(c: Container, ctx: string): void {
  if (isField(c)) {
    validateField(c, ctx);
    return;
  }
  switch (c.kind) {
    case "group":
      validateGroup(c, ctx);
      return;
    case "repeat":
      validateRepeat(c, ctx);
      return;
    case "switch":
      validateSwitch(c, ctx);
      return;
    case "encrypted":
      validateEncrypted(c, ctx);
      return;
    case "optional": {
      const sub = `${ctx}/${c.id ?? "optional"}`;
      if (!isValidExpr(c.when)) {
        throw new Error(`${sub}: optional 'when' expression is malformed.`);
      }
      if (!c.field) {
        throw new Error(`${sub}: optional is missing inner field.`);
      }
      if (!c.field.type) {
        throw new Error(`${sub}: optional inner field is missing a type.`);
      }
      validateField(c.field, sub);
      return;
    }
    default: {
      const bad = (c as { kind: string }).kind;
      throw new Error(`${ctx}: unknown container kind "${bad}".`);
    }
  }
}

/**
 * Validate a PSDL Packet's Container tree. Throws on the first violation
 * with a slash-joined context path so the failing node is locatable.
 */
export function validatePsdlPacket(packet: Packet): void {
  if (typeof packet.name !== "string" || packet.name.length === 0) {
    throw new Error("validatePsdlPacket: packet is missing a name.");
  }
  if (!Number.isInteger(packet.rowBits) || packet.rowBits <= 0) {
    throw new Error(
      `validatePsdlPacket: packet "${packet.name}" rowBits must be a positive integer.`,
    );
  }
  if (!Array.isArray(packet.body)) {
    throw new Error(
      `validatePsdlPacket: packet "${packet.name}" body must be an array.`,
    );
  }
  ensureUniqueSiblingGroupIds(packet.body, packet.name);
  for (const c of packet.body) validateContainer(c, packet.name);
}
