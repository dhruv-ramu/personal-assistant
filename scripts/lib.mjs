// Shared helpers for operational scripts (Node, no dependencies beyond the repo).
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Minimal JSONC parser: strips // and /* comments outside strings, and trailing commas. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readWranglerConfig() {
  return parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
}

export function parseDevVars(path = new URL("../.dev.vars", import.meta.url)) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(" ")} exited with ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r;
}

export const ok = (msg) => console.log(`  ✓ ${msg}`);
export const warn = (msg) => console.log(`  ! ${msg}`);
export const bad = (msg) => console.log(`  ✖ ${msg}`);
