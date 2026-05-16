// Hand-built PSML packet fixture exercising the Encrypted container.
//
// Used by tests/psml/encrypted-cells.test.ts to verify that resolveLayout
// emits Cell decoration flags consistent with what HybridDiagram renders.
// Phase 2C will produce real-protocol presets (QUIC short/long header, TLS)
// that supersede this fixture for end-user demos; it stays here as a
// minimal, dependency-free regression anchor.

import type { Packet } from "../../lib/psml/types";

/**
 * A 32-bit row carrying:
 *   - one fixed 16-bit "Version" identifier field
 *   - one 16-bit encrypted payload whose plaintext is two 8-bit subfields,
 *     the first of which is also header-protected.
 *
 * Tiny enough to read at a glance; rich enough to cover wire-mode collapse,
 * semantic-mode expansion, and the headerProtected flag.
 */
export const encryptedSamplePacket: Packet = {
  name: "Encrypted Sample",
  rowBits: 32,
  description:
    "Fixture: 16-bit identifier plus a 16-bit encrypted payload whose plaintext has one header-protected and one fully-encrypted field.",
  body: [
    {
      id: "version",
      name: "Version",
      type: { kind: "int", bits: 16 },
      category: "identifier",
    },
    {
      kind: "encrypted",
      id: "payload",
      name: "Payload",
      wireBits: { kind: "lit", value: 16 },
      contextNote: "Requires session keys to decrypt.",
      headerProtected: ["pn"],
      plaintext: {
        id: "payload_plain",
        fields: [
          {
            id: "pn",
            name: "Packet Number",
            type: { kind: "int", bits: 8 },
            category: "identifier",
          },
          {
            id: "flags",
            name: "Flags",
            type: { kind: "bits", n: 8 },
            category: "flags",
          },
        ],
      },
    },
  ],
};
