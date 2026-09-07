// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { exprRefs } from "../expr";
import { isBytesDelimited } from "../normalize";
import type {
  Container,
  NamedStruct,
  Packet as PsdlPacket,
  Struct,
  Switch,
} from "../types";
import { defaultArmSentinel, firstCaseKeyValue, prettifyId } from "./shared";
import { flattenForMirrorGuarded } from "./mirror-flatten";

/**
 * Build a human-readable label for a single Switch case, used to qualify the
 * name of a freeRepeat surfaced from INSIDE that case so colliding labels
 * (icmpv6Ndp's five `Options` repeats, one per Type case; msdp's two `SA
 * Entries`, in the SA and SA-Response cases) become distinct and the user can
 * tell which stepper is live (override-design-audit). Preference order:
 *   1. the discriminator enum's variant label for the case key (msdp:
 *      `msdpType` enum → "SA-Response"),
 *   2. the discriminator field's display name and value (icmpv6Ndp: `type` is a
 *      plain int → "Type=133").
 * Returns null for the `_` default arm (no meaningful selector value).
 */
export function switchCaseLabel(
  on: Switch["on"],
  caseKey: string,
  enumVariants: Map<string, Record<string, string>>,
  fieldNames: Map<string, string>,
): string | null {
  const value = firstCaseKeyValue(caseKey);
  if (value === null) return null;
  if (on.kind === "ref") {
    const variants = enumVariants.get(on.field);
    const label = variants?.[String(value)];
    if (label) return label;
    return `${fieldNames.get(on.field) ?? on.field}=${value}`;
  }
  return `case ${value}`;
}

/**
 * True when EVERY case arm of a Switch collapses to zero visible width at the
 * default env — i.e. every field in every case is a variable-length `bytes`
 * value whose length `n` is a `ref` (or expr) mentioning ONLY field ids with no
 * surfaced override control (`controlledIds`). Such a value renders at width 0
 * for all reachable env states, so selecting any discriminator value produces a
 * byte-identical diagram — the picker is inert (isisLsp's `byType` on tlvType:
 * each arm is `bytes(ref tlvLength)`, and tlvLength has no control anywhere).
 *
 * Returns false the moment any case carries something the picker COULD make
 * visible: a fixed-width field, a delimited/varint value (seeded to a visible
 * default), a `bytes` whose length ref IS controllable, or a nested non-field
 * container — so a genuinely variant-driving picker (dnsResponse dnsRrType, with
 * fixed-width A/AAAA records) is never suppressed.
 */
export function switchArmsAllZeroWidth(
  cases: Record<string, { fields: Container[] }>,
  controlledIds: Set<string>,
): boolean {
  const armCollapses = (containers: Container[]): boolean => {
    // An empty arm has nothing to distinguish it; treat as collapsing so it
    // doesn't single-handedly keep an otherwise-inert picker alive.
    for (const c of containers) {
      if (!isField(c)) return false; // nested container: assume it can show
      if (c.type.kind !== "bytes") return false; // fixed-width: visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return false; // seeded to a visible default
      const refs = exprRefs(n);
      // No refs at all → not a sibling-ref-sized value (lit/varint-ish): the
      // length isn't gated by an uncontrolled sibling, so don't suppress.
      if (refs.length === 0) return false;
      // Any length ref the user CAN drive means the picked arm can be made
      // visible — keep the picker.
      if (refs.some((r) => controlledIds.has(r))) return false;
    }
    return true;
  };
  const arms = Object.values(cases);
  if (arms.length === 0) return false;
  return arms.every((s) => armCollapses(s.fields));
}

/**
 * When `switchArmsAllZeroWidth` would suppress a picker, decide whether the
 * collapse is caused EXCLUSIVELY by uncontrolled PER-RECORD sibling length
 * fields (declared inside the switch cases / repeat element, like isisLsp's
 * `tlvLength`). If so, return those length-field ids: instead of suppressing the
 * picker we surface it AND seed those lengths to a representative width, so the
 * chosen arm's `bytes(ref length)` value becomes visible and editable (the
 * KNOWN-REMAINING #7/#8 fix). Returns null when seeding cannot rescue the
 * picker — an empty arm, a fixed-width/visible arm (the picker is already live,
 * not collapsed), or a `bytes` length ref that is NOT a per-record sibling (a
 * top-level field that has its own surfacing path, or an expr we shouldn't
 * blindly seed) — so the existing suppression still applies in those cases.
 */
export function switchArmsZeroWidthSiblingLengths(
  cases: Record<string, { fields: Container[] }>,
  controlledIds: Set<string>,
  perRecordFieldIds: Set<string>,
): Set<string> | null {
  const lengths = new Set<string>();
  const armLengths = (containers: Container[]): Set<string> | null => {
    // An empty arm distinguishes nothing and can't be rescued by a length seed.
    if (containers.length === 0) return null;
    const out = new Set<string>();
    for (const c of containers) {
      if (!isField(c)) return null; // nested container: not a simple value arm
      if (c.type.kind !== "bytes") return null; // fixed-width: already visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return null; // seeded elsewhere (visible default)
      const refs = exprRefs(n);
      if (refs.length === 0) return null; // not sibling-ref sized
      for (const r of refs) {
        if (controlledIds.has(r)) return null; // already controllable → not inert
        // Only a single per-record sibling length is safe to seed; anything else
        // (a top-level uncontrolled field, an unknown id) we leave suppressed.
        if (!perRecordFieldIds.has(r)) return null;
        out.add(r);
      }
    }
    return out;
  };
  const arms = Object.values(cases);
  if (arms.length === 0) return null;
  for (const s of arms) {
    const armOut = armLengths(s.fields);
    if (armOut === null) return null;
    for (const id of armOut) lengths.add(id);
  }
  return lengths.size > 0 ? lengths : null;
}

/**
 * The MIXED-width counterpart of `switchArmsZeroWidthSiblingLengths`. A picker
 * is NOT suppressed (it has at least one fixed-width / visible arm, so
 * `switchArmsAllZeroWidth` already returns false), yet SOME of its arms still
 * collapse to width 0 because they are a single `bytes(ref <siblingLen>)` value
 * whose per-record length defaults to 0 (dnsResponse's `dnsRdata`: A/AAAA/MX/
 * SRV/SOA are fixed-width and visible, but NS/CNAME/PTR/TXT and the `_` raw arm
 * are each `bytes(ref dnsRdLength)`). Selecting one of those collapsed arms at
 * the default env renders an EMPTY record — the picker contradicts the diagram
 * even though the discriminator genuinely drives the visible arms (#11/#12).
 *
 * Collect the per-record sibling length ids consumed ONLY by the width-0 arms,
 * skipping (not bailing on) the fixed-width / visible / nested-container arms.
 * The caller seeds those lengths to a representative width so EVERY selectable
 * arm — not just the fixed-width ones — renders at load. Returns null when no
 * collapsed arm is rescuable this way (no collapsed `bytes(ref <perRecordLen>)`
 * arm exists, or a collapsed arm's length ref is not a per-record sibling we can
 * safely seed — leaving the picker-as-is, since the fixed-width arms still drive
 * the diagram). Seeds fill only unset/0 env, so a user-set width still wins.
 */
export function switchArmsMixedCollapsedSiblingLengths(
  cases: Record<string, { fields: Container[] }>,
  perRecordFieldIds: Set<string>,
): Set<string> | null {
  const lengths = new Set<string>();
  // Per-arm: returns the set of seedable per-record sibling lengths if this arm
  // collapses to width-0 `bytes(ref siblingLen)` values, `null` if it is a
  // VISIBLE / fixed-width / nested / not-rescuable arm we should simply skip.
  const armCollapsedLengths = (containers: Container[]): Set<string> | null => {
    if (containers.length === 0) return null; // empty arm: nothing to seed
    const out = new Set<string>();
    for (const c of containers) {
      if (!isField(c)) return null; // nested container: assume visible — skip
      if (c.type.kind !== "bytes") return null; // fixed-width: already visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return null; // seeded elsewhere (visible default)
      const refs = exprRefs(n);
      if (refs.length === 0) return null; // not sibling-ref sized
      for (const r of refs) {
        // Only a real PER-RECORD sibling length is safe to seed (a representative
        // width on the record's own length field, not a shared top-level one).
        // Unlike the all-zero-width rescue, a CONTROLLED length ref does NOT bail
        // here: dnsRdLength is surfaced as a lengthController (so the picker isn't
        // strictly inert — the user CAN reveal the arm), yet at the default env it
        // is 0 and the collapsed arm still shows nothing. Seeding it (only when
        // unset/0, so a user width still wins) is exactly what makes the picker
        // agree with the diagram on load.
        if (!perRecordFieldIds.has(r)) return null;
      }
      for (const r of refs) out.add(r);
    }
    return out;
  };
  for (const s of Object.values(cases)) {
    const armOut = armCollapsedLengths(s.fields);
    if (armOut === null) continue; // visible / non-rescuable arm: skip, don't bail
    for (const id of armOut) lengths.add(id);
  }
  return lengths.size > 0 ? lengths : null;
}

/**
 * Distinguish a length-EXTENSION encoder (a sub-byte nibble/flag whose arms only
 * tack a length-extension field onto an already-being-decoded length — CoAP's
 * `byOptDelta`/`byOptLength` 13/14 sentinels, BGP's `bgpAttrLengthByExt`
 * extended-length flag) from a genuine VARIANT SELECTOR (a sub-byte
 * discriminator that picks WHICH substantive cells render — lwm2mRegister's
 * `byIdLen` choosing the 8- vs 16-bit Identifier, `byTypeOfLength` choosing the
 * Length-field width and the short-vs-explicit Value layout).
 *
 * Driving a length encoder desyncs the encoded length / over-consumes a bounded
 * scope, so those stay suppressed (they have no `controlsLength`-free meaning).
 * But a variant selector genuinely changes the user-visible record skeleton, so
 * suppressing it leaves a see-but-cannot-edit gap. The signal: a pure
 * length-extension encoder's every non-empty arm consists SOLELY of
 * `category: "length"` fields (the extension bytes). The moment any arm carries a
 * non-length substantive field (an `identifier`, a `variable` Value, …) the
 * switch is choosing a record variant, not merely extending a length.
 */
export function subByteDiscriminatorSelectsVariant(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const armIsLengthOnly = (containers: Container[]): boolean => {
    // An empty arm contributes no substantive field — treat as length-only so a
    // lone empty arm can't masquerade as a variant.
    for (const c of containers) {
      // A nested container (group/switch/repeat/…) is structural content the
      // discriminator selects between — that is a variant, not a length nibble.
      if (!isField(c)) return false;
      if (c.category !== "length") return false;
    }
    return true;
  };
  return Object.values(cases).some((s) => !armIsLengthOnly(s.fields));
}

/**
 * True for a TOP-LEVEL length-EXTENSION switch whose arms insert Extended-Length
 * value cells of STRUCTURALLY DISTINCT WIDTH (websocketFrame `byPayloadLength7`:
 * `payloadLength7` == 126 → a 16-bit `extPayloadLength16`, == 127 → a 64-bit
 * `extPayloadLength64`, default `_` → nothing). Such a switch is shaped exactly
 * like a length encoder — the discriminator is `lengthDriving` (the trailing
 * `payload` width reads it) AND sub-byte with `category: "length"` arms
 * (`subByteDiscriminatorSelectsVariant` is false) — so the encoder gate would
 * suppress it. But unlike a CoAP/BGP nibble — whose extension bytes re-encode an
 * already-decoded length inside a BOUNDED record and whose arm widths collapse to
 * the SAME budget — toggling this discriminator visibly GAINS or LOSES a
 * fixed-width Extended-Length cell on the diagram (126 ≠ 127 ≠ default in both
 * presence AND width). The user can SEE that cell on a 126/127 frame but, with
 * the switch suppressed, has no control to toggle it off or reach the
 * discriminator (it is sub-byte AND group-nested) — a see-but-cannot-edit gap.
 * Surfacing the picker is therefore safe and required.
 *
 * The signal that separates this from a true length encoder: the arms render
 * DISTINCT fixed (non-`bytes(ref …)`) widths — at least two selectable/default
 * arms whose collapsed structural shape differs — so selecting a value genuinely
 * changes the rendered geometry rather than re-encoding the same byte count. A
 * repeat-nested encoder (CoAP `byOptDelta`/`byOptLength`, BGP `bgpAttrLengthByExt`)
 * is NEVER passed here (the caller only consults this for a non-repeat,
 * group/case-nested switch), so their suppression stays untouched.
 */
export function lengthExtensionArmsHaveDistinctWidths(
  cases: Record<string, { fields: Container[] }>,
  defaultArm: { fields: Container[] } | undefined,
): boolean {
  // A fixed-width arm is one whose every field has a statically-known bit width
  // (an `int`/`bits`/`enum` with a literal `bits`/`n`) — NOT a `bytes(ref …)`
  // whose width depends on a length ref (which would collapse to a budget the
  // encoder gate already handles). An empty arm is fixed-width 0.
  const armFixedWidthShape = (containers: Container[]): string | null => {
    const parts: string[] = [];
    for (const c of containers) {
      if (!isField(c)) return null; // structural content — not a plain ext field
      const t = c.type as { kind?: string; bits?: number; n?: unknown };
      const w =
        typeof t.bits === "number"
          ? t.bits
          : typeof t.n === "number"
            ? t.n
            : null;
      if (w === null) return null; // dynamic / ref-sized width — not a fixed ext
      parts.push(`${t.kind ?? "?"}:${w}`);
    }
    return parts.join(",");
  };
  const shapes = new Set<string>();
  let sawNonEmpty = false;
  for (const struct of Object.values(cases)) {
    const shape = armFixedWidthShape(struct.fields);
    if (shape === null) return false;
    if (shape !== "") sawNonEmpty = true;
    shapes.add(shape);
  }
  if (defaultArm) {
    const shape = armFixedWidthShape(defaultArm.fields);
    if (shape === null) return false;
    shapes.add(shape);
  }
  // Need at least one real extension cell AND ≥ 2 distinct geometries, so the
  // discriminator visibly toggles a fixed-width region (126/127/default differ).
  return sawNonEmpty && shapes.size >= 2;
}

/**
 * Structural fingerprint of a container that ignores identity-only fields
 * (`id`, `name`, `doc`, …) and keeps everything that affects the rendered
 * geometry: the node `kind`, a field's `type`, a Switch's discriminator and
 * arm shapes, a Repeat's count, a Bounded's budget, etc. Two containers with
 * the same fingerprint resolve to a byte-identical layout for every env — they
 * differ only in labels.
 */
export function structuralShape(c: Container): unknown {
  if (isField(c)) return ["field", c.type];
  switch (c.kind) {
    case "switch":
      return [
        "switch",
        c.on,
        Object.entries(c.cases).map(([k, v]) => [
          k,
          v.fields.map(structuralShape),
        ]),
      ];
    case "repeat":
      return ["repeat", c.count, c.element.fields.map(structuralShape)];
    case "group":
      return ["group", c.children.map(structuralShape)];
    case "optional":
      return ["optional", c.when, structuralShape(c.container)];
    case "bounded":
      return ["bounded", c.bytes, c.fields.map(structuralShape)];
    case "encrypted":
      return ["encrypted", c.plaintext.fields.map(structuralShape)];
    case "ref":
      return ["ref", c.ref];
    case "align":
      return ["align", c.to];
    case "virtual":
      return ["virtual", c.expr];
  }
}

/**
 * True when EVERY selectable case arm of a `ref`-discriminated Switch is
 * STRUCTURALLY IDENTICAL (same ordered field shapes, ignoring ids/names) — so
 * choosing any value of the discriminator yields a byte-identical layout and
 * the case picker is inert. Catches tlsHandshake `handshakeType` (10 arms, each
 * a single `bytes(ref tlsHandshakeBodyLen)` opaque body), which
 * `attachOverrideMetadata` would otherwise stamp as a multi-option `switchCases`
 * dropdown that can never change the diagram. Requires ≥ 2 selectable arms: a
 * single-arm switch is a degenerate (non-multi-option) picker left untouched.
 *
 * The default (`_`) arm IS folded into the comparison: while it is not itself a
 * user-selectable value, an unlisted discriminator value falls into it, so a
 * structurally-DIFFERENT `_` arm means the diagram visibly gains/loses fields as
 * the discriminator changes. We suppress here only when the `_` arm's shape ALSO
 * equals the selectable arms' shape. tlsHandshake / snmpV2c stay suppressed
 * (their `_` arm is the same opaque `bytes(ref …)` body).
 *
 * NOTE: for a FIELD-LEVEL `switchCases` picker (no synthetic `_`-reaching
 * option), an all-identical LISTED-arm set is inert even when the `_` arm
 * differs, because the dropdown can never offer a `_`-reaching value — that
 * stronger gate is `listedArmsAllIdentical` (eap's `eapCode`), applied below.
 */
export function switchArmsAllIdentical(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (selectable.length < 2) return false;
  const shapes = selectable.map(([, struct]) =>
    JSON.stringify(struct.fields.map(structuralShape)),
  );
  if (!shapes.every((s) => s === shapes[0])) return false;
  // A present `_` default arm must match the selectable shape too: otherwise an
  // out-of-list discriminator value renders a structurally different layout and
  // the picker meaningfully drives the diagram.
  const defaultArm = cases["_"];
  if (defaultArm) {
    const defaultShape = JSON.stringify(defaultArm.fields.map(structuralShape));
    if (defaultShape !== shapes[0]) return false;
  }
  return true;
}

/**
 * Like `switchArmsAllIdentical`, but considers ONLY the LISTED (user-selectable)
 * arms — it does NOT fold the `_` default arm into the comparison. Returns true
 * when every selectable arm is mutually structurally identical, regardless of
 * whether a present `_` arm differs.
 *
 * This is the inert-ness test for a FIELD-LEVEL `switchCases` picker. Unlike a
 * surfaced ref/peek Switch — for which `defaultArmSyntheticCase` can synthesise
 * an extra option that reaches a structurally-distinct `_` arm — a field-level
 * `switchCases` dropdown only ever offers the LISTED case values; it can never
 * select the `_` arm. So if those listed arms are all identical, the dropdown is
 * inert (no listed value changes the diagram) even when the `_` arm differs, and
 * surfacing it is a see-but-cannot-edit / surface-collision control.
 *
 * eap's `eapCode` is the sole preset field this catches: its listed arms 1
 * (Request) / 2 (Response) are byte-identical (`eapType` + `eapTypeData`), while
 * its `_` arm `eapNoBody` is EMPTY. Codes 3 / 4 (Success / Failure) fall into
 * `_` and drop the body — but those values are NOT in the switch's case list, so
 * the switch dropdown (offering only 1 / 2) can never reach them. `eapCode` is
 * ALSO an `enum(8)` discriminator covering 1–4, and that EnumDropdown — writing
 * the same `env[eapCode]` key — already drives every meaningful state (including
 * the empty `_` body at 3 / 4). The switch picker therefore adds nothing but an
 * inert, raw-labelled control fighting the enum for one key; suppress it.
 */
export function listedArmsAllIdentical(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (selectable.length < 2) return false;
  const shapes = selectable.map(([, struct]) =>
    JSON.stringify(struct.fields.map(structuralShape)),
  );
  return shapes.every((s) => s === shapes[0]);
}

/**
 * When a surfaced ref/peek Switch carries a `_` default arm whose structural
 * shape differs from EVERY listed (selectable) case, return a synthetic picker
 * option that reaches it: a sentinel discriminator value (not covered by any
 * listed key, so core's `selectArm` falls through to `_`) plus a "default"
 * label. Otherwise `null` — the `_` arm is absent, or it renders the same
 * skeleton as a listed case, so no extra option is warranted.
 *
 * Without this, a switch whose lone listed case is structurally distinct from
 * the `_` arm (babel `babelTlvBody`: listed `0` is the empty Pad1, `_` is the
 * real TLV-with-body, the common case; bgpFlowSpec `flowSpecCompValue`: listed
 * `1,2` is a prefix, `_` is the numeric-operator list used by most RFC 8955
 * component types; rohcUncompressed `rohcHeader` peek: listed `126` is the IR
 * Packet, `_` is the normal datagram) offers ONLY the listed value(s) and can
 * never select the `_`-arm layout — an inert/misleading control AND a
 * representability gap for imported packets whose discriminator falls into `_`.
 * Mirrors the peek-gated-optional "(absent)" synthetic-case pattern.
 */
export function defaultArmSyntheticCase(
  cases: Record<string, Struct>,
): { value: number; label: string } | null {
  const defaultArm = cases["_"];
  if (!defaultArm) return null;
  const listed = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (listed.length === 0) return null;
  const defaultShape = JSON.stringify(defaultArm.fields.map(structuralShape));
  const differsFromAll = listed.every(
    ([, struct]) =>
      JSON.stringify(struct.fields.map(structuralShape)) !== defaultShape,
  );
  if (!differsFromAll) return null;
  const value = defaultArmSentinel(listed.map(([key]) => key));
  return {
    value,
    label: defaultArm.name ?? prettifyId(defaultArm.id) ?? "Other (default)",
  };
}

/**
 * True when a switch's `_` default arm is the canonical TLV-style
 * "opaque / unknown record" shape: a SINGLE field carrying a `bytes(ref …)`
 * value (the raw, ref-length-sized payload of a record whose type code is not
 * individually modelled — dnsResponse `dnsRdataBytes` = `bytes(ref dnsRdLength)`,
 * isisLsp `tlvValue` = `bytes(ref tlvLength)`, pimHelloOptions `unknownOptData` =
 * `bytes(ref pimHelloOptLen)`).
 *
 * Such a `_` arm is a real, RFC-defined REACHABLE state — any discriminator
 * value not in the listed case set decodes the record opaquely — yet its
 * structural fingerprint is byte-identical to any listed arm that is also a lone
 * `bytes(ref …)` value (every isisLsp arm; dnsResponse's NS/CNAME/PTR/TXT). The
 * `differs`-from-all-listed gate that drives the synthetic-default option for
 * structurally-distinct arms (babel/bgpFlowSpec) therefore wrongly suppresses
 * it, so an unknown record type is unrepresentable and an imported packet
 * carrying one cannot round-trip-select. Detecting this shape lets the caller
 * surface a sentinel "unknown / other" option EVEN WHEN the `_` shape collides
 * with a listed arm — the selection lands on an unlisted code, which is a
 * genuinely distinct, RFC-valid state. (A nested-container or fixed-width `_`
 * arm is not "opaque/unknown" and stays governed by the `differs` gate.)
 */
export function isOpaqueUnknownRecordArm(arm: {
  fields: Container[];
}): boolean {
  if (arm.fields.length !== 1) return false;
  const only = arm.fields[0];
  if (!isField(only)) return false;
  if (only.type.kind !== "bytes") return false;
  const n = only.type.n;
  if (isBytesDelimited(n)) return false;
  return exprRefs(n).length > 0;
}

/** Collect (in declaration order) the ids of every Field declared anywhere
 *  inside an arm's container list. Used to canonicalize intra-arm references so
 *  arms that differ ONLY in their field ids fingerprint identically. */
export function collectArmFieldIds(containers: Container[]): string[] {
  const ids: string[] = [];
  const walk = (cs: Container[]): void => {
    for (const c of cs) {
      if (isField(c)) {
        ids.push(c.id);
        continue;
      }
      switch (c.kind) {
        case "switch":
          for (const struct of Object.values(c.cases)) walk(struct.fields);
          break;
        case "repeat":
          walk(c.element.fields);
          break;
        case "group":
          walk(c.children);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "bounded":
          walk(c.fields);
          break;
        case "encrypted":
          walk(c.plaintext.fields);
          break;
      }
    }
  };
  walk(containers);
  return ids;
}

/**
 * Like `switchArmsAllIdentical`, but tolerant of arms that differ ONLY in the
 * field ids they declare AND in the intra-arm references that target those ids.
 * snmpV2c's `pduSwitch` has 8 selectable PDU-type arms, each the same
 * `int(8) + berLength + (int(8) + berLength + bytes(ref <siblingLen>)) × 4`
 * shape; the arms diverge only because every field id and every `bytes(ref …)`
 * length-ref is per-arm renamed (`requestIdLengthGR` vs `requestIdLengthGB` …).
 * `structuralShape` keeps the raw ref strings, so `switchArmsAllIdentical`
 * reports them as different — yet each ref points to a sibling `berLength`
 * INSIDE the same arm with no override control, so every arm resolves to the
 * SAME geometry for every reachable env: the picker is inert.
 *
 * We canonicalize each intra-arm reference to its referent's declaration index
 * (`#0`, `#1`, …) before fingerprinting. A ref to a field OUTSIDE the arm (a
 * real, potentially user-controlled discriminator) is left intact, so a picker
 * whose arms genuinely diverge stays surfaced. Requires ≥ 2 selectable arms;
 * the `_` default is excluded (not user-selectable).
 */
export function switchArmsRenderIdentical(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (selectable.length < 2) return false;
  const fingerprintArm = (containers: Container[]): string => {
    const canon = new Map<string, string>();
    collectArmFieldIds(containers).forEach((id, i) => canon.set(id, `#${i}`));
    // Replace any intra-arm ref id inside an Expr-bearing structure with its
    // canonical positional token, leaving non-arm refs untouched.
    const rewrite = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rewrite);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.kind === "ref" && typeof obj.field === "string") {
          const mapped = canon.get(obj.field);
          if (mapped) return { kind: "ref", field: mapped };
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) out[k] = rewrite(v);
        return out;
      }
      return node;
    };
    return JSON.stringify(rewrite(containers.map(structuralShape)));
  };
  const shapes = selectable.map(([, struct]) => fingerprintArm(struct.fields));
  return shapes.every((s) => s === shapes[0]);
}

/**
 * True when a Switch's selectable arms render to the SAME geometry
 * (`switchArmsRenderIdentical`) yet carry DISTINCT human-readable NAMES — so the
 * only thing a value selection changes is the visible label of the cell, not its
 * bytes. `switchArmsAllIdentical` / `switchArmsRenderIdentical` ignore names and
 * would report such a picker as inert and suppress it, but the diagram cell's
 * NAME genuinely changes per arm (a real, user-visible semantic edit), so the
 * picker must be surfaced anyway.
 *
 * QUIC's `frameByType` is exactly this: its arms 6 (CRYPTO Data) / 2,3 (ACK
 * Ranges) / 8-15 (Stream Data) / _ (Frame Payload) are all a single `bits:128`
 * body differing only by field id and NAME. In semantic view `resolveLayout`
 * draws the selected frame body and its NAME (the user clearly SEES the variant),
 * yet without this the discriminator `frameType` gets no override surface — a
 * see-but-cannot-edit gap. Mirrors the snmpV2c `pduSwitch` precedent (its 8
 * PDU-type arms differ only by name and are surfaced so the user can label the
 * PDU).
 *
 * Requires ≥ 2 selectable arms with at least two distinct names; otherwise the
 * picker would be a single-option / truly-inert control left suppressed.
 */
export function switchArmsDifferByNameOnly(
  cases: Record<string, Struct>,
): boolean {
  if (!switchArmsRenderIdentical(cases)) return false;
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  // The label a surfaced picker would show for each arm — exactly what the
  // diagram cell's name resolves to (the arm's own name, else its sole field's
  // name, else a prettified id). If two arms produce different labels, selecting
  // between them visibly relabels the diagram.
  const labelOf = (struct: Struct): string => {
    if (struct.name) return struct.name;
    const onlyField = struct.fields.length === 1 ? struct.fields[0] : undefined;
    if (onlyField && isField(onlyField) && onlyField.name)
      return onlyField.name;
    return prettifyId(struct.id) ?? struct.id;
  };
  const labels = selectable.map(([, struct]) => labelOf(struct));
  return new Set(labels).size >= 2;
}

/** Collect the ids of every field declared (transitively) INSIDE a `switch`
 *  case anywhere in the body. Such a field is never a top-level renderer-mirror
 *  cell, so `attachOverrideMetadata.findTarget` can't stamp `switchCases` on it
 *  and it gets no field-anchored widget. A nested `switch` discriminated on such
 *  a field (oncRpc's replyData/acceptData/rejectData, switched on
 *  replyStat/acceptStat/rejectStat — themselves declared inside the outer
 *  rpcBody Reply case) therefore needs a packet-level refSwitch picker. */
export function collectSwitchCaseFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  const refPath = new Set<string>();
  // Walk normally; once we step through a switch case, everything below is
  // "inside a case" — collect every field id seen there.
  const visit = (containers: Container[], insideCase: boolean): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
      if (isField(c)) {
        if (insideCase) acc.add(c.id);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) visit(struct.fields, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideCase);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideCase);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideCase);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideCase);
        continue;
      }
    }
    release();
  };
  visit(body, false);
  return acc;
}

/** Collect the ids of every field declared (transitively) INSIDE a `group`
 *  that is itself NOT inside a `switch` case and NOT inside a `repeat` — i.e. a
 *  flags / header Group spliced inline at the top level (dccp's `flagsGroup`
 *  holding the `x` bit; lisp's `lispFlags` holding lispV/lispI/lispN).
 *  `flattenForMirror` does NOT descend into groups, so such a field is never a
 *  top-level renderer-mirror cell and `attachOverrideMetadata` can't stamp a
 *  `switchCases` / `enumVariants` widget on it. A TOP-LEVEL `switch`
 *  discriminated on one of these (dccp's `seqNum` on `x`; lisp's `byLispV` on
 *  `lispV`) therefore falls through every field-anchored path AND the
 *  switch-case-nested path — a see-but-cannot-edit gap — so it needs a
 *  packet-level refSwitch picker, exactly like `collectSwitchCaseFieldIds`.
 *  Fields inside a repeat (the records get their own count / TLV / chain
 *  surface) or inside a switch case (already handled by
 *  `collectSwitchCaseFieldIds`) are deliberately excluded. */
export function collectGroupNestedFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // `insideGroup` flips true once we step into a group; `blocked` flips true
  // once we enter a repeat or a switch case, which permanently disqualifies
  // everything below (those scopes have their own override surfaces).
  const refPath = new Set<string>();
  const visit = (
    containers: Container[],
    insideGroup: boolean,
    blocked: boolean,
  ): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
      if (isField(c)) {
        if (insideGroup && !blocked) acc.add(c.id);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, true, blocked);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insideGroup, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideGroup, true);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideGroup, blocked);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideGroup, blocked);
        continue;
      }
    }
    release();
  };
  visit(body, false, false);
  return acc;
}

/** Collect the ids of every field declared (transitively) inside an `encrypted`
 *  block's plaintext that is itself NOT inside a `switch` case and NOT inside a
 *  `repeat` — i.e. a discriminator declared in an encrypted plaintext the engine
 *  renders INLINE (a header-protected scope with no fixed `wireBits`, e.g. a
 *  hypothetical decrypted-header field switch). `flattenForMirror` does NOT
 *  expose an encrypted-plaintext field as a top-level renderer-mirror cell, so
 *  `attachOverrideMetadata` can't stamp a `switchCases` widget on it, and
 *  `collectSwitchCaseFieldIds` / `collectGroupNestedFieldIds` deliberately
 *  exclude it (it is in neither a switch case nor a group). A switch
 *  discriminated on one of these therefore falls through every field-anchored
 *  path AND the switch-case / group paths — a see-but-cannot-edit gap — so it
 *  needs a packet-level refSwitch picker, exactly like the group-nested path.
 *  Mirrors `collectGroupNestedFieldIds`: fields inside a repeat (records get
 *  their own surface) or inside a switch case (handled by
 *  `collectSwitchCaseFieldIds`) are excluded.
 *
 *  CRITICAL EXCLUSION — opaque ciphertext: an `encrypted` node with a fixed
 *  `wireBits` footprint (QUIC's `payload`/`frames`, wireBits = 136 bits) is
 *  rendered by `resolveLayout` as an OPAQUE ciphertext blob in the default
 *  (wire) view; its plaintext switch is never instantiated, so the frame body
 *  cells (CRYPTO/ACK/STREAM) never appear and every selectable frameType yields
 *  a byte-identical diagram. Surfacing the plaintext discriminator (QUIC's
 *  `frameType` driving `frameByType`) there produces a permanently-inert picker
 *  whose Stream/Crypto/Ack label CONTRADICTS the opaque payload the diagram
 *  shows — a visible control with no possible effect. So an opaque
 *  (`wireBits`-bounded) encrypted node's plaintext fields are NOT collected: the
 *  whole subtree below it stays disqualified. Only an inline-rendering encrypted
 *  plaintext (no `wireBits`) contributes discriminators. Swept all 184 presets:
 *  only quicLong/quicShort carry a switch inside an opaque encrypted node. */
export function collectEncryptedNestedFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // `insideEncrypted` flips true once we step into an INLINE-rendering encrypted
  // plaintext; `blocked` flips true once we enter a repeat, a switch case, or an
  // OPAQUE (`wireBits`-bounded) encrypted node, which permanently disqualifies
  // everything below (those scopes own their surfaces or render as ciphertext).
  const refPath = new Set<string>();
  const visit = (
    containers: Container[],
    insideEncrypted: boolean,
    blocked: boolean,
  ): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
      if (isField(c)) {
        if (insideEncrypted && !blocked) acc.add(c.id);
        continue;
      }
      if (c.kind === "encrypted") {
        // A fixed `wireBits` footprint means the diagram renders this node as
        // opaque ciphertext (never instantiating the plaintext switch), so its
        // discriminators must NOT be surfaced — block the whole subtree.
        const opaque = c.wireBits !== undefined;
        visit(c.plaintext.fields, !opaque, blocked || opaque);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insideEncrypted, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideEncrypted, true);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideEncrypted, blocked);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideEncrypted, blocked);
        continue;
      }
    }
    release();
  };
  visit(body, false, false);
  return acc;
}

/** Collect the ids of TOP-LEVEL fields (declared directly in `body`, NOT inside
 *  a repeat / switch case / group / encrypted scope) whose wire width is DYNAMIC
 *  — a `varint` (or a delimiter-terminated `bytes`). Such a field's mirror has
 *  its dynamic-width encoding STRIPPED and `bits` forced to 0 whenever it ALSO
 *  carries `switchCases` (it is a switch `on:ref` discriminator), so it never
 *  hosts a fixed-width, cell-anchored `switchCases` widget the way a normal
 *  top-level int discriminator does. http3Frame's `http3FrameType` (a QUIC
 *  varint that discriminates `http3FramePayload`) is the canonical case: the
 *  diagram cell only renders via the bridged `__varintBits__` width, and the
 *  field is matched by NONE of the case/group/encrypted-nested collectors above,
 *  so `collectRefSwitches` never surfaces a packet-level picker — the whole
 *  packet's frame Type is see-but-cannot-edit from the OverridePanel. Surfacing
 *  these ids lets a TOP-LEVEL switch discriminated on one get a packet-level
 *  refSwitch picker, exactly like the case/group/encrypted-nested paths. */
export function collectTopLevelDynamicWidthFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // `blocked` flips true once we descend into a repeat, a switch case, a group,
  // or an encrypted plaintext — those scopes already own their override surfaces
  // (count steppers / case pickers / chain editors / the nested-field collectors
  // above), so a dynamic-width field there is NOT a bare top-level discriminator.
  const refPath = new Set<string>();
  const visit = (containers: Container[], blocked: boolean): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
      if (isField(c)) {
        if (
          !blocked &&
          (c.type.kind === "varint" ||
            (c.type.kind === "bytes" && isBytesDelimited(c.type.n)))
        )
          acc.add(c.id);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) visit(struct.fields, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, true);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, true);
        continue;
      }
      if (c.kind === "optional") {
        // An optional wraps a single container inline at the top level; its
        // condition does not introduce a repeat/case scope, so keep walking.
        visit([c.container], blocked);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, true);
        continue;
      }
    }
    release();
  };
  visit(body, false);
  return acc;
}

/**
 * Detect a `bytes` field whose length is a `lookup(ref X, table)` — the value's
 * width is selected from `table` by the run-time value of a sibling INT/BITS
 * discriminator `X` (LISP's `lispItrRlocAddr = bytes(lookup(ref lispItrRlocAfi,
 * {0:0, 1:4, 2:16}))`; pgm's NLA addresses). `X` is a plain int (NOT an enum and
 * NOT a Switch `on`), so it renders as a visible cell with NO enum widget and no
 * Switch picker — and at the default env X=0 the looked-up width is 0, so the
 * address region is invisible AND the user cannot raise X to reveal it: a
 * see-but-cannot-edit discriminator (and an empty, width-0 value region).
 *
 * Returns `X`'s id and the lookup `table` (value → byte width) so the caller can
 * surface a value-picker keyed on `env[X]`. Returns `null` for any other `n`
 * shape (delimited, plain ref / lit / op width, a `lookup` keyed on something
 * other than a bare field ref).
 */
export function lookupDiscriminatorOf(
  field: Container,
): { refKey: string; table: Record<number, number> } | null {
  if (!isField(field) || field.type.kind !== "bytes") return null;
  const n = field.type.n;
  if (isBytesDelimited(n)) return null;
  if (n.kind !== "lookup") return null;
  if (n.key.kind !== "ref") return null;
  return { refKey: n.key.field, table: n.table };
}

/**
 * Expand a single Switch case key to the FULL set of integer discriminator
 * values it matches: a single int ("3" → {3}), a comma-list ("1,2" → {1,2}),
 * or a range ("8-15" → {8..15}). `firstCaseKeyValue` only returns the first
 * member (enough to SELECT an arm), but to choose a representative value for
 * the `_` default arm we must know which values are already CLAIMED by the
 * explicit arms. Returns an empty set for the "_" default arm / non-numeric
 * keys.
 */
function caseKeyValues(key: string): Set<number> {
  const out = new Set<number>();
  for (const part of key.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi)
        for (let v = lo; v <= hi; v++) out.add(v);
      continue;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 0) out.add(n);
  }
  return out;
}

/**
 * Pick a representative discriminator value that selects the `_` default arm of
 * a Switch — i.e. an integer NOT claimed by any explicit (numeric) case key.
 * Preferred candidates are the discriminator's own enum variant values (so the
 * picker selection lands on a real, named protocol code — bgpFlowSpec's
 * `flowSpecCompType` 3..12 all fall into the `_` operator-list arm); failing
 * that, the smallest unclaimed non-negative integer. Returns `null` only if the
 * explicit arms somehow exhaust every candidate (no value reaches `_`).
 */
export function representativeDefaultArmValue(
  cases: Record<string, { fields: Container[] }>,
  enumVariants: Record<string, string> | undefined,
): number | null {
  const claimed = new Set<number>();
  for (const key of Object.keys(cases))
    for (const v of caseKeyValues(key)) claimed.add(v);
  if (enumVariants) {
    const variantValues = Object.keys(enumVariants)
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
    for (const v of variantValues) if (!claimed.has(v)) return v;
  }
  for (let v = 0; v < 1 << 16; v++) if (!claimed.has(v)) return v;
  return null;
}
