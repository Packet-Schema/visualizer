// PSML → .ksy exporter.
//
// Lossy by design: PSML constructs Kaitai cannot model (categories,
// constraints, switches on non-integer discriminators, peek expressions,
// encrypted blocks) are surfaced as `# psml-only:` comments at the top of
// the emitted YAML so the reader knows what was elided.

import { stringify as yamlStringify } from "yaml";

import { sanitizeId } from "../common";
import type {
  Container,
  Encrypted,
  Expr,
  Field,
  Packet,
} from "../../psml/types";

import type { KsyRoot, KsySeqEntry, KsyType } from "./types";

/** Serialise a PSML packet to Kaitai .ksy YAML (best-effort, lossy). */
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

  const psmlOnly: string[] = [];
  const types: Record<string, KsyType> = {};

  const seq: KsySeqEntry[] = [];
  for (const c of packet.body) {
    seq.push(...containerToKsy(c, { types, psmlOnly }));
  }
  ksy.seq = seq;
  if (Object.keys(types).length > 0) ksy.types = types;

  if (packet.constraints && packet.constraints.length > 0) {
    psmlOnly.push(
      `${packet.constraints.length} PSML constraint(s) not representable in .ksy`,
    );
  }

  let yamlText = yamlStringify(ksy, {
    lineWidth: 100,
    aliasDuplicateObjects: false,
  });

  if (psmlOnly.length > 0) {
    const header =
      psmlOnly.map((m) => `# psml-only: ${m}`).join("\n") + "\n";
    yamlText = header + yamlText;
  }
  return yamlText;
}

type ToCtx = {
  types: Record<string, KsyType>;
  psmlOnly: string[];
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
      const entry: KsySeqEntry = {
        id: c.id,
        repeat: "eos",
      };
      // Hoist the first field of the element as the entry's "type" if it's a
      // single field; otherwise create a synthetic user type.
      const child = c.element.fields[0];
      if (c.element.fields.length === 1 && child && (!("kind" in child) || child.kind === "field")) {
        const f = child as Field;
        const proxy = fieldToKsy(f, ctx);
        Object.assign(entry, proxy, { id: c.id });
      } else {
        const typeName = `${c.id}_elem`;
        ctx.types[typeName] = {
          seq: c.element.fields.flatMap((ch) => containerToKsy(ch, ctx)),
        };
        entry.type = typeName;
      }
      if (typeof c.count === "object" && c.count !== null && "kind" in c.count) {
        entry.repeat = "expr";
        entry["repeat-expr"] = exprToString(c.count);
      } else if (typeof c.count === "object" && "until" in (c.count as object)) {
        entry.repeat = "until";
        entry["repeat-until"] = exprToString(
          (c.count as { until: Expr }).until,
        );
      }
      return [entry];
    }
    case "switch": {
      // PSML 0.4 — if the discriminator is a peek() expression, surface that
      // as a psml-only comment alongside the (still-lowered) Switch so the
      // .ksy reader knows the dispatch happens on a lookahead rather than a
      // declared sibling field. Kaitai's switch-on requires a previously
      // declared field, so we keep the existing "first case only" lowering.
      if (c.on.kind === "peek") {
        ctx.psmlOnly.push(
          `Switch "${c.id}" dispatches on peek(bits=${c.on.bits}) — lookahead not modelled in Kaitai`,
        );
      }
      ctx.psmlOnly.push(
        `Switch "${c.id}" lowered to first case only (Kaitai switch-on type requires uniform field shapes).`,
      );
      const firstKey = Object.keys(c.cases)[0];
      if (!firstKey) return [];
      const first = c.cases[firstKey];
      return first.fields.flatMap((ch) => containerToKsy(ch, ctx));
    }
    case "optional": {
      // PSML 0.4 Optional — emit `if:` if the predicate is a simple ref
      // (Kaitai accepts a name), otherwise drop to a psml-only comment.
      const inner = fieldToKsy(c.field, ctx);
      const ifExpr = exprToKaitaiIf(c.when);
      if (ifExpr) {
        inner.if = ifExpr;
      } else {
        ctx.psmlOnly.push(
          `optional "${c.id ?? c.field.id}" predicate ${exprToString(c.when)} not expressible in Kaitai — left unconditional`,
        );
      }
      return [inner];
    }
    case "encrypted": {
      // Kaitai has no encrypted concept. Emit a single byte placeholder so the
      // .ksy still parses, and record a psml-only comment naming the context.
      // The plaintext substructure is intentionally dropped — emitting it
      // would imply the decrypted shape is also on-wire, which is misleading.
      const e = c as Encrypted;
      ctx.psmlOnly.push(
        `encrypted block "${e.id}" (${e.contextNote}) skipped — Kaitai has no encrypted primitive`,
      );
      return [
        {
          id: toKsyId(e.id),
          size: 0,
          doc: `psml-only: encrypted block (${e.contextNote})`,
        },
      ];
    }
    /* v8 ignore start */ // exhaustiveness guard: every Container kind is handled above
    default:
      return [];
    /* v8 ignore stop */
  }
}

function fieldToKsy(f: Field, ctx: ToCtx): KsySeqEntry {
  const entry: KsySeqEntry = { id: toKsyId(f.id) };
  if (f.category) ctx.psmlOnly.push(`Field "${f.id}" category "${f.category}" dropped`);
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
        ctx.psmlOnly.push(`Field "${f.id}" odd int width ${f.type.bits} → b${f.type.bits}`);
        entry.type = `b${f.type.bits}`;
      }
      break;
    }
    case "bits":
      entry.type = `b${f.type.n}`;
      break;
    case "bytes":
      entry.size = exprToKsySize(f.type.n);
      break;
    case "enum": {
      const bytes = Math.max(1, Math.ceil(f.type.bits / 8));
      entry.type =
        bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8
          ? `u${bytes}`
          : `b${f.type.bits}`;
      ctx.psmlOnly.push(
        `Field "${f.id}" enum variants embedded as comment (not registered in enums:)`,
      );
      break;
    }
    case "varint": {
      // Kaitai has no varint primitive — fall back to a u1 placeholder and
      // surface the encoding in the psml-only header so the reader knows
      // they need to hand-roll a custom type.
      ctx.psmlOnly.push(
        `Field "${f.id}" varint (${f.type.encoding}) lowered to u1 placeholder`,
      );
      entry.type = "u1";
      break;
    }
    case "berLength": {
      // PSML 0.4 — Kaitai has no BER-length primitive. Emit a u1 placeholder
      // and surface a psml-only comment so the reader knows to hand-roll
      // the proper BER definite-length decoder.
      ctx.psmlOnly.push(
        `Field "${f.id}" berLength lowered to u1 placeholder`,
      );
      entry.type = "u1";
      break;
    }
  }
  if (f.doc) entry.doc = f.doc;
  // PSML 0.4 per-field byteOrder → Kaitai per-field `endian:`.
  if (f.byteOrder === "BE") entry.endian = "be";
  else if (f.byteOrder === "LE") entry.endian = "le";
  return entry;
}

/**
 * Translate a PSML Expr to a Kaitai `if:` clause string. Returns null when
 * the expression contains a `peek` (Kaitai cannot model lookahead) so the
 * caller can fall back to a psml-only comment.
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
  }
}

function toKsyId(name: string): string {
  return sanitizeId(name, "packet");
}
