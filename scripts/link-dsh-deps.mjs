// Link @deepseek-ai/* type packages from the local DSH profile into this
// project's node_modules so `tsc` (build/typecheck) can resolve them. The
// build emits lib/; these packages are peer deps resolved by DSH at runtime.
//
// Source: <DSH_HOME>/profiles/node_modules/@deepseek-ai (present once a
// profile has been booted). Run `npm install` first for typescript + @types/node.
import { mkdir, symlink, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nmAt = join(root, "node_modules", "@deepseek-ai");
const dshHome = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE, ".dsh");
const src = join(dshHome, "profiles", "node_modules", "@deepseek-ai");

let entries;
try {
  entries = await readdir(src);
} catch {
  console.error(`link-dsh-deps: @deepseek-ai not found at ${src} (boot a profile first)`);
  process.exit(1);
}

await mkdir(dirname(nmAt), { recursive: true });
await rm(nmAt, { recursive: true, force: true });
await mkdir(nmAt, { recursive: true });

let linked = 0;
for (const name of entries) {
  await symlink(join(src, name), join(nmAt, name), "junction");
  linked++;
}
console.log(`link-dsh-deps: linked ${linked} @deepseek-ai/* packages from ${src}`);
