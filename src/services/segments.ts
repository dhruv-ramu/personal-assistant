/**
 * SMS segment estimation (GSM 03.38 / 3GPP TS 23.038), matching Twilio's documented rules:
 *  - GSM-7: 160 septets single; 153 septets per part when concatenated (UDH overhead).
 *    Basic-table characters cost 1 septet; extension-table characters ( ^ { } \ [ ~ ] | € and
 *    form feed) cost 2 (escape + char) and are never split across parts.
 *  - Otherwise UCS-2: 70 UTF-16 code units single; 67 per part; surrogate pairs are not split.
 */

const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

const BASIC = new Set([...GSM_BASIC]);
const EXTENDED = new Set([...GSM_EXTENDED]);

export interface SegmentInfo {
  encoding: "GSM-7" | "UCS-2";
  segments: number;
  units: number; // septets (GSM-7) or UTF-16 code units (UCS-2)
}

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!BASIC.has(ch) && !EXTENDED.has(ch)) return false;
  return true;
}

export function countSegments(text: string): SegmentInfo {
  if (text.length === 0) return { encoding: "GSM-7", segments: 1, units: 0 };
  if (isGsm7(text)) {
    const costs = [...text].map((ch) => (EXTENDED.has(ch) ? 2 : 1));
    const total = costs.reduce((a, b) => a + b, 0);
    if (total <= 160) return { encoding: "GSM-7", segments: 1, units: total };
    let segments = 1;
    let used = 0;
    for (const c of costs) {
      if (used + c > 153) {
        segments++;
        used = 0;
      }
      used += c;
    }
    return { encoding: "GSM-7", segments, units: total };
  }
  const units = text.length;
  if (units <= 70) return { encoding: "UCS-2", segments: 1, units };
  let segments = 1;
  let used = 0;
  for (const ch of text) {
    const c = ch.length; // 2 for astral (surrogate pair) characters
    if (used + c > 67) {
      segments++;
      used = 0;
    }
    used += c;
  }
  return { encoding: "UCS-2", segments, units };
}

/** Replaces common typographic characters that would silently force UCS-2 in routine templates. */
export function asciiFriendly(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}
