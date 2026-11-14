"use strict";
// SRC-06 version audit: package.json is the single source of truth.
// Every other place a release version is pinned must match it, or be
// listed in HISTORY_OK (files that legitimately mention older versions
// as history: CHANGELOG, deep dives, EVIDENCE). Run before every
// release; exit 1 on drift. Born from the 2.9.2 round, where the local
// tree stayed at 2.9.1 while five surfaces shipped 2.9.2 and three
// downstream copies (listings skill, repo-push skill, MCP wrapper pin)
// silently stayed behind.
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const workspace = join(root, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const V = pkg.version;

// [path, extractor] - extractor returns the pinned version string or null.
const jsonField = (field) => (text) => {
  try { const j = JSON.parse(text); return j[field] ?? null; } catch { return null; }
};
const checks = [
  ["package-lock.json", jsonField("version")],
  [".cursor-plugin/plugin.json", jsonField("version")],
  ["CITATION.cff", (t) => (t.match(/^version:\s*"?(\d+\.\d+\.\d+)"/m) || [])[1] ?? null],
  ["codemeta.json", jsonField("version")],
  // Downstream copies outside the repo (same workspace).
  ["../antirea-listings/skill/SKILL.md", (t) => (t.match(/version:\s*"(\d+\.\d+\.\d+)"/) || [])[1] ?? null],
  ["../antirea-listings/jsr/jsr.json", jsonField("version")],
];

let drift = 0;
for (const [rel, extract] of checks) {
  const path = join(root, rel);
  if (!existsSync(path)) { console.log(`SKIP  ${rel} (absent)`); continue; }
  const found = extract(readFileSync(path, "utf8"));
  if (found === V) console.log(`OK    ${rel} = ${found}`);
  else { console.log(`DRIFT ${rel} = ${found} (expected ${V})`); drift++; }
}

// The MCP wrapper pins the SDK in its package.json dependencies (read
// at runtime as SDK_VERSION). A mismatch is a REPORT, not auto-drift:
// bumping it without rebuilding and re-testing the wrapper would be a
// false claim, so the audit only surfaces it.
const wrapperPkg = join(workspace, "antirea-listings", "mcp-wrapper", "package.json");
if (existsSync(wrapperPkg)) {
  const dep = JSON.parse(readFileSync(wrapperPkg, "utf8")).dependencies?.["@dannyphan190/anti-rea"];
  if (dep && dep !== V) console.log(`NOTE  MCP wrapper pins SDK ${dep} (SDK now ${V}) - rebuild and re-test the wrapper to move this pin, never edit the string alone`);
}

if (drift > 0) { console.log(`\nversion-audit: ${drift} drifted surface(s)`); process.exit(1); }
console.log(`\nversion-audit: all pinned surfaces at ${V}`);
