// Component-local re-export of the canonical TLV cell-id parser. The
// underlying logic lives at `lib/psdl/psdl-to-renderer/tlv-cell-id.ts`
// (same dir as `apply-tlv.ts`, which is what mints the suffixes). UI
// callers import from here so the import path doesn't reach into
// `lib/` directly.

export {
  parseTlvCellId,
  tlvBaseId,
  isTlvInstanceGroupId,
  type TlvCellRole,
} from "@/lib/psdl/psdl-to-renderer/tlv-cell-id";
