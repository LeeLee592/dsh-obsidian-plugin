// Verify that a plugin is actually composed into a DSH profile.
//
// Reads `dsh --profile <name> --dump-config` output on stdin and decides whether
// the plugin will really load. Two separate facts, checked separately:
//
//  1. the composed tree has a row for the entry (`- id: <entry>`), not merely the
//     package name — the name also appears in the profile's bundles list, which
//     alone proves nothing;
//  2. the runtime did not skip it. An incompatible peer range makes dsh print
//     `skipping profile bundle "<pkg>": … is incompatible with dsh <version>`,
//     and that message CONTAINS the package name. A check that greps for the
//     name therefore reports success for a plugin that never loads — which is
//     exactly how a plugin can look deployed for weeks while being skipped.
//
// Usage: dsh --profile <p> --dump-config 2>&1 | node scripts/verify-composed.mjs <entryId> [packageName]
import { readFileSync } from "node:fs";

const [entryId, packageName] = process.argv.slice(2);
if (!entryId) {
  console.error("verify-composed: usage: … | node scripts/verify-composed.mjs <entryId> [packageName]");
  process.exit(2);
}

let dump = "";
try {
  dump = readFileSync(0, "utf8");
} catch {
  dump = "";
}
const lines = dump.split("\n");

const row = new RegExp(`^\\s*-\\s+id:\\s*${entryId}\\s*$`);
const hasRow = lines.some((l) => row.test(l));

const identity = packageName ?? entryId;
const skipLines = lines.filter(
  (l) => l.includes("skipping profile bundle") && l.includes(identity),
);
const incompatible = skipLines.length > 0 || /incompatible with dsh/i.test(dump);

if (!hasRow) {
  console.error(`deploy: FAIL — no composed row for '${entryId}'.`);
  for (const l of lines.filter((x) => /skipping|error/i.test(x)).slice(0, 5)) console.error(`  ${l.trim()}`);
  process.exit(1);
}

if (incompatible) {
  console.error(`deploy: FAIL — '${entryId}' is composed but the runtime SKIPPED it.`);
  for (const l of skipLines.slice(0, 3)) console.error(`  ${l.trim()}`);
  console.error("  Fix the peerDependencies range in package.json, then re-run.");
  process.exit(1);
}

console.log(`deploy: OK — '${entryId}' composed with no compatibility warning`);
