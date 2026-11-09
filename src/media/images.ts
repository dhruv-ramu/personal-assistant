/**
 * Image validation and metadata stripping, at the byte level (no decoder dependency in the
 * Worker). Accepts JPEG, PNG, WebP only, identified by magic bytes — never by filename or the
 * client's declared type. HEIC/HEIF is rejected with an instruction (no server-side conversion).
 * Stripping removes EXIF/XMP/IPTC/comments/text chunks (GPS, device, timestamps) so only a
 * derivative without them is stored. Pixel data is untouched.
 */

export type ImageKind = "jpeg" | "png" | "webp";
export const MAX_DIMENSION = 12_000;
export const MAX_PIXELS = 50_000_000;

export type ImageCheck =
  | { ok: true; kind: ImageKind; contentType: string; width: number; height: number; bytes: Uint8Array; stripped: boolean }
  | { ok: false; reason: "unsupported_type" | "heic" | "too_large" | "bad_dimensions" | "malformed" | "suspicious"; message: string };

const CT: Record<ImageKind, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function ascii(b: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...b.subarray(off, off + len));
}

export function sniff(b: Uint8Array): ImageKind | "heic" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(ascii(b, 8, 4))) return "heic";
  return null;
}

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const le32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** JPEG: walk segments; drop APP1-APP15 (EXIF, XMP, IPTC, maker data) except ICC and Adobe colour info, plus COM. */
function processJpeg(b: Uint8Array): { width: number; height: number; out: Uint8Array } | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let o = 2;
  let width = 0;
  let height = 0;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xd9) {
      parts.push(b.subarray(o, o + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(o, o + 2));
      o += 2;
      continue;
    }
    const len = be16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) return null;
    const seg = b.subarray(o, o + 2 + len);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && len >= 7) {
      height = be16(b, o + 5);
      width = be16(b, o + 7);
    }
    const isApp = marker >= 0xe1 && marker <= 0xef;
    const keep = (marker === 0xe2 && ascii(b, o + 4, 11) === "ICC_PROFILE") || (marker === 0xee && ascii(b, o + 4, 5) === "Adobe");
    if (!(isApp && !keep) && marker !== 0xfe) parts.push(seg);
    o += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data until EOI; copy the remainder verbatim.
      parts.push(b.subarray(o));
      break;
    }
  }
  if (!width || !height) return null;
  return { width, height, out: concat(parts) };
}

const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function processPng(b: Uint8Array): { width: number; height: number; out: Uint8Array } | null {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return null;
  const width = be32(b, 16);
  const height = be32(b, 20);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = be32(b, o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(o, end));
    o = end;
    if (type === "IEND") break;
  }
  return { width, height, out: concat(parts) };
}

function processWebp(b: Uint8Array): { width: number; height: number; out: Uint8Array } | null {
  let width = 0;
  let height = 0;
  const chunks: Uint8Array[] = [];
  let o = 12;
  let vp8x: Uint8Array | null = null;
  while (o + 8 <= b.length) {
    const type = ascii(b, o, 4);
    const len = le32(b, o + 4);
    const end = o + 8 + len + (len & 1);
    if (o + 8 + len > b.length) return null;
    const chunk = b.slice(o, Math.min(end, b.length));
    if (type === "VP8 " && len >= 10) {
      width = le16(b, o + 14) & 0x3fff;
      height = le16(b, o + 16) & 0x3fff;
    } else if (type === "VP8L" && len >= 5) {
      const v = le32(b, o + 9);
      width = (v & 0x3fff) + 1;
      height = ((v >> 14) & 0x3fff) + 1;
    } else if (type === "VP8X" && len >= 10) {
      width = le24(b, o + 12) + 1;
      height = le24(b, o + 15) + 1;
      vp8x = chunk;
    }
    if (type !== "EXIF" && type !== "XMP ") chunks.push(chunk);
    o = end;
  }
  if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const size = body.length + 4;
  header[4] = size & 0xff;
  header[5] = (size >> 8) & 0xff;
  header[6] = (size >> 16) & 0xff;
  header[7] = (size >> 24) & 0xff;
  if (!width || !height) return null;
  return { width, height, out: concat([header, body]) };
}

const SUSPICIOUS = [/<script/i, /<svg/i, /<html/i, /<\?php/i];

export function validateImage(bytes: Uint8Array, maxBytes: number): ImageCheck {
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large", message: `Image is over ${Math.round(maxBytes / 1048576)} MB.` };
  const kind = sniff(bytes);
  if (kind === "heic")
    return { ok: false, reason: "heic", message: "HEIC photos aren't supported. On iPhone: Settings > Camera > Formats > Most Compatible, or share the photo as JPEG." };
  if (!kind) return { ok: false, reason: "unsupported_type", message: "Only JPEG, PNG, or WebP images are accepted." };
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (SUSPICIOUS.some((r) => r.test(head))) return { ok: false, reason: "suspicious", message: "That file doesn't look like a plain image." };
  const r = kind === "jpeg" ? processJpeg(bytes) : kind === "png" ? processPng(bytes) : processWebp(bytes);
  if (!r) return { ok: false, reason: "malformed", message: "The image couldn't be read." };
  if (r.width < 1 || r.height < 1 || r.width > MAX_DIMENSION || r.height > MAX_DIMENSION || r.width * r.height > MAX_PIXELS)
    return { ok: false, reason: "bad_dimensions", message: "Image dimensions are out of range." };
  return { ok: true, kind, contentType: CT[kind], width: r.width, height: r.height, bytes: r.out, stripped: r.out.length !== bytes.length };
}

/** Test/fixture helper: does the derivative still carry EXIF/XMP/text metadata markers? */
export function hasMetadata(b: Uint8Array): boolean {
  const s = new TextDecoder("latin1").decode(b);
  return /Exif\0\0|http:\/\/ns\.adobe\.com\/xap|eXIf|tEXt|iTXt|zTXt/.test(s) || /RIFF....WEBP[\s\S]*(EXIF|XMP )/.test(s);
}
