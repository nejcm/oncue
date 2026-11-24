import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnCueError } from "../src/errors.ts";
import { decode } from "../src/sys.ts";
import type { Env, ExecResult, Sys } from "../src/types.ts";

export const fakeEnv: Env = {
  platform: "linux",
  home: "/home/u",
  uid: 501,
  localAppData: "C:\\Users\\u\\AppData\\Local",
  user: "PC\\u",
};

type Call = { op: "write" | "remove" | "exec"; arg: string; mutates: boolean };

/** The code of the OnCueError `f` throws, the error itself if it is another kind, undefined if nothing throws. */
export function code(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e instanceof OnCueError ? e.code : e;
  }
}

/** In-memory Sys: files in a map, exec answered from `canned` (keyed by argv joined with spaces, errors thrown), default exit 0. */
export function fakeSys(
  files: Record<string, string> = {},
  canned: Record<string, Partial<ExecResult> | OnCueError> = {},
) {
  const fs = new Map(Object.entries(files));
  const calls: Call[] = [];
  const sys: Sys = {
    read: (p) => fs.get(p),
    readdir: (d) => [
      ...new Set(
        [...fs.keys()]
          .filter((p) => p.startsWith(`${d}/`) || p.startsWith(`${d}\\`))
          .map((p) => p.slice(d.length + 1).split(/[\\/]/)[0]!),
      ),
    ],
    write(p, data) {
      calls.push({ op: "write", arg: p, mutates: true });
      fs.set(p, decode(data));
    },
    remove(p) {
      calls.push({ op: "remove", arg: p, mutates: true });
      fs.delete(p);
    },
    exec(argv, o) {
      const key = argv.join(" ");
      calls.push({ op: "exec", arg: key, mutates: o.mutates });
      const c = canned[key];
      if (c instanceof OnCueError) throw c;
      const r = { code: 0, out: "", err: "", ...c };
      if (!(o.ok ?? [0]).includes(r.code)) throw new OnCueError("COMMAND_FAILED", `${key} exited ${r.code}`);
      return r;
    },
  };
  return { sys, fs, calls, mutations: () => calls.filter((c) => c.mutates).map((c) => `${c.op} ${c.arg}`) };
}

/** Runs `f` with PATH set to a fresh directory holding an executable `tool`; returns that directory. */
export function withTool(tool: string, f: () => void): string {
  const dir = mkdtempSync(join(tmpdir(), "oncue-tool-"));
  const PATH = process.env.PATH;
  writeFileSync(join(dir, tool), "");
  chmodSync(join(dir, tool), 0o755);
  process.env.PATH = dir;
  try {
    f();
  } finally {
    process.env.PATH = PATH;
    rmSync(dir, { recursive: true, force: true });
  }
  return dir;
}
