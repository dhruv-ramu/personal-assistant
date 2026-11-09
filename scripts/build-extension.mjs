#!/usr/bin/env node
// Builds the Della companion WebExtension for Firefox (primary) and Chromium.
// Output: dist-extension/firefox/ and dist-extension/chrome/ (load unpacked / about:debugging).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension", "src");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = String(pkg.version ?? "0.1.0").replace(/[^0-9.]/g, "") || "0.1.0";

// Least privilege: no tabs/history/webRequest/scripting/cookies, no host permissions.
// Cross-origin calls rely on the server's credential-less CORS for /api/device/*.
const PERMISSIONS = ["storage", "alarms", "notifications", "idle"];

const base = {
  manifest_version: 3,
  name: "Della companion",
  version,
  description: "Optional check-ins for Della accountability sessions. Reads no tabs, pages, URLs, or history.",
  permissions: PERMISSIONS,
  action: { default_popup: "popup.html", default_title: "Della companion" },
  icons: { 48: "icon.png" },
};

const manifests = {
  firefox: {
    ...base,
    // Firefox MV3 runs background scripts (event pages), not service workers.
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "della-companion@della.local", strict_min_version: "128.0" } },
  },
  chrome: {
    ...base,
    background: { service_worker: "background.js" },
    minimum_chrome_version: "120",
  },
};

function crc32(buf) {
  let c;
  const table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A plain 48x48 PNG (dark teal square with a light "D" bar) so notifications have an icon. */
function icon() {
  const size = 48;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const inD = x >= 14 && x <= 34 && y >= 10 && y <= 38 && (x <= 18 || y <= 14 || y >= 34 || x >= 30);
      row.push(...(inD ? [240, 240, 240, 255] : [22, 94, 99, 255]));
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [target, manifest] of Object.entries(manifests)) {
  const out = join(root, "dist-extension", target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, "icon.png"), icon());
  console.log(`built ${target}: ${out}`);
}
