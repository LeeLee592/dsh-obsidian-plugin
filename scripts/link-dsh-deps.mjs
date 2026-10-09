// Link @deepseek-ai/* type packages from the installed DSH into this project's
// node_modules so `tsc` (build/typecheck) resolves the same types the runtime
// will load. The build emits lib/; these packages are peer deps resolved by DSH
// at runtime, and the plugin is loaded from the profile, so a local copy of an
// older version silently type-checks against an API that no longer exists.
//
// Source: the DSH installation that owns the `dsh` binary, because that is what
// loads the plugin. `<DSH_HOME>/profiles/node_modules/@deepseek-ai` is only a
// fallback (it is normally a symlink farm into that same installation).
//
// Run `pnpm install` first for typescript + @types/node.
import { mkdir, symlink, readdir, rm, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nmAt = join(root, "node_modules", "@deepseek-ai");
const dshHome = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE, ".dsh");

/** @deepseek-ai directory of the DSH installation that runs `dsh`, or undefined. */
async function fromInstalledDsh() {
  let bin;
  try {
    bin = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (!bin) return undefined;
  // <install>/lib/bin.js -> <install>/node_modules/@deepseek-ai
  const install = dirname(dirname(await realpath(bin)));
  const candidate = join(install, "node_modules", "@deepseek-ai");
  try {
    await readdir(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

const src = (await fromInstalledDsh()) ?? join(dshHome, "profiles", "node_modules", "@deepseek-ai");

let entries;
try {
  entries = await readdir(src);
} catch {
  console.error(
    `link-dsh-deps: no @deepseek-ai packages found at ${src}.\n` +
      "  Install/upgrade the dsh runtime first, or set DSH_HOME to a booted installation.",
  );
  process.exit(1);
}

await mkdir(dirname(nmAt), { recursive: true });
await rm(nmAt, { recursive: true, force: true });
await mkdir(nmAt, { recursive: true });

const versions = {};
let linked = 0;
for (const name of entries) {
  const from = join(src, name);
  await symlink(from, join(nmAt, name), "junction");
  linked++;
  try {
    versions[`@deepseek-ai/${name}`] = JSON.parse(await readFile(join(from, "package.json"), "utf8")).version;
  } catch {
    /* a directory without a readable manifest is not one of ours */
  }
}

// The whole point of this script is that types match the runtime. Report the
// versions it linked, and compare them with what package.json claims to support,
// so a stale local copy or an un-updated peer range is visible instead of silent.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const peers = { ...(pkg.peerDependencies ?? {}) };
console.log(`link-dsh-deps: linked ${linked} @deepseek-ai/* packages from ${src}`);
for (const name of ["cordis", "dsh-tools", "schemastery"]) {
  const key = `@deepseek-ai/${name}`;
  if (!versions[key]) continue;
  console.log(`  ${key.padEnd(26)} ${versions[key].padEnd(12)} peer: ${peers[key] ?? "(none declared)"}`);
}

const missing = Object.keys(peers).filter((p) => !(p in versions));
if (missing.length) {
  console.warn(`link-dsh-deps: declared peer(s) not present in this DSH: ${missing.join(", ")}`);
}

// semver itself comes from the DSH installation (it is a dsh dependency); this
// project does not depend on it, and pulling it in just for this check would add
// a devDependency the runtime never needs.
const { satisfies } = await import("semver").catch(() => {
  try {
    const install = dirname(dirname(src));
    return createRequire(join(install, "package.json"))("semver");
  } catch {
    return { satisfies: undefined };
  }
});
if (satisfies) {
  // Mirror the runtime guard (dsh-app-boot `evaluatePluginCompatibility`): it
  // only inspects `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, and it satisfies
  // with { includePrerelease: true } — without that flag a version like
  // 0.2.0-rc.2 fails even a matching range and the check would be wrong.
  const bad = Object.entries(versions).filter(([n, v]) => {
    if (n !== "@deepseek-ai/dsh" && !n.startsWith("@deepseek-ai/dsh-")) return false;
    const r = peers[n];
    return r && !satisfies(v, r, { includePrerelease: true });
  });
  if (bad.length) {
    console.error(
      "link-dsh-deps: the linked DSH version does NOT satisfy this plugin's peer range:\n" +
        bad.map(([n, v]) => `  ${n}: found ${v}, peer range ${peers[n]}`).join("\n") +
        "\n  Update package.json peerDependencies (and republish) before assuming compatibility.",
    );
    process.exit(1);
  }
} else {
  console.warn("link-dsh-deps: semver unavailable — skipped the peer-range check");
}
