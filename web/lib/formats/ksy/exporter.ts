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
import type {
  Container,
  Encrypted,
  Expr,
  Field,
  Packet,
} from "../../psdl/types";

import type { KsyRoot, KsySeqEntry, KsyType } from "./types";

/** Serialise a PSDL packet to Kaitai .ksy YAML (best-effort, lossy). */
export function toKsy(packet: Packet): string {
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
    seq.push(...containerToKsy(c, { types, psdlOnly }));
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
};

function containerToKsy(c: Container, ctx: ToCtx): KsySeqEntry[] {
  // Field?
  if (!("kind" in c) || c.kind === "field") {
    return [fieldToKsy(c as Field, ctx)];
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
      if (
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
        ctx.psdlOnly.push(
          `optional "${c.id ?? "?"}" wraps a compound container — predicate ${exprToString(c.when)} left unconditional`,
        );
        return containerToKsy(c.container, ctx);
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
      // PSDL 0.5 — a Bounded is a transparent wire-scope (a declared byte
      // budget around its children). Kaitai has no equivalent scope, so we
      // splice the children inline like a Group and record the dropped budget
      // as a psdl-only note.
      ctx.psdlOnly.push(
        `bounded "${c.id}" byte budget (${exprToString(c.bytes)}) not representable in .ksy — children spliced inline`,
      );
      return c.fields.flatMap((ch) => containerToKsy(ch, ctx));
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
        // 0.5 — delimiter-terminated bytes. Kaitai's `size` can't express a
        // multi-byte delimiter; surface it as a psdl-only note and leave the
        // field unsized.
        ctx.psdlOnly.push(
          `Field "${f.id}" delimited bytes (delimiter ${f.type.n.delimiter.join(",")}) not expressible as Kaitai size`,
        );
      } else {
        entry.size = exprToKsySize(f.type.n);
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
