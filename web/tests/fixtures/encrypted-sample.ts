// Shared fixture: a tiny synthetic PSDL packet that exercises the PSDL 0.3
// Encrypted container without depending on the full QUIC/TLS presets. Other
// Phase 2 agents (format hub, UI) import this to test view-mode toggles,
// renderer decoration, and round-tripping of the Encrypted primitive in
// isolation.
//
// Structure:
//   * 1-byte plaintext "type" tag
//   * 1-byte "version"
//   * Encrypted container `body`:
//       wireBits = 64 (8 bytes on the wire)
//       plaintext = { id: 'msg_id' u16, headerProtected; body bytes(8) }
//
// Wire totalBits     = 8 + 8 + 64 = 80
// Semantic totalBits = 8 + 8 + 16 + 64 = 96

import { lit } from "../../lib/psdl/expr";
import type { Encrypted, Packet } from "../../lib/psdl/types";

export const ENCRYPTED_SAMPLE_PLAINTEXT_BITS = 16 + 64; // msg_id + body
export const ENCRYPTED_SAMPLE_WIRE_BITS = 64;
export const ENCRYPTED_SAMPLE_WIRE_TOTAL = 8 + 8 + ENCRYPTED_SAMPLE_WIRE_BITS;
export const ENCRYPTED_SAMPLE_SEMANTIC_TOTAL =
  8 + 8 + ENCRYPTED_SAMPLE_PLAINTEXT_BITS;

export const ENCRYPTED_SAMPLE_BODY: Encrypted = {
  kind: "encrypted",
  id: "body",
  name: "Encrypted Body",
  contextNote: "Synthetic protocol — pretend session key.",
  wireBits: lit(ENCRYPTED_SAMPLE_WIRE_BITS),
  headerProtected: ["msg_id"],
  category: "payload-marker",
  plaintext: {
    id: "bodyPlaintext",
    fields: [
      {
        id: "msg_id",
        name: "Message Id",
        type: { kind: "bits", n: 16 },
        category: "identifier",
      },
      {
        id: "body",
        name: "Body",
        type: { kind: "bytes", n: lit(8) },
        category: "payload-marker",
      },
    ],
  },
};

export const ENCRYPTED_SAMPLE: Packet = {
  name: "Encrypted Sample",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "Synthetic packet for testing the Encrypted container primitive in isolation.",
  body: [
    {
      id: "type",
      name: "Type",
      type: { kind: "bits", n: 8 },
      category: "type",
    },
    {
      id: "version",
      name: "Version",
      type: { kind: "bits", n: 8 },
      category: "type",
    },
    ENCRYPTED_SAMPLE_BODY,
  ],
};
