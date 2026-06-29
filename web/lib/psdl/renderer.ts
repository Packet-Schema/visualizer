// PSDL 0.3 — renderer-facing types.
//
// The PSDL schema (./types.ts) is the canonical on-wire format. This file
// defines the *internal* shape that React components consume — cells with
// TLV/subfield/chain editing affordances, layout positions, etc. PSDL
// Packets are lowered to this shape by `psdl-to-renderer.ts` for the UI;
// formats and the diagram layout always go through PSDL directly.
//
// CategoryToken is re-exported here so callers stay on a single import path.
// ColorToken is intentionally absent from the schema; it lives in
// `web/lib/render-tokens.ts` for the per-field `color` fallback the renderer
// still consults when a category is missing.

import type { ColorToken } from "../render-tokens";
import type { CategoryToken, Expr, VarintEncoding } from "./types";

export type { ColorToken } from "../render-tokens";
export type { CategoryToken } from "./types";

export type SubField = {
  id: string;
  name: string;
  bits: number;
  description?: string;
  /** Same override hooks as Field. Populated when a Group's child is the
   *  discriminator / gate / data-dependent type — i.e. when the runtime
   *  override surface lives inside a subfield rather than a top-level
   *  Field (e.g. WebSocket's `payloadLength7` inside the byte-0 group). */
  switchCases?: { value: number; label: string }[];
  varintEncoding?: VarintEncoding;
  isBerLength?: boolean;
  /** True when this subfield's PSDL type is a delimiter-terminated `bytes`.
   *  Its width env value is a BYTE count (not bits), keyed by id. */
  isDelimited?: boolean;
  /** True when this subfield's PSDL type is `bytes(remaining)`. Width override
   *  is a BYTE count on the visualizer-only `__remainingBytes__<id>` key (see
   *  `Field.isRemaining`). */
  isRemaining?: boolean;
  optionalGateFor?: string[];
  enumVariants?: Record<number, string>;
  defaultValue?: number;
  /** Per-child byte order, mirrored from `SubCell.byteOrder` by the selection
   *  resolver so OverridePanel can surface a BE/LE toggle for a Group-nested
   *  multi-byte field (same hook as `Field.byteOrder`). */
  byteOrder?: "BE" | "LE";
};

/** A single field inside a TLV catalog entry's positional layout. */
export type TlvCatalogField = {
  id: string;
  name: string;
  bits: number;
  description?: string;
};

/** Hints for a TLV catalog entry that supports a variable count of fixed slots. */
export type TlvVariableCount = {
  key: string;
  min: number;
  max: number;
  label?: string;
};

/**
 * Hint for a single variable-LENGTH value field inside a TLV catalog entry —
 * a `bytes(ref <length>)` / delimited / varint member whose static width is
 * unknowable at design time (typeBits → 0). Each one carries a per-instance
 * byte-count knob (keyed by `key`, stored in `TlvInstance.extras`) so the
 * editor can give the value a width and `applyTlvInstances` can materialise a
 * VISIBLE cell instead of a permanently zero-width, uneditable field
 * (dhcpv4 Code=3 Router Addresses, tlsClientHelloFull / tlsExtensionsBlock
 * extension data). `fieldId` is the catalog field whose `bits` the knob sizes;
 * `lengthFieldId`, when present, is the sibling length octet inside the same
 * record that declares the value's length on the wire (`bytes(ref L)`), so the
 * editor / lift can keep the two in sync.
 */
export type TlvVariableBytes = {
  key: string;
  fieldId: string;
  min: number;
  max: number;
  label?: string;
  lengthFieldId?: string;
};

/**
 * A catalog entry describing one TLV record type (e.g. TCP option Kind=2 MSS,
 * or an IPv4 option Kind=7 Record Route). `fields` is the fixed positional
 * layout. If `variableCount` is set, the entry has a count-based extra that
 * drives the field list — either `fieldsFor` (in-memory closure) or
 * `fieldsFormula` (resolver-registry key) supplies the expanded slot list.
 */
export type TlvCatalogEntry = {
  kind: number;
  name: string;
  /** Optional fixed bit-width when `fields` is omitted (e.g. EOL/NOP). */
  bits?: number;
  description?: string;
  fields?: TlvCatalogField[];
  /** Defaults merged into instance.extras before computing field list. */
  defaultExtras?: Record<string, number>;
  /** Variable-count metadata (UI knob description). */
  variableCount?: TlvVariableCount;
  /** Variable-LENGTH value knobs — one per `bytes(ref L)` / delimited / varint
   *  member that has no static width. The editor renders a byte-count input per
   *  entry and `applyTlvInstances` / `fieldsFor` size the value cell from it. */
  variableBytes?: TlvVariableBytes[];
  /** Build-time formula token; resolved to a function via TLV_FIELDS_REGISTRY. */
  fieldsFormula?: string;
  /** In-memory equivalent of `fieldsFormula`; checked first when present. */
  fieldsFor?: (extras: Record<string, number>) => TlvCatalogField[];
};

/** An instance of a TLV record currently attached to a TLV field. */
export type TlvInstance = {
  kind: number;
  extras?: Record<string, number>;
};

export type TlvSpec = {
  catalog: TlvCatalogEntry[];
  instances: TlvInstance[];
  padToBoundary?: number;
  drivesController?: string;
  bytesPerUnit?: number;
  baseControllerValue?: number;
};
/** Alias for compatibility with the TLV/Chain editor naming. */
export type TlvDescriptor = TlvSpec;

/** A chain-catalog entry (e.g. IPv6 extension header). */
export type ChainCatalogEntry = {
  proto: number;
  name: string;
  description?: string;
  fields: TlvCatalogField[];
};

/** A single chain block (extension header). */
export type ChainInstance = {
  proto: number;
  /** Per-instance numeric extras parallel to `TlvInstance.extras`. The
   *  PSDL schema accepts them on `Repeat.chainInstances`; carrying the
   *  field on the renderer mirror prevents `chain.ts` round-trip from
   *  silently dropping data (Codex P2). Most renderer call sites only
   *  read `proto`. */
  extras?: Record<string, number>;
};

export type Field = {
  id: string;
  name: string;
  /** Fixed bit width for non-variable fields. */
  bits?: number;
  category?: CategoryToken;
  /** Legacy per-field color token, used as a fallback when `category` is absent. */
  color?: ColorToken;
  description?: string;
  /** Marks this field as a length controller; the named key is written into state. */
  controlsLength?: string;
  /** Ids of the VALUE fields whose width this length controller sizes
   *  (`bytes(ref <controlsLength>)`). When a length octet renders in the diagram
   *  in arms that DON'T consume it (pimHelloOptLen's cell shows in every PIM Hello
   *  option arm, but only arms 24/`_` size a value with it), OverridePanel uses
   *  this to keep the slider live only while one of these values is rendered — a
   *  live-but-inert slider otherwise. Absent ⇒ fall back to the length cell's own
   *  render state. Set by the sibling-length adapter path. */
  lengthSizesFieldIds?: string[];
  defaultValue?: number;
  min?: number;
  max?: number;
  /** Variable-length flag. When true, `lengthFrom` + `toBits` are required. */
  variable?: boolean;
  lengthFrom?: string;
  /** Build-time formula token; resolved to a function via TO_BITS_REGISTRY. */
  formula?: string;
  /**
   * Computes the bit width for a variable field given the current value of the
   * controller it references. Re-attached at build time via the resolver registry.
   */
  toBits?: (controlValue: number) => number;
  subfields?: SubField[];
  /** TLV container metadata (e.g. TCP/IPv4 options, TLS extensions). */
  tlv?: TlvSpec;
  /** Chain container metadata (e.g. IPv6 Next Header). */
  chainCatalog?: ChainCatalogEntry[];
  chainInstances?: ChainInstance[];
  /** Final next-header value when no extension headers are attached. */
  chainFinalProto?: number;
  /**
   * Id of the PSDL field the chain Switch discriminates on (e.g. IPv6's
   * `nextHeader`). Carried verbatim from the source Repeat by
   * `repeatToChainField` so the renderer→PSDL lift (`chainFieldToRepeat`) can
   * emit a Switch whose `on` matches the discriminator each case re-declares.
   * Keeping these two ids identical preserves the chain's structural signature
   * across a lift→re-import, so `isLikelyChainRepeat` keeps detecting it as a
   * chain instead of degrading it to a TLV (which would silently drop
   * chainInstances / chainFinalProto). Absent for hand-built mirrors; the lift
   * then falls back to the legacy `${baseId}_proto` id (and re-keys the case
   * discriminator to match, so detection still holds).
   */
  chainDiscId?: string;
  /**
   * Case list when this field is the discriminator of a top-level PSDL
   * `Switch` whose `on` is `ref(<this field id>)`. Each entry pairs the
   * discriminator value with a human-readable label (the case struct's
   * `name` or the bare key). Populated by `psdlToRenderer`.
   */
  switchCases?: { value: number; label: string }[];
  /**
   * Encoding kind when this field's PSDL type is `varint`. Drives the
   * width picker in OverridePanel. The runtime width is the env value
   * keyed by this field's id (the same convention PSDL normalize uses).
   */
  varintEncoding?: VarintEncoding;
  /** True when this field's PSDL type is `berLength`. Same env override
   *  convention as `varintEncoding`. */
  isBerLength?: boolean;
  /** True when this field's PSDL type is a delimiter-terminated `bytes`.
   *  The width override is a BYTE count keyed by this field's id (bridged
   *  to `__bytesDelimLen__<id>` in layout.ts). */
  isDelimited?: boolean;
  /** The delimiter byte sequence of a `isDelimited` field, carried verbatim
   *  from the source `bytes({ delimiter: [...] })` so the source-less lift
   *  (`rendererToPsdl`) can re-emit the same delimiter instead of dropping the
   *  field. Absent for hand-built mirrors; the lift then falls back to a
   *  single NUL delimiter, preserving the field's variable-length shape. */
  delimiterBytes?: number[];
  /** True when this field's PSDL type is `bytes(remaining)` — the variable tail
   *  of the packet (or active switch arm). It has no wire-width env key in core
   *  (its size is the leftover scope budget), so the OverridePanel WidthPicker
   *  drives a BYTE count on the visualizer-only `__remainingBytes__<id>` key,
   *  which `resolveLayout` honors by sizing the packet budget. Only set for
   *  top-level / switch-arm remaining leaves (not those inside a repeat, whose
   *  per-iteration size is governed by their repeat / bounded budget). */
  isRemaining?: boolean;
  /**
   * List of Optional containers whose `when` expression is
   * `ref(<this field id>)`. Each entry is the inner field's name so the
   * toggle UI can show what it gates. Populated by `psdlToRenderer`.
   */
  optionalGateFor?: string[];
  /**
   * Enum variant table when this field's PSDL type is `enum`. Drives the
   * EnumDropdown widget so users can pick a known value (e.g. `Protocol=6
   * → TCP`) instead of typing a raw integer. Populated by `psdlToRenderer`.
   */
  enumVariants?: Record<number, string>;
  /** Per-field byte order override (PSDL 0.4). When set, OverridePanel
   *  surfaces a BE / LE toggle for this field. The mutation goes through
   *  StudioPanel's edit-reducer because byteOrder is a schema attribute,
   *  not an env override. */
  byteOrder?: "BE" | "LE";
};

export type Packet = {
  name: string;
  rowBits: number;
  description?: string;
  byteOrder?: string;
  fields: Field[];
  /** Non-TLV / non-chain Repeat counts the user can drive via OverridePanel.
   *  Surfaced as a "Repeats" stepper section because these counts don't
   *  belong to a single field (they're synthetic env keys).
   *  `defaultCount`, when set, seeds an initial iteration count so the diagram
   *  shows a representative record on load instead of an empty section. Only
   *  set for eos/until repeats NOT nested in a `bounded` byte-scope (seeding a
   *  bounded-nested repeat would over-consume its budget).
   *
   *  `transform`, when set, means `countKey` is a real wire field (not a
   *  synthetic env key) whose value drives the record count through an affine
   *  relation `recordCount = env[countKey] * mul + add` (e.g. SRv6's
   *  `repeat … count={ref(srhLastEntry) + 1}` → mul=1, add=1). The stepper then
   *  DISPLAYS the record count but WRITES the inverted controller value
   *  `env[countKey] = round((recordCount - add) / mul)` so the diagram's count
   *  becomes the requested N. Without it the stepper shows/writes the raw env
   *  value (the existing eos/until and bare-ref cases). */
  freeRepeats?: {
    name: string;
    countKey: string;
    defaultCount?: number;
    transform?: { mul: number; add: number };
    /** Discriminator gate for a repeat that lives inside ONE case of a top-level
     *  message-type `switch` (icmpv6Ndp's rsOptions/raOptions/… each live in a
     *  different `type` case). Only the case whose discriminator the diagram is
     *  CURRENTLY showing can instantiate this repeat, so the stepper is surfaced
     *  ONLY when `env[gate.key] === gate.value`; otherwise it would show a live
     *  count over an arm the diagram isn't rendering (a panel-vs-diagram
     *  contradiction). `initialState` seeds `gate.key` to the FIRST gated
     *  repeat's value so the active arm's stepper agrees with the diagram on
     *  load. */
    gate?: { key: string; value: number };
    /** A representative inner field id of the repeat element, set ONLY for a
     *  repeat surfaced from inside an `optional{when: ref(X)}` wrapper (icmpv6Ndp's
     *  switch-case gate uses `gate` instead; caseGate is null for optional
     *  nesting). The optional's `when` is a plain int field with no dedicated
     *  widget, so the section is absent at load (X=0) yet the stepper would read
     *  live over a diagram drawing nothing from the section — a panel-vs-diagram
     *  contradiction. OverridePanel disables the stepper with a hint until this id
     *  is a rendered cell (`fieldRendered`), exactly as a refSwitch picker gates on
     *  its discriminator. Layout-faithful: `cells` IS the live diagram. */
    gateFieldId?: string;
    /** Present value of the enclosing `optional{when: peek(N)==lit}` gate, set
     *  ONLY for a count-driven repeat wrapped in a PEEK-gated optional whose entry
     *  picker is suppressed because this stepper is the live control
     *  (rohcUncompressed's rohcPadding / rohcFeedback: `optional(peek==224|30){
     *  group{ until-repeat }}`). The gate reads `__peek__<offset>__<bits>`, a
     *  no-byte expression with NO dedicated widget, so without seeding it the
     *  optional is never entered: the records are absent, `gateFieldId` never
     *  renders, and OverridePanel disables this stepper with a hint pointing at a
     *  field the user has no surfaced control to set — a permanently-inert
     *  see-but-cannot-edit gap. `initialState` seeds `env[key]=value` (only when
     *  unset) so the region is ENTERED on load: the stepper is live and its
     *  records render, while lowering it to 0 still hides them. Share-url-default-
     *  safe (same default-set pattern as the gate / lengthSeed seeds). */
    peekGate?: { key: string; value: number };
  }[];
  /** Switches whose `on` is a `peek` expression — discriminator can't be
   *  surfaced via a real cell, so OverridePanel offers a synthetic
   *  case-picker. */
  peekSwitches?: {
    id: string;
    name: string;
    cases: { value: number; label: string }[];
    peekKey: string;
    /** A representative inner field id from this switch's arms. A peek picker
     *  whose arm isn't currently drawn (its enclosing repeat has no record, or it
     *  sits in an absent `optional{when: ref(X)}` region) would read live over a
     *  diagram drawing nothing — peekSwitches were never gated by `fieldRendered`
     *  even for switch-case nesting, so any such picker contradicts the diagram.
     *  OverridePanel disables the picker with a hint until this id is a rendered
     *  cell, exactly as a refSwitch picker gates on its discriminator. When the
     *  arm IS drawn at the seeded peek value (every built-in preset) the picker
     *  stays live, so this is non-regressing. */
    gateFieldId?: string;
  }[];
  /** Switches inside a plain (non-TLV/non-chain) repeat whose `on` is a
   *  `ref` to a discriminator field. That repeat is not lifted into the mirror,
   *  so the discriminator has no override widget — surface a packet-level
   *  variant picker keyed on the discriminator's env id instead (override-audit
   *  A2). Selecting a case sets which variant the repeated records display. */
  refSwitches?: {
    id: string;
    name: string;
    cases: { value: number; label: string }[];
    refKey: string;
    /** Per-record length fields to seed to a representative width when this
     *  picker is surfaced. A `ref`-discriminated record-variant switch whose
     *  every arm is `bytes(ref tlvLength)` and whose `tlvLength` lives INSIDE the
     *  repeat element (no top-level cell, not a lengthController) would otherwise
     *  render every arm at width 0 → an inert picker that manufactures empty
     *  record skeletons (isisLsp's tlvType + tlvLength). Rather than suppress the
     *  picker (a see-but-cannot-edit gap), surface it and seed these lengths via
     *  `initialState` so the chosen arm's Value cell is non-zero-width and the
     *  length CELL stays user-editable. Share-url-safe (same default-set
     *  reasoning as the discriminator / freeRepeat / boundedRepeat seeds). */
    lengthSeeds?: { key: string; value: number }[];
    /** Discriminator gate of the OUTERMOST top-level message-type `switch` case
     *  this refSwitch's discriminator is declared inside (oncRpc's reply-side
     *  replyStat/acceptStat/rejectStat all live under `rpcMsgType`'s REPLY case →
     *  `{ key: "rpcMsgType", value: 1 }`). The discriminator the picker drives is
     *  a real cell ONLY when the diagram is rendering that arm, so `initialState`
     *  seeds `gate.key` to `gate.value` on load — otherwise the discriminator
     *  0-fills (rpcMsgType=0=CALL), the diagram shows only the CALL header, and
     *  all three reply pickers are disabled-with-hint and contradict the diagram
     *  (#11/#12, same class as the freeRepeat switch-case gate seed). The
     *  per-picker live gate (OverridePanel's `fieldRendered(cells, refKey)`) still
     *  hides a deeper picker whose nearer arm isn't selected (rejectStat until
     *  replyStat=1), so the seed only ensures the OUTER reply arm renders. The
     *  FIRST gated refSwitch for a given key wins; only fills an unset key, so a
     *  user / saved-env value still wins and it stays out of the share URL. */
    gate?: { key: string; value: number };
    /** FULL ordered chain of every case discriminator this refSwitch's field is
     *  declared inside, outermost → innermost (oncRpc's `rejectStat` lives in
     *  `rpcMsgType=1`'s REPLY arm AND its nested `replyStat=1` MSG_DENIED arm →
     *  `[{rpcMsgType:1},{replyStat:1}]`). `gate` records only the OUTERMOST entry
     *  (for the load-seed). The disabled-hint must instead point at the FIRST
     *  link in this chain not yet at its required value: `initialState` already
     *  satisfies the outermost gate (rpcMsgType=1), so hinting "Set rpcMsgType …"
     *  would name an already-satisfied discriminator and be a dead no-op — the
     *  real unmet step is `replyStat=1` (rejectStat's nearer arm). OverridePanel
     *  walks this chain against the live `controllers` to name the next unmet
     *  discriminator (#11/#12 misleading-hint). Absent for an ungated (plain-
     *  repeat A2) refSwitch; a single-link chain equals `gate`. */
    gateChain?: { key: string; value: number }[];
  }[];
  /** Length-controller sliders for `bounded.bytes` scopes whose driving field
   *  is NOT a top-level cell (e.g. nested in a Group, like babel's
   *  `babelBodyLength`). Such a field can't host its own slider, so surface a
   *  packet-level one; raising it grows the bounded budget and the enclosed
   *  eos/until repeat fills it (override-design-audit). Each carries
   *  `controlsLength` so it renders through the normal slider widget. */
  lengthControllers?: Field[];
  /** eos/until repeats nested in a single-ref `bounded.bytes` scope. core reads
   *  an eos count from `env[countKey]`, NOT from the budget, so the layout must
   *  DERIVE the count from the budget: `floor(env[lengthKey] / perRecordBytes)`.
   *  This makes the length slider the single intuitive control — raising it
   *  fills the scope with records — instead of a separate (over-consuming) count
   *  stepper (override-design-audit). `perRecordBytes` is a conservative
   *  (over-)estimate so the derived count never exceeds the budget. */
  boundedRepeats?: {
    countKey: string;
    /** The single ref the budget depends on — the slider field the user drives.
     *  (The budget itself is `bytesExpr`, which may be `field*k - c`.) */
    lengthKey: string;
    /** The scope's `bounded.bytes` Expr, evaluated against the live env to get
     *  the actual byte budget (handles `ref` and `field*k - c` forms). */
    bytesExpr: Expr;
    perRecordBytes: number;
    /** Fixed bytes the enclosing bounded scope consumes BESIDES the records
     *  (sibling fields), subtracted from the budget before deriving the count
     *  so the records don't over-consume the scope. */
    prefixBytes: number;
    /** Per-record inner-scope length fields to seed so the DEFAULT record fits.
     *  A TLV-style record can itself wrap a nested `bounded` sized by a
     *  PER-RECORD length field (tlsClientHello's extensions: each record is
     *  [extType, extLen, bounded extData(ref extLen){switch}]). That inner
     *  length defaults to 0, so the representative arm (cases[0]) would
     *  over-consume the empty inner scope the instant a record is derived. Each
     *  entry seeds the inner length to a value that fits the representative arm
     *  — surfaced via `initialState` so the diagram shows a complete default
     *  record (and the length CELL stays user-editable). `perRecordBytes`
     *  already accounts for the seeded inner bytes, so the derived count never
     *  over-consumes the ENCLOSING scope either.
     *
     *  `derivesBudgetKey` links a per-record VALUE length (tlsClientHello's
     *  `nameLen` sizing `serverName = bytes(ref nameLen)` INSIDE the SNI arm,
     *  ocspRequest's `hashAlgLength` sizing `hashAlgData`) to the inner bounded
     *  budget field that must hold it (`extLen` / `certIdLength`). When the user
     *  raises (or an imported packet carries) this length above its `value`
     *  seed, the value grows past the inner scope's statically-seeded budget and
     *  core's normalize throws `bounded scope over-consumed` → the diagram
     *  FREEZES. PacketViewer grows `env[derivesBudgetKey]` by the live overage
     *  (`(env[key] - value) * bytesPerUnit`) so the inner budget always fits its
     *  own value, keeping every length in range crash-free and round-trippable. */
    innerScopeSeeds?: {
      key: string;
      value: number;
      bytesPerUnit?: number;
      derivesBudgetKey?: string;
    }[];
    /** A representative OUTER-budget byte count to seed `env[lengthKey]` with on
     *  load, so one representative record renders immediately and any
     *  refSwitch/peek picker gated on this repeat is LIVE from the start.
     *  Without it the outer length 0-fills → `floor(0/perRecord)=0` records →
     *  the picker is inert at load and contradicts an empty diagram (the
     *  documented #11/#12 discoverability defect, tlsClientHello's
     *  `extensions_byKind`/extType picker). Emitted only when `bytesExpr` is a
     *  plain `ref(lengthKey)` (so seeding the field equals seeding the budget),
     *  with value `perRecordBytes + prefixBytes` → exactly one record. Seeded via
     *  `initialState` (share-url-default-safe, same as freeRepeat `defaultCount`
     *  / refSwitch discriminator seeds): a user width still wins and it stays out
     *  of the share URL. */
    defaultLength?: number;
  }[];
  /** Dynamic-width (`varint` / delimiter-terminated `bytes`) leaf ids that live
   *  inside a Switch case / Repeat element / Group and so never reach `fields`.
   *  `seedDynamicWidthDefaults` already seeds the SAME default into the diagram
   *  layout env (so the cell renders at its representative width), but because
   *  these leaves are absent from the mirror, `initialState`'s top-level seed
   *  loop never primes `controllers[leafId]`. The OverridePanel WidthPicker then
   *  falls back to `pickerWidths(target)[0]` (1 byte for delimited) and highlights
   *  the wrong option while the diagram already shows the ~4-byte seeded cell -- a
   *  panel-vs-diagram contradiction on load (tftp's rrqFilename/rrqMode/... all
   *  delimiter-terminated bytes inside the `tftpBody` switch arms). `initialState`
   *  seeds `controllers[id]` for each of these so the picker's active option
   *  matches the diagram. Switch-`on:ref` discriminators are excluded here (their
   *  env key carries the case value, not a width -- same carve-out as
   *  `seedDynamicWidthDefaults`). `kind` selects which default to seed.
   *  Populated by `psdlToRenderer`; share-url-default-safe (seeded via
   *  `initialState`, so it stays out of the share URL). */
  dynamicWidthLeaves?: {
    id: string;
    kind: "delimited" | "varint" | "berLength" | "remaining";
  }[];
  /** berLength leaf ids whose width PICKER is suppressed because every non-default
   *  width freezes the diagram. A berLength octet nested inside a `bounded` scope
   *  whose budget is `bytes(ref X)` for a `length`-category sibling X (a tight
   *  value-budgeted scope) cannot widen: the extra prefix byte overflows the fixed
   *  value-budget and core's `normalize` throws `bounded scope over-consumed`,
   *  which PacketViewer's layout try/catch swallows — so the picker's active
   *  option moves to the clicked width while the diagram is unchanged (an inert /
   *  misleading control). OverridePanel skips the WidthPicker for these ids so no
   *  control is shown that cannot change the diagram; the octet still renders at
   *  its valid 8-bit short-form default. Populated by `psdlToRenderer`; across all
   *  184 presets this matches ONLY ocspRequest's 6 CertID berLength leaves. Absent
   *  ⇒ no suppression. */
  berLengthWidthLocked?: string[];
  /** Per-field byteOrder flips applied via the diagram, keyed by field id.
   *  A top-level field carries its byteOrder on the matching `fields` entry,
   *  but a field nested inside a Switch case / Repeat element / Group never
   *  reaches `fields` (it is only a `Cell` on the diagram), so a flip on such
   *  a cell has nowhere on the mirror to land. Recording it here gives both
   *  the diagram (`applyByteOrderOverrides` re-stamps the PSDL field that
   *  `resolveLayout` reads) and the export merge (`mergeInstancesIntoPsdl`
   *  sources nested overrides from here) a single, id-keyed source of truth.
   *  Absent ⇒ no diagram byteOrder edits. */
  byteOrderOverrides?: Record<string, "BE" | "LE">;
};

/** A laid-out cell within a row. May span multiple rows via segmentation. */
export type SubCell = {
  parentField: Field;
  subfield: SubField;
  id: string;
  startBit: number;
  endBit: number;
  isFirst: boolean;
  isLast: boolean;
  bitsTotal: number;
  /** Per-child decoration flags propagated from the source NormalizedField.
   *  When a Group collapse spans children with non-uniform encryption /
   *  byteOrder, the parent cell stays neutral and these per-sub-cell flags
   *  drive the visual treatment (lock icon, [LE] suffix etc.) instead. */
  encrypted?: boolean;
  encryptedParentId?: string;
  encryptedContextNote?: string;
  headerProtected?: boolean;
  byteOrder?: "BE" | "LE";
};

export type Cell = {
  field: Field;
  bitsTotal: number;
  row: number;
  startBit: number;
  endBit: number;
  segmentIndex: number;
  totalSegments: number;
  isFirst: boolean;
  isLast: boolean;
  fieldStartOffset: number;
  fieldEndOffset: number;
  subCells?: SubCell[];
  /**
   * PSDL 0.3 encryption-decoration flags, propagated from NormalizedField.
   * Renderers may use these to display lock icons, dashed borders, or a
   * tooltip with `encryptedContextNote`. All optional and ignored by code
   * that predates PSDL 0.3.
   */
  encrypted?: boolean;
  encryptedParentId?: string;
  encryptedContextNote?: string;
  headerProtected?: boolean;
  /**
   * PSDL 0.4 per-field byte order override, propagated from
   * NormalizedField.byteOrder. Renderers may decorate cells with a `[LE]`
   * marker when this differs from the enclosing packet's byteOrder.
   */
  byteOrder?: "BE" | "LE";
};

export type ResolvedLayout = {
  cells: Cell[];
  totalBits: number;
};

/** Maps a controller key (`field.controlsLength`) to its current numeric value. */
export type ControllerState = Record<string, number>;

/** Preset registry keyed by short identifier (e.g. "ipv4", "tcp"). */
export type PacketRegistry = Record<string, Packet>;

/** A resolved TLV block (one rendered record within a TLV field). */
export type TlvBlock = {
  kind: number | null;
  name: string;
  bits: number;
  fields: TlvCatalogField[];
  extras: Record<string, number>;
  description?: string;
  variableCount?: TlvCatalogEntry["variableCount"] | null;
  isPadding?: boolean;
};

export type ResolvedTlv = {
  totalBits: number;
  blocks: TlvBlock[];
};

/** A resolved chain block (one IPv6 extension header instance). */
export type ChainBlock = {
  chainOwnerFieldId: string;
  chainIndex: number;
  proto: number;
  name: string;
  bits: number;
  fields: TlvCatalogField[];
  description?: string;
};
