import { compressToUint8Array, decompressFromUint8Array } from "lz-string";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const payload = JSON.stringify({ name: "custom-packet", rowBits: 32, body: [] });
const compressed = compressToUint8Array(payload);
const b64 = bytesToBase64Url(compressed);
console.log("base64url:", b64);
const decompressed = decompressFromUint8Array(base64UrlToBytes(b64));
console.log("decompressed:", decompressed);

