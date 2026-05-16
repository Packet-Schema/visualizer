meta:
  id: bmp_header
  title: BMP file header (trimmed)
  file-extension: bmp
  endian: le
  license: CC0-1.0
doc: |
  Trimmed BMP file-header subset, adapted from
  https://github.com/kaitai-io/kaitai_struct_formats/blob/master/image/bmp.ksy
  Keeps the BITMAPFILEHEADER (14 bytes) plus the leading length field
  of BITMAPINFOHEADER. Sufficient to exercise meta, seq, types,
  doc, doc-ref, and the basic u2/u4/s4 integer types of the importer.
doc-ref: https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapfileheader
seq:
  - id: file_hdr
    type: file_header
    doc: 14-byte BITMAPFILEHEADER.
  - id: info_len
    type: u4
    doc: Length of the BITMAPINFOHEADER that follows (typically 40).
types:
  file_header:
    doc-ref: https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapfileheader
    seq:
      - id: magic
        size: 2
        doc: 'Magic number, always "BM" (0x42 0x4D).'
      - id: len_file
        type: u4
        doc: File size in bytes; per spec but unreliable in practice.
      - id: reserved1
        type: u2
      - id: reserved2
        type: u2
      - id: ofs_bitmap
        type: s4
        doc: Byte offset from start of file to the pixel data.
