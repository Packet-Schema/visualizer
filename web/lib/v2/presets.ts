// Hand-written v2 presets demonstrating every primitive in the new model.
//
// IPv4 — variable-length Options expressed as a Repeat over a Switch on the
//        option Type byte, plus a Constraint linking IHL ⇔ headerBytes.
// TCP  — same shape: Repeat<Switch on Kind> for Options, Data Offset ⇔
//        tcpHeaderBytes constraint.
// UDP  — pure fixed layout.
// Ethernet — pure fixed layout.
//
// The remaining 9 presets live in presets.generated.ts and are produced
// mechanically from the v1 schema by scripts/migrate-v1-to-v2.ts.

import { lit, op, ref } from "./expr";
import type { Container, Packet, Struct } from "./types";

/* ------------------------------------------------------------------ *
 * Small helpers — keep preset definitions terse and consistent.
 * ------------------------------------------------------------------ */

const bits = (n: number) => ({ kind: "bits" as const, n });
const int = (n: number) => ({ kind: "int" as const, bits: n });

function group(id: string, children: Container[]): Container {
  return { kind: "group", id, children };
}

function struct(id: string, fields: Container[]): Struct {
  return { id, fields };
}

/* ------------------------------------------------------------------ *
 * IPv4
 * ------------------------------------------------------------------ */

const ipv4OptionVariants: Record<string, Struct> = {
  // EOL — single byte type=0.
  "0": struct("eol", [
    {
      id: "type",
      name: "Type=0",
      type: bits(8),
      category: "type",
    },
  ]),
  // NOP — single byte type=1.
  "1": struct("nop", [
    {
      id: "type",
      name: "Type=1",
      type: bits(8),
      category: "type",
    },
  ]),
  // Record Route (kind=7) — type + length + pointer + 3 × 32-bit addr slots
  // (mirrors v1's ipv4_record_route default extras count=3).
  "7": struct("recordRoute", [
    { id: "type", name: "Type=7", type: bits(8), category: "type" },
    { id: "length", name: "Len=15", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
    { id: "addr2", name: "Addr 3", type: int(32), category: "addressing" },
  ]),
  // Loose Source Route (kind=131) — default count=2 addresses.
  "131": struct("looseSourceRoute", [
    { id: "type", name: "Type=131", type: bits(8), category: "type" },
    { id: "length", name: "Len=11", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
  ]),
  // Strict Source Route (kind=137).
  "137": struct("strictSourceRoute", [
    { id: "type", name: "Type=137", type: bits(8), category: "type" },
    { id: "length", name: "Len=11", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
  ]),
  // Timestamp (kind=68) — default count=2 timestamps.
  "68": struct("timestamp", [
    { id: "type", name: "Type=68", type: bits(8), category: "type" },
    { id: "length", name: "Len=12", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "oflwflg", name: "Oflw/Flg", type: bits(8), category: "flags" },
    { id: "ts0", name: "TS 1", type: int(32), category: "identifier" },
    { id: "ts1", name: "TS 2", type: int(32), category: "identifier" },
  ]),
};

export const ipv4: Packet = {
  name: "IPv4 Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "IPv4 header (RFC 791) — IHL drives the Options length.",
  body: [
    { id: "version", name: "Version", type: bits(4), category: "type", color: "blue", defaultValue: 4 },
    {
      id: "ihl",
      name: "IHL",
      type: bits(4),
      category: "length",
      color: "indigo",
      defaultValue: 5,
    },
    { id: "dscp", name: "DSCP", type: bits(6), category: "type", color: "orange" },
    { id: "ecn", name: "ECN", type: bits(2), category: "flags", color: "amber" },
    {
      id: "totalLength",
      name: "Total Length",
      type: int(16),
      category: "length",
      color: "teal",
    },
    {
      id: "identification",
      name: "Identification",
      type: int(16),
      category: "identifier",
      color: "blue",
    },
    // Flags is laid out flat (3 bits) — v2 expands subfields via Group/nested
    // Field but the renderer cares about absolute bit offsets, so a sibling
    // group of 1-bit fields produces identical totals.
    group("flagsBits", [
      { id: "flags_reserved", name: "R", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_df", name: "DF", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_mf", name: "MF", type: bits(1), category: "flags", color: "rose" },
    ]),
    {
      id: "fragOffset",
      name: "Fragment Offset",
      type: bits(13),
      category: "identifier",
      color: "green",
    },
    { id: "ttl", name: "TTL", type: int(8), category: "identifier", color: "amber" },
    { id: "protocol", name: "Protocol", type: int(8), category: "type", color: "teal" },
    {
      id: "headerChecksum",
      name: "Header Checksum",
      type: int(16),
      category: "checksum",
      color: "orange",
    },
    {
      id: "srcAddr",
      name: "Source Address",
      type: int(32),
      category: "addressing",
      color: "blue",
    },
    {
      id: "dstAddr",
      name: "Destination Address",
      type: int(32),
      category: "addressing",
      color: "violet",
    },
    // Options — a Repeat over a Switch on the option Type byte. count is
    // derived from the env key `ipv4OptionsCount`, mirroring v1's behaviour
    // where empty `instances` produces zero options.
    {
      kind: "repeat",
      id: "options",
      name: "Options",
      category: "variable",
      color: "amber",
      element: struct("optionRecord", [
        {
          kind: "switch",
          id: "byType",
          on: ref("optType"),
          cases: ipv4OptionVariants,
        },
      ]),
      count: ref("ipv4OptionsCount"),
    },
  ],
  constraints: [
    // IHL ⇔ headerBytes — bidirectional. IHL counts 32-bit words; one word
    // is 4 bytes. The canonical constraint is IHL * 4 == headerBytes.
    {
      lhs: op("*", ref("ihl"), lit(4)),
      rhs: ref("headerBytes"),
      doc: "IHL counts 32-bit words; total header bytes = IHL × 4.",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * TCP
 * ------------------------------------------------------------------ */

const tcpOptionVariants: Record<string, Struct> = {
  "0": struct("eol", [{ id: "kind", name: "Kind=0", type: bits(8), category: "type" }]),
  "1": struct("nop", [{ id: "kind", name: "Kind=1", type: bits(8), category: "type" }]),
  "2": struct("mss", [
    { id: "kind", name: "Kind=2", type: bits(8), category: "type" },
    { id: "length", name: "Len=4", type: bits(8), category: "length" },
    { id: "mss", name: "MSS", type: int(16), category: "length" },
  ]),
  "3": struct("windowScale", [
    { id: "kind", name: "Kind=3", type: bits(8), category: "type" },
    { id: "length", name: "Len=3", type: bits(8), category: "length" },
    { id: "shift", name: "Shift", type: int(8), category: "identifier" },
  ]),
  "4": struct("sackPermitted", [
    { id: "kind", name: "Kind=4", type: bits(8), category: "type" },
    { id: "length", name: "Len=2", type: bits(8), category: "length" },
  ]),
  "5": struct("sack", [
    { id: "kind", name: "Kind=5", type: bits(8), category: "type" },
    { id: "length", name: "Len=10", type: bits(8), category: "length" },
    { id: "leftEdge", name: "Left Edge", type: int(32), category: "identifier" },
    { id: "rightEdge", name: "Right Edge", type: int(32), category: "identifier" },
  ]),
  "8": struct("timestamps", [
    { id: "kind", name: "Kind=8", type: bits(8), category: "type" },
    { id: "length", name: "Len=10", type: bits(8), category: "length" },
    { id: "tsval", name: "TS Value", type: int(32), category: "identifier" },
    { id: "tsecr", name: "TS Echo Reply", type: int(32), category: "identifier" },
  ]),
};

export const tcp: Packet = {
  name: "TCP Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "TCP header (RFC 9293).",
  body: [
    { id: "srcPort", name: "Source Port", type: int(16), category: "addressing", color: "blue" },
    {
      id: "dstPort",
      name: "Destination Port",
      type: int(16),
      category: "addressing",
      color: "violet",
    },
    { id: "seqNum", name: "Sequence Number", type: int(32), category: "identifier", color: "teal" },
    {
      id: "ackNum",
      name: "Acknowledgment Number",
      type: int(32),
      category: "identifier",
      color: "green",
    },
    {
      id: "dataOffset",
      name: "Data Offset",
      type: bits(4),
      category: "length",
      color: "indigo",
      defaultValue: 5,
    },
    { id: "reserved", name: "Rsvd", type: bits(4), category: "reserved", color: "slate" },
    group("flagsBits", [
      { id: "flags_cwr", name: "CWR", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_ece", name: "ECE", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_urg", name: "URG", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_ack", name: "ACK", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_psh", name: "PSH", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_rst", name: "RST", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_syn", name: "SYN", type: bits(1), category: "flags", color: "rose" },
      { id: "flags_fin", name: "FIN", type: bits(1), category: "flags", color: "rose" },
    ]),
    { id: "window", name: "Window", type: int(16), category: "flags", color: "amber" },
    { id: "checksum", name: "Checksum", type: int(16), category: "checksum", color: "orange" },
    {
      id: "urgent",
      name: "Urgent Pointer",
      type: int(16),
      category: "identifier",
      color: "orange",
    },
    {
      kind: "repeat",
      id: "options",
      name: "Options",
      category: "variable",
      color: "amber",
      element: struct("optionRecord", [
        {
          kind: "switch",
          id: "byKind",
          on: ref("optKind"),
          cases: tcpOptionVariants,
        },
      ]),
      count: ref("tcpOptionsCount"),
    },
  ],
  constraints: [
    {
      lhs: op("*", ref("dataOffset"), lit(4)),
      rhs: ref("tcpHeaderBytes"),
      doc: "Data Offset counts 32-bit words; tcpHeaderBytes = Data Offset × 4.",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * UDP
 * ------------------------------------------------------------------ */

export const udp: Packet = {
  name: "UDP Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "UDP header (RFC 768) — fixed 8 bytes.",
  body: [
    { id: "srcPort", name: "Source Port", type: int(16), category: "addressing", color: "blue" },
    {
      id: "dstPort",
      name: "Destination Port",
      type: int(16),
      category: "addressing",
      color: "violet",
    },
    { id: "length", name: "Length", type: int(16), category: "length", color: "teal" },
    { id: "checksum", name: "Checksum", type: int(16), category: "checksum", color: "orange" },
  ],
};

/* ------------------------------------------------------------------ *
 * Ethernet II
 * ------------------------------------------------------------------ */

export const ethernet: Packet = {
  name: "Ethernet II Frame Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "Ethernet II frame header — 14 bytes.",
  body: [
    {
      id: "dstMac",
      name: "Destination MAC",
      type: bits(48),
      category: "addressing",
      color: "violet",
    },
    { id: "srcMac", name: "Source MAC", type: bits(48), category: "addressing", color: "blue" },
    { id: "etherType", name: "EtherType", type: int(16), category: "type", color: "teal" },
  ],
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export const MANUAL_PRESETS = { ipv4, tcp, udp, ethernet } as const;
