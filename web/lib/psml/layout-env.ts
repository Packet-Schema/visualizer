import { resolveLayout } from "./layout";
import { initialEnv } from "./normalize";
import type { ControllerState, ResolvedLayout } from "./renderer";
import type { Expr, Packet as PsmlPacket, PacketEnv, ViewMode } from "./types";

// PSML packet 内で参照されている ref フィールド名を全て集める。
// PacketViewer / EmbedViewer の env 構築で controllers に無い ref を
// fallback seed するために使う。 PSML 0.4 の全 Container kind (group /
// switch / repeat / encrypted / optional) を再帰的に walk する。
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
  type AnyNode = {
    kind?: string;
    type?: { kind: string; n?: Expr };
    children?: AnyNode[];
    element?: { fields: AnyNode[] };
    cases?: Record<string, { fields: AnyNode[] }>;
    default?: { fields: AnyNode[] };
    on?: Expr;
    count?: Expr | string | { until: Expr };
    plaintext?: { fields: AnyNode[] };
    wireBits?: Expr;
    when?: Expr;
    field?: AnyNode;
  };
  const walk = (containers: AnyNode[]): void => {
    for (const c of containers) {
      if (!c.kind || c.kind === "field") {
        if (c.type?.kind === "bytes" && c.type.n) visit(c.type.n);
        continue;
      }
      if (c.kind === "group" && c.children) walk(c.children);
      if (c.kind === "switch") {
        if (c.on) visit(c.on);
        for (const v of Object.values(c.cases ?? {})) walk(v.fields);
        if (c.default) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (c.count && typeof c.count === "object" && "kind" in c.count) {
          visit(c.count as Expr);
        } else if (
          c.count &&
          typeof c.count === "object" &&
          "until" in c.count
        ) {
          visit(c.count.until);
        }
        if (c.element) walk(c.element.fields);
      }
      if (c.kind === "encrypted") {
        if (c.wireBits) visit(c.wireBits);
        if (c.plaintext) walk(c.plaintext.fields);
      }
      if (c.kind === "optional") {
        if (c.when) visit(c.when);
        if (c.field) walk([c.field]);
      }
    }
  };
  walk(packet.body as AnyNode[]);
  return out;
}

export function buildLayoutEnv(
  packet: PsmlPacket,
  controllers: ControllerState,
  refs: Iterable<string> = collectPsmlRefs(packet),
): PacketEnv {
  const env = new Map(
    Object.entries(controllers).map(([k, v]) => [k, Number(v)] as const),
  );

  // Derive secondary repeat-count keys for presets whose UI slider drives a
  // bytes-counter rather than the PSML count ref. This keeps IPv4/TCP option
  // repeats in sync for both the full viewer and the embed view.
  const ihl = env.get("ihl") ?? 5;
  env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
  const off = env.get("dataOffset") ?? 5;
  env.set("tcpOptionsCount", Math.max(0, off - 5));

  const packetDefaults = initialEnv(packet);
  for (const [k, v] of packetDefaults) {
    if (!env.has(k)) env.set(k, v);
  }
  for (const r of refs) {
    if (!env.has(r)) env.set(r, 0);
  }
  return env;
}

export function resolvePsmlLayout(
  packet: PsmlPacket,
  controllers: ControllerState,
  viewMode: ViewMode = "wire",
  refs?: Iterable<string>,
): ResolvedLayout {
  return resolveLayout(packet, {
    env: buildLayoutEnv(packet, controllers, refs),
    viewMode,
  });
}
