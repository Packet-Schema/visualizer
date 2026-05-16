meta:
  id: ipv4_min
  title: Minimal IPv4 header
  endian: be
doc: |
  Minimal IPv4 header in Kaitai form, used to smoke-test the .ksy importer.
  Covers fixed-size u1/u2/u4 ints, raw bit fields (b1..bN), sized byte
  buffers, doc/doc-ref, and a basic conditional and repeat.
doc-ref: https://www.rfc-editor.org/rfc/rfc791
seq:
  - id: version
    type: b4
    doc: IP version, always 4 for IPv4.
  - id: ihl
    type: b4
    doc: Header length in 32-bit words; minimum 5.
  - id: dscp
    type: b6
    doc: Differentiated Services Code Point.
  - id: ecn
    type: b2
    doc: Explicit Congestion Notification.
  - id: total_length
    type: u2
    doc: Total packet length in bytes (header + data).
  - id: identification
    type: u2
  - id: flags
    type: b3
  - id: frag_offset
    type: b13
  - id: ttl
    type: u1
    doc: Time to live.
  - id: protocol
    type: u1
    doc-ref: https://www.iana.org/assignments/protocol-numbers
  - id: header_checksum
    type: u2
  - id: src_addr
    type: u4
    doc: Source IPv4 address.
  - id: dst_addr
    type: u4
    doc: Destination IPv4 address.
  - id: options
    size: 4
    if: ihl > 5
    doc: Options blob; present only when IHL > 5. Sized for the smoke test.
