// The filesystem seam.
//
// `ctx.fs` is injected by the harness (sandboxed, observable). It is optional
// so bare-Node tests can run without a harness; in that case we fall back to
// node:fs.
//
// Three rules from live verification and from the harness contract:
//
//   * `ctx.fs.resolve(path)` bases relative paths on `process.cwd()` (the DSH
//     host's start directory), NOT the session workspace. Every relative path
//     must therefore be resolved against an explicit `cwd`.
//   * There are two distinct path identities. The backend's `FsTarget` is an
//     opaque key used for reads and for sandboxed writes; the absolute OS path
//     is what subprocesses (esbuild, the Obsidian CLI) can open. Mixing them
//     silently breaks sandbox fencing, so this file keeps them apart.
//   * Every mutating call must carry the calling session's sandbox policy, so
//     the sandbox backend fences against the session workspace rather than the
//     process-wide fallback root.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface FsCall {
  workspaceRoot?: string;
  policy?: any;
  signal?: AbortSignal;
}

export class Fs {
  constructor(private fs?: any) {}

  /** A file location in both identities: OS path for spawns, target for I/O. */
  private async locate(path: string, workspaceRoot?: string): Promise<{ path: string; target: any }> {
    if (this.fs) {
      const target = await this.fs.resolve(path, workspaceRoot === undefined ? undefined : { cwd: workspaceRoot });
      let abs = target.displayPath;
      if (typeof this.fs.processPath === "function") {
        try {
          abs = this.fs.processPath(target);
        } catch {
          /* keep displayPath */
        }
      }
      return { path: abs, target };
    }
    const abs = isAbsolute(path) ? path : resolve(workspaceRoot ?? process.cwd(), path);
    return { path: abs, target: undefined };
  }

  /** Absolute OS path — pass this to subprocesses, never to ctx.fs reads/writes. */
  async resolve(path: string, workspaceRoot?: string): Promise<string> {
    return (await this.locate(path, workspaceRoot)).path;
  }

  async exists(path: string, workspaceRoot?: string): Promise<boolean> {
    if (this.fs) {
      try {
        const { target } = await this.locate(path, workspaceRoot);
        return (await this.fs.stat(target)) !== undefined;
      } catch {
        return false;
      }
    }
    return existsSync(await this.resolve(path, workspaceRoot));
  }

  async isDirectory(path: string, workspaceRoot?: string): Promise<boolean> {
    if (this.fs) {
      try {
        const { target } = await this.locate(path, workspaceRoot);
        const info = await this.fs.stat(target);
        return Boolean(info?.isDirectory ?? info?.type === "directory");
      } catch {
        return false;
      }
    }
    try {
      return (await stat(await this.resolve(path, workspaceRoot))).isDirectory();
    } catch {
      return false;
    }
  }

  async readText(path: string, workspaceRoot?: string): Promise<string> {
    if (this.fs) {
      const { target } = await this.locate(path, workspaceRoot);
      return await this.fs.readText(target);
    }
    return readFile(await this.resolve(path, workspaceRoot), "utf8");
  }

  async readJson(path: string, workspaceRoot?: string): Promise<any | null> {
    try {
      return JSON.parse(await this.readText(path, workspaceRoot));
    } catch {
      return null;
    }
  }

  async writeText(
    path: string,
    content: string,
    policy?: any,
    signal?: AbortSignal,
    workspaceRoot?: string,
  ): Promise<void> {
    if (this.fs) {
      const { target } = await this.locate(path, workspaceRoot);
      await this.fs.writeText(target, content, undefined, signal, policy);
      return;
    }
    const abs = await this.resolve(path, workspaceRoot);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async listDir(path: string, workspaceRoot?: string): Promise<string[]> {
    if (this.fs) {
      try {
        const { target } = await this.locate(path, workspaceRoot);
        const entries = await this.fs.listDir(target);
        return entries.map((e: any) => String(e.name ?? e.path ?? e));
      } catch {
        return [];
      }
    }
    try {
      return await readdir(await this.resolve(path, workspaceRoot));
    } catch {
      return [];
    }
  }
}

/** Read a package asset (templates, bundled docs) relative to the built lib/. */
export function readAsset(relativeToLib: string): string {
  const url = new URL(relativeToLib, import.meta.url);
  return readFileSync(url, "utf8").replace(/^\uFEFF/, "");
}

export { join };
