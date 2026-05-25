import type { Container, Expr, Packet as PsdlPacket } from "./types";

function isExpr(value: unknown): value is Expr {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as Record<string, unknown>).kind === "string"
  );
}

function isUntilCount(value: unknown): value is { until: Expr } {
  return (
    typeof value === "object" &&
    value !== null &&
    "until" in value &&
    isExpr((value as Record<string, unknown>).until)
  );
}

/**
 * PSDL packet 内で参照されている ref フィールド名を全て集める。
 * PSDL 0.4 の全 Container kind (group / switch / repeat / encrypted / optional) を再帰的に walk する。
 *
 * 用途: env 構築時に missing reference を事前に 0 で seed するため。
 * これにより resolveLayout が確実に 1 回で成功する。
 */
export function collectPsdlRefs(packet: PsdlPacket): Set<string> {
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
        if (c.type?.kind === "bytes" && c.type.n) visit(c.type.n);
        continue;
      }
      if (c.kind === "group" && c.children) walk(c.children);
      if (c.kind === "switch") {
        if (c.on) visit(c.on);
        if (c.cases) {
          for (const v of Object.values(c.cases)) {
            if (v?.fields) walk(v.fields);
          }
        }
        if (c.default?.fields) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (isExpr(c.count)) {
          visit(c.count);
        } else if (isUntilCount(c.count)) {
          visit(c.count.until);
        }
        if (c.element?.fields) walk(c.element.fields);
      }
      if (c.kind === "encrypted") {
        if (c.wireBits) visit(c.wireBits);
        if (c.plaintext?.fields) walk(c.plaintext.fields);
      }
      if (c.kind === "optional") {
        if (c.when) visit(c.when);
        if (c.field) walk([c.field]);
      }
    }
  };
  walk(packet.body);
  return out;
}
