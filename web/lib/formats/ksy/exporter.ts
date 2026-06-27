// PSDL → .ksy exporter.
//
// Lossy by design: PSDL constructs Kaitai cannot model (categories,
// constraints, switches on non-integer discriminators, peek expressions,
// encrypted blocks) are surfaced as `# psdl-only:` comments at the top of
// the emitted YAML so the reader knows what was elided.

import { stringify as yamlStringify } from "yaml";

import { sanitizeId } from "../common";
import { isField } from "../../psdl/utils";
import { isBytesDelimited } from "../../psdl/normalize";
import { evalExprOr } from "../../psdl/expr";
import type {
  Container,
  Expr,
  Encrypted,
  Field,
  Packet,
  PacketEnv,
  Repeat,
} from "../../psdl/types";

import type { KsyRoot, KsySeqEntry, KsyType } from "./types";

/**
 * Serialise a PSDL packet to Kaitai .ksy YAML (best-effort, lossy).
 *
 * `env` carries the live controller / discriminator picks (the same Map the
 * JSON and RFC-ASCII adapters receive). Without it the exporter emitted
 * `repeat: eos` for every dynamic-count repeat, silently dropping the user's
 * chosen iteration count (audit MEDIUM #2). When env pins a concrete count
 * for a repeat — either keyed by the repeat id (eos / until) or via a `ref`
 * count expression — we emit `repeat: expr` with the resolved literal so the
 * count survives, matching `toJson` / `toAscii`.
 */
export function toKsy(packet: Packet, env?: PacketEnv): string {
  const ksy: KsyRoot = {
    meta: {
      id: toKsyId(packet.name),
      title: packet.name,
      ...(packet.byteOrder
        ? { endian: packet.byteOrder.toLowerCase() === "le" ? "le" : "be" }
        : {}),
    },
    seq: [],
  };
  if (packet.description) ksy.doc = packet.description;

  const psdlOnly: string[] = [];
  const types: Record<string, KsyType> = {};

  const seq: KsySeqEntry[] = [];
  for (const c of packet.body) {
    seq.push(...containerToKsy(c, { types, psdlOnly, env: env ?? new Map() }));
  }
  ksy.seq = seq;
  if (Object.keys(types).length > 0) ksy.types = types;

  if (packet.constraints && packet.constraints.length > 0) {
    psdlOnly.push(
      `${packet.constraints.length} PSDL constraint(s) not representable in .ksy`,
    );
  }

  let yamlText = yamlStringify(ksy, {
    lineWidth: 100,
    aliasDuplicateObjects: false,
  });

  if (psdlOnly.length > 0) {
    const header = psdlOnly.map((m) => `# psdl-only: ${m}`).join("\n") + "\n";
    yamlText = header + yamlText;
  }
  return yamlText;
}

type ToCtx = {
  types: Record<string, KsyType>;
  psdlOnly: string[];
  /** Live controller / discriminator env, used to resolve dynamic repeat
   *  counts to concrete `repeat-expr` literals. Empty when no env is
   *  supplied (the legacy call shape). */
  env: PacketEnv;
};

function containerToKsy(c: Container, ctx: ToCtx): KsySeqEntry[] {
  // Field?
  if (!("kind" in c) || c.kind === "field") {
    const f = c as Field;
    // A `bytes` field with no valid Kaitai seq form (multi-byte delimiter, or a
    // size expression that isn't Kaitai-representable and isn't `remaining`)
    // would emit an uncompilable typeless/sizeless array. Drop the entry —
    // fieldToKsy still records the psdl-only note as a side effect.
    if (isUnemittableSizedBytes(f)) {
      fieldToKsy(f, ctx); // record the psdl-only note (side effect)
      return [];
    }
    return [fieldToKsy(f, ctx)];
  }
  switch (c.kind) {
    case "group":
      // Splice inline (Kaitai has no group; the children are siblings).
      return c.children.flatMap((ch) => containerToKsy(ch, ctx));
    case "repeat": {
      // Sanitize the PSDL repeat id through the same `toKsyId` filter as
      // every other seq entry. Without this an id containing `:` / `-`
      // (legal in PSDL, illegal in Kaitai identifiers) emitted invalid
      // YAML that broke downstream `kaitai-struct-compiler` runs.
      const sanitizedRepeatId = toKsyId(c.id);
      const entry: KsySeqEntry = {
        id: sanitizedRepeatId,
        repeat: "eos",
      };
      // Hoist the first field of the element as the entry's "type" if it's a
      // single field; otherwise create a synthetic user type.
      const child = c.element.fields[0];
      if (
        c.element.fields.length === 1 &&
        child &&
        (!("kind" in child) || child.kind === "field")
      ) {
        const f = child as Field;
        const proxy = fieldToKsy(f, ctx);
        Object.assign(entry, proxy, { id: sanitizedRepeatId });
      } else {
        // Synthetic user-type names share Kaitai's identifier rules with
        // seq ids, so derive the type name from the sanitized repeat id
        // (not the raw PSDL id) and keep entry.type aligned.
        const typeName = `${sanitizedRepeatId}_elem`;
        ctx.types[typeName] = {
          seq: c.element.fields.flatMap((ch) => containerToKsy(ch, ctx)),
        };
        entry.type = typeName;
      }
      // Prefer a concrete count resolved from the live env — the user's
      // chosen iteration count round-trips as `repeat: expr` with a literal
      // instead of collapsing to `repeat: eos` (audit MEDIUM #2).
      const resolvedCount = resolveRepeatCount(c, ctx.env);
      if (resolvedCount !== null) {
        entry.repeat = "expr";
        entry["repeat-expr"] = resolvedCount;
        // Drop a `repeat-until` left over from the `Object.assign(entry, proxy)`
        // hoist — it can't have been set yet, but keep the shape explicit.
        delete entry["repeat-until"];
      } else if (
        typeof c.count === "object" &&
        c.count !== null &&
        "kind" in c.count
      ) {
        entry.repeat = "expr";
        entry["repeat-expr"] = exprToString(c.count);
      } else if (
        typeof c.count === "object" &&
        "until" in (c.count as object)
      ) {
        entry.repeat = "until";
        entry["repeat-until"] = exprToString(
          (c.count as { until: Expr }).until,
        );
      }
      return [entry];
    }
    case "switch": {
      // PSDL 0.4 — if the discriminator is a peek() expression, surface that
      // as a psdl-only comment alongside the (still-lowered) Switch so the
      // .ksy reader knows the dispatch happens on a lookahead rather than a
      // declared sibling field. Kaitai's switch-on requires a previously
      // declared field, so we keep the existing "first case only" lowering.
      if (c.on.kind === "peek") {
        ctx.psdlOnly.push(
          `Switch "${c.id}" dispatches on peek(bits=${c.on.bits}) — lookahead not modelled in Kaitai`,
        );
      }
      ctx.psdlOnly.push(
        `Switch "${c.id}" lowered to first case only (Kaitai switch-on type requires uniform field shapes).`,
      );
      const firstKey = Object.keys(c.cases)[0];
      if (!firstKey) return [];
      const first = c.cases[firstKey];
      return first.fields.flatMap((ch) => containerToKsy(ch, ctx));
    }
    case "optional": {
      // PSDL 0.5 Optional may wrap any container. Kaitai's `if:` only attaches
      // to a single seq entry, so we can only carry the predicate when the
      // inner container is a leaf Field; compound containers are emitted
      // unconditionally with a psdl-only note.
      if (!isField(c.container)) {
        const childSeq = containerToKsy(c.container, ctx);
        const ifExpr = exprToKaitaiIf(c.when);
        // When the predicate is Kaitai-expressible, wrap the children in a
        // synthetic substream type carrying the `if:` so the region is only
        // consumed when `when` is true — otherwise a false predicate would
        // still read the bytes and shift every following field. If the
        // predicate isn't expressible (peek / 0.5 expr) or there is nothing to
        // wrap, fall back to splicing unconditionally with a note.
        if (ifExpr && childSeq.length > 0) {
          const optId = toKsyId(c.id ?? "opt");
          const typeName = `${optId}_opt`;
          ctx.types[typeName] = { seq: childSeq };
          return [{ id: optId, type: typeName, if: ifExpr }];
        }
        ctx.psdlOnly.push(
          `optional "${c.id ?? "?"}" wraps a compound container — predicate ${exprToString(c.when)} left unconditional`,
        );
        return childSeq;
      }
      const inner = fieldToKsy(c.container, ctx);
      const ifExpr = exprToKaitaiIf(c.when);
      if (ifExpr) {
        inner.if = ifExpr;
      } else {
        ctx.psdlOnly.push(
          `optional "${c.id ?? c.container.id}" predicate ${exprToString(c.when)} not expressible in Kaitai — left unconditional`,
        );
      }
      return [inner];
    }
    case "encrypted": {
      // Kaitai has no encrypted concept. Emit a single byte placeholder so the
      // .ksy still parses, and record a psdl-only comment naming the context.
      // The plaintext substructure is intentionally dropped — emitting it
      // would imply the decrypted shape is also on-wire, which is misleading.
      const e = c as Encrypted;
      ctx.psdlOnly.push(
        `encrypted block "${e.id}" (${e.contextNote}) skipped — Kaitai has no encrypted primitive`,
      );
      // Derive a byte size from `wireBits` when PSDL pins it as a
      // literal; otherwise fall back to 1 so the seq entry actually
      // consumes a stream offset. The previous `size: 0` form was
      // documented as a "single byte placeholder" but read 0 bytes,
      // leaving subsequent fields overlapping the encrypted region in
      // a generated parser. Evaluating a non-literal Expr would need
      // an `env` that the exporter doesn't carry, so dynamic widths
      // simply degrade to the same 1-byte placeholder.
      const litBits = e.wireBits?.kind === "lit" ? e.wireBits.value : null;
      const sizeBytes =
        litBits !== null && litBits > 0 ? Math.ceil(litBits / 8) : 1;
      return [
        {
          id: toKsyId(e.id),
          size: sizeBytes,
          doc: `psdl-only: encrypted block (${e.contextNote})`,
        },
      ];
    }
    case "bounded": {
      // PSDL 0.5 — a Bounded is a declared byte budget around its children.
      // Splicing the children inline (the old behaviour) loses the budget, so
      // when `bounded.bytes` exceeds the sum of its children every following
      // seq entry reads from the wrong offset. Kaitai models a fixed byte
      // budget as a SUBSTREAM: a seq entry with `size:` and a synthetic user
      // `type` whose own seq is the bounded's children (parsed against the
      // sub-stream). This preserves the budget and keeps downstream fields
      // aligned regardless of how much of the region the children consume.
      const sanitizedId = toKsyId(c.id);
      if (!isKsySizeRepresentable(c.bytes)) {
        // A 0.5 contextual budget expr (remaining / lookup / …) has no Kaitai
        // `size` form. Rather than emit `size: remaining(…)`, fall back to
        // splicing the children inline (lossy: the byte budget is dropped).
        ctx.psdlOnly.push(
          `bounded "${c.id}" byte budget (${exprToString(c.bytes)}) not representable in Kaitai — children spliced inline`,
        );
        return c.fields.flatMap((ch) => containerToKsy(ch, ctx));
      }
      const size = exprToKsySize(c.bytes);
      const childSeq = c.fields.flatMap((ch) => containerToKsy(ch, ctx));
      const entry: KsySeqEntry = { id: sanitizedId, size };
      if (childSeq.length > 0) {
        const typeName = `${sanitizedId}_body`;
        ctx.types[typeName] = { seq: childSeq };
        entry.type = typeName;
      }
      // If childSeq is empty (all children were zero-width / dropped) we fall
      // back to a sized opaque byte array, which still consumes the budget.
      ctx.psdlOnly.push(
        `bounded "${c.id}" byte budget (${exprToString(c.bytes)}) emitted as a sized Kaitai substream`,
      );
      return [entry];
    }
    case "align": {
      // PSDL 0.5 — Align pads the cursor to a `c.to`-bit boundary. The number
      // of padding bytes depends on the CURRENT stream position, not a fixed
      // width, so emit a Kaitai expression over `_io.pos` rather than a
      // constant size (a fixed size would over-/under-read and shift every
      // following field). `c.to` is a multiple of 8 (schema-enforced), so work
      // in whole bytes: pad = (toBytes - pos % toBytes) % toBytes.
      const toBytes = Math.max(1, Math.ceil(c.to / 8));
      ctx.psdlOnly.push(
        `align to ${c.to} bits lowered to a position-dependent padding size`,
      );
      return [
        {
          id: toKsyId(c.id ?? "align"),
          size: `(${toBytes} - _io.pos % ${toBytes}) % ${toBytes}`,
          doc: `psdl-only: align to ${c.to} bits`,
        },
      ];
    }
    case "virtual":
      // PSDL 0.5 — Virtual is a zero-width computed field; it has no wire
      // presence, so it cannot be a Kaitai seq entry. Record it as a note.
      ctx.psdlOnly.push(
        `virtual "${c.id}" (${exprToString(c.expr)}) is zero-width — dropped from .ksy seq`,
      );
      return [];
    case "ref":
      // PSDL 0.5 — RefContainer expands a named def transparently. Resolving it
      // needs packet.defs, which the exporter doesn't thread; surface it as a
      // psdl-only note rather than silently dropping the referenced shape.
      ctx.psdlOnly.push(
        `ref "${c.id}" → defs["${c.ref}"] not expanded in .ksy`,
      );
      return [];
    /* v8 ignore start */ // exhaustiveness guard: every Container kind is handled above
    default:
      return [];
    /* v8 ignore stop */
  }
}

function fieldToKsy(f: Field, ctx: ToCtx): KsySeqEntry {
  const entry: KsySeqEntry = { id: toKsyId(f.id) };
  if (f.category)
    ctx.psdlOnly.push(`Field "${f.id}" category "${f.category}" dropped`);
  switch (f.type.kind) {
    case "int": {
      const sig = f.type.signed ? "s" : "u";
      const bytes = Math.max(1, Math.ceil(f.type.bits / 8));
      const code =
        bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8
          ? `${sig}${bytes}`
          : null;
      if (code) entry.type = code;
      else {
        ctx.psdlOnly.push(
          `Field "${f.id}" odd int width ${f.type.bits} → b${f.type.bits}`,
        );
        entry.type = `b${f.type.bits}`;
      }
      break;
    }
    case "bits":
      entry.type = `b${f.type.n}`;
      break;
    case "bytes":
      if (isBytesDelimited(f.type.n)) {
        const delimiter = f.type.n.delimiter;
        if (delimiter.length === 1) {
          // 0.5 — single-byte delimiter maps cleanly onto Kaitai's
          // `terminator:` (a typeless byte array terminated by one byte).
          // Without a size/terminator a typeless byte field is uncompilable,
          // so this keeps the emitted .ksy valid.
          entry.terminator = delimiter[0];
        } else {
          // Multi-byte delimiter: Kaitai's `terminator:` is a single byte, so
          // there is no valid seq form. Surface a psdl-only note; the caller
          // drops the entry (see `containerToKsy`) rather than emit an
          // uncompilable, typeless, sizeless byte array.
          ctx.psdlOnly.push(
            `Field "${f.id}" delimited bytes (delimiter ${delimiter.join(",")}) not expressible as Kaitai size`,
          );
        }
      } else if (isKsySizeRepresentable(f.type.n)) {
        entry.size = exprToKsySize(f.type.n);
      } else if (f.type.n.kind === "remaining") {
        // 0.5 `remaining` = "rest of the enclosing scope" → Kaitai `size-eos`
        // (reads to the end of the current stream / substream).
        entry["size-eos"] = true;
        ctx.psdlOnly.push(
          `Field "${f.id}" size = remaining → Kaitai size-eos (reads to end of scope)`,
        );
      } else {
        // A 0.5 contextual size expr (lookup / wireSize / …) has no Kaitai
        // form. The caller drops this entry (isUnemittableSizedBytes); record
        // the note rather than emit `size: lookup(…)`.
        ctx.psdlOnly.push(
          `Field "${f.id}" size expression (${exprToString(f.type.n)}) not representable in Kaitai — field omitted`,
        );
      }
      break;
    case "enum": {
      const bytes = Math.max(1, Math.ceil(f.type.bits / 8));
      entry.type =
        bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8
          ? `u${bytes}`
          : `b${f.type.bits}`;
      ctx.psdlOnly.push(
        `Field "${f.id}" enum variants embedded as comment (not registered in enums:)`,
      );
      break;
    }
    case "varint": {
      // Kaitai has no varint primitive — fall back to a u1 placeholder and
      // surface the encoding in the psdl-only header so the reader knows
      // they need to hand-roll a custom type.
      ctx.psdlOnly.push(
        `Field "${f.id}" varint (${f.type.encoding}) lowered to u1 placeholder`,
      );
      entry.type = "u1";
      break;
    }
    case "berLength": {
      // PSDL 0.4 — Kaitai has no BER-length primitive. Emit a u1 placeholder
      // and surface a psdl-only comment so the reader knows to hand-roll
      // the proper BER definite-length decoder.
      ctx.psdlOnly.push(`Field "${f.id}" berLength lowered to u1 placeholder`);
      entry.type = "u1";
      break;
    }
  }
  if (f.doc) entry.doc = f.doc;
  // PSDL 0.4 per-field byteOrder → Kaitai per-field `endian:`.
  if (f.byteOrder === "BE") entry.endian = "be";
  else if (f.byteOrder === "LE") entry.endian = "le";
  return entry;
}

/**
 * Translate a PSDL Expr to a Kaitai `if:` clause string. Returns null when
 * the expression contains a `peek` (Kaitai cannot model lookahead) so the
 * caller can fall back to a psdl-only comment.
 */
function exprToKaitaiIf(e: Expr): string | null {
  switch (e.kind) {
    case "lit":
      return String(e.value);
    case "ref":
      return e.field;
    case "op": {
      const a = exprToKaitaiIf(e.a);
      const b = exprToKaitaiIf(e.b);
      if (a === null || b === null) return null;
      return `(${a} ${e.op} ${b})`;
    }
    case "cond": {
      const t = exprToKaitaiIf(e.test);
      const tt = exprToKaitaiIf(e.t);
      const ff = exprToKaitaiIf(e.f);
      if (t === null || tt === null || ff === null) return null;
      return `(${t} ? ${tt} : ${ff})`;
    }
    case "peek":
      return null;
    default:
      // 0.5 exprs (lookup / wireSize / prevIter / remaining / enclosing*)
      // have no Kaitai `if:` equivalent — fall back to a psdl-only comment.
      return null;
  }
}

/**
 * Resolve a Repeat's iteration count to a concrete Kaitai `repeat-expr`
 * literal using the live env, or null when env supplies nothing for it (so
 * the caller keeps the existing symbolic / eos lowering).
 *
 * Two env shapes are honoured, matching how `collectFreeRepeats`
 * (psdl-to-renderer) keys them:
 *   - eos / until repeats → the count lives under the repeat id (`c.id`).
 *   - `ref` count expressions → resolved against the named discriminator /
 *     length controller in env (e.g. `dnsAnCount`).
 * Returns the count as a string (Kaitai `repeat-expr` is an expression slot),
 * clamped to a non-negative integer. A resolved count of 0 is still emitted so
 * the empty-list semantics survive rather than reverting to `eos`.
 */
function resolveRepeatCount(c: Repeat, env: PacketEnv): string | null {
  if (env.size === 0) return null;
  // eos / until: free repeats expose the user count under the repeat id.
  if (
    c.count === "eos" ||
    (typeof c.count === "object" && "until" in c.count)
  ) {
    const raw = env.get(c.id);
    if (raw === undefined || !Number.isFinite(raw)) return null;
    return String(Math.max(0, Math.floor(raw)));
  }
  // A `ref` count is resolvable only when env actually carries the ref; a
  // missing ref leaves the symbolic field name (still valid Kaitai).
  if (typeof c.count === "object" && c.count.kind === "ref") {
    if (!env.has(c.count.field)) return null;
    return String(Math.max(0, Math.floor(evalExprOr(c.count, env, 0))));
  }
  return null;
}

function exprToKsySize(e: Expr): number | string {
  if (e.kind === "lit") return e.value;
  if (e.kind === "ref") return e.field;
  return exprToString(e);
}

function exprToString(e: Expr): string {
  switch (e.kind) {
    case "lit":
      return String(e.value);
    case "ref":
      return e.field;
    case "op":
      return `(${exprToString(e.a)} ${e.op} ${exprToString(e.b)})`;
    case "cond":
      return `(${exprToString(e.test)} ? ${exprToString(e.t)} : ${exprToString(e.f)})`;
    case "peek":
      return `peek(${e.bits}${e.offset !== undefined ? `, ${exprToString(e.offset)}` : ""})`;
    default:
      // 0.5 exprs (lookup / wireSize / prevIter / remaining / enclosing*) are
      // surfaced by kind so the reader at least sees the construct name.
      return `${(e as { kind: string }).kind}(…)`;
  }
}

function toKsyId(name: string): string {
  return sanitizeId(name, "packet");
}

/**
 * True when an Expr can be lowered to a valid Kaitai `size:` value. Kaitai
 * accepts integer literals, field references, arithmetic (`op`) and ternary
 * (`cond`) over those. The PSDL 0.5 contextual exprs (`peek`, `lookup`,
 * `wireSize`, `prevIter`, `remaining`, `enclosing*`) have no Kaitai expression
 * form — emitting them produces `kind(…)` strings (with a Unicode ellipsis)
 * that fail kaitai-struct-compiler, so callers must NOT pass them to `size:`.
 */
function isKsySizeRepresentable(e: Expr): boolean {
  switch (e.kind) {
    case "lit":
    case "ref":
      return true;
    case "op":
      return isKsySizeRepresentable(e.a) && isKsySizeRepresentable(e.b);
    case "cond":
      return (
        isKsySizeRepresentable(e.test) &&
        isKsySizeRepresentable(e.t) &&
        isKsySizeRepresentable(e.f)
      );
    default:
      // peek + every 0.5 contextual expr
      return false;
  }
}

/**
 * True when a `bytes` field has no emittable Kaitai seq form and must be
 * dropped (with a psdl-only note) rather than producing uncompilable YAML:
 * a multi-byte delimiter, or a size expression that is neither Kaitai-
 * representable nor `remaining` (which maps to `size-eos`).
 */
function isUnemittableSizedBytes(f: Field): boolean {
  if (f.type.kind !== "bytes") return false;
  const n = f.type.n;
  if (isBytesDelimited(n)) return n.delimiter.length !== 1;
  return !isKsySizeRepresentable(n) && n.kind !== "remaining";
}
