import type { Container, Expr, Packet as PsmlPacket } from "./types";

/**
 * PSML packet 内で参照されている ref フィールド名を全て集める。
 * PSML 0.4 の全 Container kind (group / switch / repeat / encrypted / optional) を再帰的に walk する。
 *
 * 用途: env 構築時に missing reference を事前に 0 で seed するため。
 * これにより resolveLayout が確実に 1 回で成功する。
 */
export function collectPsmlRefs(packet: PsmlPacket): Set<string> {
  const out = new Set<string>();
  const visit = (e: Expr): void => {
    switch (e.kind) {
      case "lit":
        return;
      case "ref":
        out.add(e.field);
        return;
      case "op":
        visit(e.a);
        visit(e.b);
        return;
      case "cond":
        visit(e.test);
        visit(e.t);
        visit(e.f);
        return;
      case "peek":
        if (e.offset) visit(e.offset);
        return;
    }
  };
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      if (!c.kind || c.kind === "field") {
        if (c.type.kind === "bytes") visit(c.type.n);
        continue;
      }
      if (c.kind === "group") walk(c.children);
      if (c.kind === "switch") {
        visit(c.on);
        for (const v of Object.values(c.cases)) walk(v.fields);
        if (c.default) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (typeof c.count === "object" && "kind" in c.count) {
          visit(c.count);
        } else if (typeof c.count === "object" && "until" in c.count) {
          visit(c.count.until);
        }
        walk(c.element.fields);
      }
      if (c.kind === "encrypted") {
        if (c.wireBits) visit(c.wireBits);
        walk(c.plaintext.fields);
      }
      if (c.kind === "optional") {
        visit(c.when);
        walk([c.field]);
      }
    }
  };
  walk(packet.body);
  return out;
}
