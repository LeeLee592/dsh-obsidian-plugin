// Read external doc resources (manual / HARNESS context / version notes) that
// ship alongside lib/ in the package's doc/ directory. Falls back on failure so
// missing or corrupt docs never break tool registration.
import { readFileSync } from "node:fs";

export function readBundleDoc(fileName: string, fallback: string): string {
  try {
    const url = new URL(`../doc/${fileName}`, import.meta.url);
    return readFileSync(url, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return fallback;
  }
}
